import assert from "node:assert/strict";
import test from "node:test";
import * as api from "../dist/index.js";

const event = (kind, sequence, extra = {}) => ({ kind, runId: "job", sourceId: "core", sequence, observedAt: "2026-11-13T00:00:00Z", ...extra });
const fold = (events) => events.reduce(api.reduceAgentRunEvidence, api.createAgentRunState("job", "native-job"));
const started = [event("host-started", 0, { hostRef: "terminal-not-session" })];
const output = event("job-output-captured", 1, { output: "Native response" });
const exit = (code = 0, signal = null) => event("process-exited", 2, { exit: { kind: "native", code, signal } });

test("natural native job completion requires output plus zero exit, never Pi settlement or task success", () => {
  const state = fold([...started, output, exit()]);
  const completion = api.projectAgentRunCompletion(state, { output: "must not replace captured output" });
  assert.equal(completion.execution, "normal-exit");
  assert.equal(completion.output, "Native response");
  assert.equal(completion.settled, false);
  assert.equal(completion.completionEvidence, "native-job-exit-output");
  assert.equal(completion.taskOutcome, "unknown");
  assert.equal(completion.sessionRef, undefined);
  assert.equal(api.copilotJobCapabilities.session, "persistent");
  assert.equal(api.copilotJobCapabilities.process, "ephemeral");
  assert.equal(api.copilotJobCapabilities.completion, "natural-exit-output");
  assert.throws(() => api.requireCapability(api.copilotJobCapabilities, "fork"));
  assert.equal(api.copilotJobCapabilities.interaction, "none");
});

test("missing output, nonzero, signal and unavailable exit cannot certify native completion", () => {
  for (const events of [[...started, exit()], [...started, output, exit(1)], [...started, output, exit(null, "SIGTERM")], [...started, output, event("process-exited", 2, { exit: { kind: "process-not-found" } })]]) {
    assert.equal(api.projectAgentRunStatus(fold(events)).disposition, "abnormal-exit");
  }
  assert.equal(api.projectAgentRunCompletion(fold([...started, { ...output, output: "" }, exit()]), { output: "" }).execution, "normal-exit");
});

test("request timeout and ambiguous launch remain nonterminal; cancel/deadline preserve cause", () => {
  const launch = event("launch-requested", 0, { intent: {} });
  for (const failure of [event("request-timeout", 1, { operation: "launch", timeoutMs: 1000 }), event("transport-failed", 1, { message: "dispatch ambiguous" })]) {
    assert.equal(api.projectAgentRunCompletion(fold([launch, failure]), { output: "" }), undefined);
  }
  for (const [control, expected] of [[event("interrupt-requested", 1, { mode: "process-abort" }), "aborted"], [event("terminate-requested", 1, { mode: "core-terminal-kill" }), "terminated"], [event("timeout-fired", 1, { timeoutMs: 1000 }), "timed-out"]]) {
    assert.equal(api.projectAgentRunCompletion(fold([...started, control, exit()]), { output: "" }).execution, expected);
  }
});

test("wrong-run/stale output and fabricated Pi settlement do not complete native jobs", () => {
  const state = fold([...started, { ...output, runId: "wrong" }, event("agent-settled", 1), { ...output, sequence: 0 }, exit()]);
  assert.equal(api.projectAgentRunStatus(state).disposition, "abnormal-exit");
  assert.equal(state.execution.status, "active");
  const pi = [event("host-started", 0, { hostRef: "pi" }), output, exit()].reduce(api.reduceAgentRunEvidence, api.createAgentRunState("job"));
  assert.equal(api.projectAgentRunStatus(pi).disposition, "abnormal-exit");
});
