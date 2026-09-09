import assert from "node:assert/strict";
import test from "node:test";

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
