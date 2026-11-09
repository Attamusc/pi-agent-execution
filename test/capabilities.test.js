import assert from "node:assert/strict";
import test from "node:test";
import * as execution from "../dist/index.js";

import {
  UnsupportedAgentRunCapability,
  requireCapability,
  visibleHerdrCapabilities,
  workflowHeadlessCapabilities,
} from "../dist/index.js";

test("headless workflow capabilities expose exact host modes", () => {
  assert.deepEqual(workflowHeadlessCapabilities, {
    session: "ephemeral",
    progress: "pi-json-events",
    interrupt: "process-abort",
    termination: "process-signal",
    timeout: "process-deadline",
    resume: "unsupported",
    fork: "unsupported",
    interaction: "none",
  });
  assert.equal(requireCapability(workflowHeadlessCapabilities, "interrupt"), "process-abort");
});

test("visible Herdr capabilities expose persistent session operations explicitly", () => {
  assert.deepEqual(visibleHerdrCapabilities, {
    session: "persistent",
    progress: "activity-snapshot",
    interrupt: "turn-escape",
    termination: "herdr-pane-close",
    timeout: "unsupported",
    resume: "pi-session-file",
    fork: "seeded-pi-session",
    interaction: "user-takeover",
  });
  assert.equal(requireCapability(visibleHerdrCapabilities, "interrupt"), "turn-escape");
  assert.equal(requireCapability(visibleHerdrCapabilities, "resume"), "pi-session-file");
  assert.equal(requireCapability(visibleHerdrCapabilities, "fork"), "seeded-pi-session");
});

test("Core exposes terminal kill without claiming pane closure or process exit", () => {
  const profile = execution.visibleHerdrCoreCapabilities;
  assert.deepEqual(profile, {
    session: "persistent",
    progress: "activity-snapshot",
    interrupt: "turn-escape",
    termination: "core-terminal-kill",
    timeout: "unsupported",
    resume: "pi-session-file",
    fork: "seeded-pi-session",
    interaction: "user-takeover",
  });
  const state = execution.reduceAgentRunEvidence(execution.createAgentRunState("core-run"), {
    kind: "terminate-requested", mode: execution.requireCapability(profile, "termination"),
    runId: "core-run", sourceId: "parent", sequence: 1, observedAt: "2026-11-09T00:00:00Z",
  });
  assert.equal(execution.projectAgentRunStatus(state).terminal, false);
  assert.equal(execution.projectAgentRunCompletion(state, { output: "partial" }), undefined);
  const exited = execution.reduceAgentRunEvidence(state, {
    kind: "process-exited", exit: { kind: "native", code: null, signal: "9" },
    runId: "core-run", sourceId: "core", sequence: 1, observedAt: "2026-11-09T00:00:01Z",
  });
  assert.equal(execution.projectAgentRunCompletion(exited, { output: "partial" }).execution, "terminated");
  assert.equal(execution.projectAgentRunCompletion(exited, { output: "partial" }).taskOutcome, "unknown");
});

for (const operation of ["resume", "fork"]) {
  test(`workflow ${operation} fails with a typed unsupported-capability error`, () => {
    assert.throws(
      () => requireCapability(workflowHeadlessCapabilities, operation),
      (error) => error instanceof UnsupportedAgentRunCapability && error.capability === operation,
    );
  });
}

test("visible timeout fails rather than substituting termination", () => {
  assert.throws(
    () => requireCapability(visibleHerdrCapabilities, "timeout"),
    (error) => error instanceof UnsupportedAgentRunCapability && error.capability === "timeout",
  );
  assert.equal(visibleHerdrCapabilities.interrupt, "turn-escape");
  assert.equal(visibleHerdrCapabilities.termination, "herdr-pane-close");
});
