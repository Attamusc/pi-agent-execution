import assert from "node:assert/strict";
import test from "node:test";

import {
  createAgentRunState,
  projectAgentRunCompletion,
  projectAgentRunStatus,
  reduceAgentRunEvidence,
} from "../dist/index.js";

const runId = "run-1";

function evidence(kind, data = {}, overrides = {}) {
  return {
    kind,
    runId,
    sourceId: "child",
    sequence: 1,
    observedAt: "2026-09-09T20:00:00.000Z",
    ...data,
    ...overrides,
  };
}

function reduceAll(records, state = createAgentRunState(runId)) {
  return records.reduce(reduceAgentRunEvidence, state);
}

const lifecycleCases = [
  {
    name: "done without settlement is non-terminal finishing",
    records: [evidence("completion-requested", { reason: "done" })],
    expected: { status: "finishing", terminal: false, disposition: "pending" },
  },
  {
    name: "settled without completion intent remains waiting-capable",
    records: [evidence("agent-settled")],
    expected: { status: "waiting", terminal: false, disposition: "pending" },
  },
  {
    name: "graceful completion requires intent, settlement, shutdown, and zero exit",
    records: [
      evidence("completion-requested", { reason: "done" }, { sequence: 1 }),
      evidence("agent-settled", {}, { sequence: 2 }),
      evidence("session-shutdown", { reason: "quit" }, { sequence: 3 }),
      evidence("process-exited", { code: 0, signal: null }, { sourceId: "wrapper" }),
    ],
    expected: { status: "completed", terminal: true, disposition: "completed" },
  },
  {
    name: "zero exit without completion intent is abnormal",
    records: [evidence("process-exited", { code: 0, signal: null })],
    expected: { status: "abnormal", terminal: true, disposition: "abnormal-exit" },
  },
  {
    name: "nonzero exit with completion intent is abnormal",
    records: [
      evidence("completion-requested", { reason: "done" }, { sequence: 1 }),
      evidence("agent-settled", {}, { sequence: 2 }),
      evidence("process-exited", { code: 7, signal: null }, { sequence: 3 }),
    ],
    expected: { status: "abnormal", terminal: true, disposition: "abnormal-exit" },
  },
  {
    name: "signal exit with completion intent is abnormal",
    records: [
      evidence("completion-requested", { reason: "done" }, { sequence: 1 }),
      evidence("agent-settled", {}, { sequence: 2 }),
      evidence("process-exited", { code: null, signal: "SIGKILL" }, { sequence: 3 }),
    ],
    expected: { status: "abnormal", terminal: true, disposition: "abnormal-exit" },
  },
  {
    name: "timeout is distinct",
    records: [evidence("timeout-fired", { timeoutMs: 1000 })],
    expected: { status: "timed-out", terminal: false, disposition: "timed-out" },
  },
  {
    name: "process abort is distinct",
    records: [evidence("interrupt-requested", { mode: "process-abort" })],
    expected: { status: "aborted", terminal: false, disposition: "aborted" },
  },
  {
    name: "turn escape is a non-terminal interruption",
    records: [evidence("interrupt-requested", { mode: "turn-escape" })],
    expected: { status: "interrupted", terminal: false, disposition: "interrupted" },
  },
  {
    name: "hard termination is distinct",
    records: [evidence("terminate-requested", { mode: "herdr-pane-close" })],
    expected: { status: "terminated", terminal: false, disposition: "terminated" },
  },
  {
    name: "provider completion errors are failures",
    records: [evidence("completion-requested", { reason: "agent-error" })],
    expected: { status: "failed", terminal: false, disposition: "agent-error" },
  },
  {
    name: "transport failures are failures",
    records: [evidence("transport-failed", { message: "stream broke" })],
    expected: { status: "failed", terminal: true, disposition: "transport-failed" },
  },
];

for (const { name, records, expected } of lifecycleCases) {
  test(name, () => {
    const projected = projectAgentRunStatus(reduceAll(records));
    assert.deepEqual(
      { status: projected.status, terminal: projected.terminal, disposition: projected.disposition },
      expected,
    );
    assert.equal(projected.taskOutcome, "unknown");
  });
}

test("retrying agent_end does not assert settlement", () => {
  const state = reduceAll([evidence("agent-ended", { willRetry: true })]);
  assert.equal(state.execution.status, "active");
  assert.equal(projectAgentRunStatus(state).status, "running");
});

test("later progress resumes a settled waiting run and clears turn-only interruption", () => {
  const state = reduceAll([
    evidence("agent-settled", {}, { sequence: 1 }),
    evidence("interrupt-requested", { mode: "turn-escape" }, { sequence: 2 }),
    evidence("progress", { activity: "resumed", estimated: false }, { sequence: 3 }),
  ]);
  assert.equal(state.execution.status, "active");
  assert.equal(state.control.status, "none");
  assert.equal(projectAgentRunStatus(state).status, "running");
});

test("cross-source ordering uses source-local sequences rather than timestamps", () => {
  const state = reduceAll([
    evidence("host-started", { hostRef: "pane-1" }, { sourceId: "host", sequence: 10, observedAt: "2026-09-09T20:10:00.000Z" }),
    evidence("completion-requested", { reason: "done" }, { sourceId: "child", sequence: 1, observedAt: "2026-09-09T20:00:00.000Z" }),
    evidence("agent-settled", {}, { sourceId: "child", sequence: 2, observedAt: "2026-09-09T19:00:00.000Z" }),
  ]);
  assert.equal(state.completionIntent?.reason, "done");
  assert.equal(state.execution.status, "settled");
  assert.deepEqual(state.lastSequenceBySource, { host: 10, child: 2 });
});

test("wrong-run, stale, and malformed source sequences are ignored without mutation", () => {
  const initial = reduceAgentRunEvidence(
    createAgentRunState(runId),
    evidence("host-started", { hostRef: "pane-1" }, { sequence: 2 }),
  );
  const wrongRun = reduceAgentRunEvidence(initial, evidence("timeout-fired", { timeoutMs: 1 }, { runId: "run-2", sequence: 99 }));
  const stale = reduceAgentRunEvidence(initial, evidence("timeout-fired", { timeoutMs: 1 }, { sequence: 2 }));
  const malformed = reduceAgentRunEvidence(initial, evidence("timeout-fired", { timeoutMs: 1 }, { sequence: Number.NaN }));
  assert.equal(wrongRun, initial);
  assert.equal(stale, initial);
  assert.equal(malformed, initial);
});

test("late launch evidence cannot resurrect an exited process or closed session", () => {
  const state = reduceAll([
    evidence("host-started", { hostRef: "pane-1" }, { sourceId: "parent", sequence: 1 }),
    evidence("session-shutdown", { reason: "quit" }, { sourceId: "child", sequence: 1 }),
    evidence("process-exited", { code: 0, signal: null }, { sourceId: "wrapper", sequence: 1 }),
    evidence("host-started", { hostRef: "pane-late" }, { sourceId: "parent", sequence: 2 }),
    evidence("launch-requested", { intent: {} }, { sourceId: "launcher", sequence: 1 }),
  ]);
  assert.equal(state.process.status, "exited");
  assert.equal(state.session.status, "closed");
  assert.equal(state.execution.status, "active");
  assert.equal(projectAgentRunStatus(state).terminal, true);
});

test("late host-started evidence does not override newer execution settlement", () => {
  const state = reduceAll([
    evidence("agent-settled", {}, { sourceId: "child", sequence: 1 }),
    evidence("host-started", { hostRef: "pane-late" }, { sourceId: "parent", sequence: 1 }),
  ]);
  assert.equal(state.execution.status, "settled");
  assert.equal(projectAgentRunStatus(state).status, "waiting");
});

test("transport failure is terminal only when no process has started", () => {
  const beforeStart = reduceAll([evidence("transport-failed", { message: "spawn failed" })]);
  assert.deepEqual(projectAgentRunStatus(beforeStart), {
    status: "failed",
    disposition: "transport-failed",
    terminal: true,
    taskOutcome: "unknown",
  });

  const whileRunning = reduceAll([
    evidence("host-started", { hostRef: "pane-1" }, { sequence: 1 }),
    evidence("transport-failed", { message: "observation lost" }, { sequence: 2 }),
  ]);
  assert.equal(whileRunning.process.status, "running");
  assert.deepEqual(projectAgentRunStatus(whileRunning), {
    status: "failed",
    disposition: "transport-failed",
    terminal: false,
    taskOutcome: "unknown",
  });
});

test("the first process-ending control cause determines disposition", () => {
  const cases = [
    {
      records: [
        evidence("terminate-requested", { mode: "process-signal" }, { sequence: 1 }),
        evidence("timeout-fired", { timeoutMs: 1000 }, { sequence: 2 }),
      ],
      disposition: "terminated",
    },
    {
      records: [
        evidence("timeout-fired", { timeoutMs: 1000 }, { sequence: 1 }),
        evidence("terminate-requested", { mode: "process-signal" }, { sequence: 2 }),
      ],
      disposition: "timed-out",
    },
    {
      records: [
        evidence("interrupt-requested", { mode: "process-abort" }, { sequence: 1 }),
        evidence("timeout-fired", { timeoutMs: 1000 }, { sequence: 2 }),
      ],
      disposition: "aborted",
    },
  ];

  for (const { records, disposition } of cases) {
    assert.equal(projectAgentRunStatus(reduceAll(records)).disposition, disposition);
  }
});

test("a timeout outranks later agent and transport errors without erasing them", () => {
  const afterAgentError = reduceAll([
    evidence("timeout-fired", { timeoutMs: 1000 }, { sequence: 1 }),
    evidence("completion-requested", { reason: "agent-error" }, { sequence: 2 }),
    evidence("process-exited", { code: null, signal: "SIGKILL" }, { sequence: 3 }),
  ]);
  assert.equal(afterAgentError.completionIntent?.reason, "agent-error");
  assert.equal(projectAgentRunCompletion(afterAgentError, { output: "" }).execution, "timed-out");

  const afterTransportError = reduceAll([
    evidence("timeout-fired", { timeoutMs: 1000 }, { sequence: 1 }),
    evidence("transport-failed", { message: "stream closed during shutdown" }, { sequence: 2 }),
    evidence("process-exited", { code: null, signal: "SIGKILL" }, { sequence: 3 }),
  ]);
  assert.equal(afterTransportError.transportFailure?.message, "stream closed during shutdown");
  assert.equal(projectAgentRunStatus(afterTransportError).disposition, "timed-out");
  assert.equal(projectAgentRunCompletion(afterTransportError, { output: "" }).execution, "timed-out");
});

test("normal evidence cannot override a recorded timeout", () => {
  const state = reduceAll([
    evidence("timeout-fired", { timeoutMs: 1000 }, { sequence: 1 }),
    evidence("completion-requested", { reason: "done" }, { sequence: 2 }),
    evidence("agent-settled", {}, { sequence: 3 }),
    evidence("process-exited", { code: 0, signal: null }, { sequence: 4 }),
  ]);
  const projected = projectAgentRunStatus(state);
  assert.equal(projected.disposition, "timed-out");
  assert.equal(projected.terminal, true);
});

test("normal intent and turn escape cannot override recorded failures or termination", () => {
  const failed = reduceAll([
    evidence("completion-requested", { reason: "agent-error" }, { sequence: 1 }),
    evidence("completion-requested", { reason: "done" }, { sequence: 2 }),
  ]);
  assert.equal(projectAgentRunStatus(failed).disposition, "agent-error");

  const terminated = reduceAll([
    evidence("terminate-requested", { mode: "herdr-pane-close" }, { sequence: 1 }),
    evidence("interrupt-requested", { mode: "turn-escape" }, { sequence: 2 }),
  ]);
  assert.equal(projectAgentRunStatus(terminated).disposition, "terminated");
});

test("projects immutable normalized completion evidence only from terminal state", () => {
  const pending = reduceAll([evidence("completion-requested", { reason: "done" })]);
  assert.equal(projectAgentRunCompletion(pending, { output: "premature" }), undefined);

  const completed = reduceAll([
    evidence("host-started", { hostRef: "pane-1" }, { sequence: 1 }),
    evidence("completion-requested", { reason: "done" }, { sequence: 2 }),
    evidence("agent-settled", {}, { sequence: 3 }),
    evidence("process-exited", { code: 0, signal: null }, { sequence: 4 }),
  ]);
  const completion = projectAgentRunCompletion(completed, {
    output: "finished",
    sessionRef: "/sessions/pi-session.jsonl",
    usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14, costUsd: 0.01 },
  });

  assert.deepEqual(completion, {
    runId,
    execution: "normal-exit",
    output: "finished",
    taskOutcome: "unknown",
    settled: true,
    processExit: { code: 0, signal: null },
    sessionRef: "/sessions/pi-session.jsonl",
    usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14, costUsd: 0.01 },
  });
  assert.equal(Object.isFrozen(completion), true);
  assert.equal(Object.isFrozen(completion.usage), true);
});

test("host references are not inferred to be persistent Pi session references", () => {
  const state = reduceAll([
    evidence("host-started", { hostRef: "pane-1" }, { sequence: 1 }),
    evidence("process-exited", { code: 1, signal: null }, { sequence: 2 }),
  ]);

  const inferred = projectAgentRunCompletion(state, { output: "" });
  assert.equal(Object.hasOwn(inferred, "sessionRef"), false);
  assert.equal(projectAgentRunCompletion(state, { output: "", sessionRef: "/sessions/actual.jsonl" }).sessionRef, "/sessions/actual.jsonl");
});

test("bare abnormal exits become explanatory transport failures", () => {
  const cases = [
    [{ code: 7, signal: null }, "Process exited with code 7 without a graceful completion handshake"],
    [{ code: null, signal: "SIGKILL" }, "Process exited from signal SIGKILL without a graceful completion handshake"],
    [{ code: 0, signal: null }, "Process exited with code 0 without a graceful completion handshake"],
  ];

  for (const [processExit, errorMessage] of cases) {
    const completion = projectAgentRunCompletion(
      reduceAll([evidence("process-exited", processExit)]),
      { output: "" },
    );
    assert.equal(completion.execution, "transport-failure");
    assert.deepEqual(completion.processExit, processExit);
    assert.equal(completion.errorMessage, errorMessage);
  }
});

test("completion projection preserves each terminal execution disposition", () => {
  const cases = [
    [
      [evidence("completion-requested", { reason: "agent-error" }, { sequence: 1 }), evidence("process-exited", { code: 1, signal: null }, { sequence: 2 })],
      { execution: "agent-error", errorMessage: "provider failed" },
    ],
    [[evidence("interrupt-requested", { mode: "process-abort" }, { sequence: 1 }), evidence("process-exited", { code: null, signal: "SIGTERM" }, { sequence: 2 })], { execution: "aborted" }],
    [[evidence("timeout-fired", { timeoutMs: 10 }, { sequence: 1 }), evidence("process-exited", { code: null, signal: "SIGKILL" }, { sequence: 2 })], { execution: "timed-out" }],
    [[evidence("terminate-requested", { mode: "process-signal" }, { sequence: 1 }), evidence("process-exited", { code: null, signal: "SIGTERM" }, { sequence: 2 })], { execution: "terminated" }],
    [[evidence("transport-failed", { message: "stream broke" })], { execution: "transport-failure", errorMessage: "stream broke" }],
  ];

  for (const [records, expected] of cases) {
    const completion = projectAgentRunCompletion(reduceAll(records), {
      output: "",
      ...(expected.errorMessage ? { errorMessage: expected.errorMessage } : {}),
    });
    assert.equal(completion.execution, expected.execution);
    assert.equal(completion.errorMessage, expected.errorMessage);
    assert.equal(completion.taskOutcome, "unknown");
  }
});

test("state and nested axes are immutable", () => {
  const state = reduceAll([evidence("process-exited", { code: 0, signal: null })]);
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.process), true);
  assert.equal(Object.isFrozen(state.lastSequenceBySource), true);
});
