import assert from "node:assert/strict";
import test from "node:test";

import { resolveAgentLaunchIntent } from "../dist/index.js";

const definition = {
  name: "worker",
  description: "Does work",
  model: "default-model",
  thinking: "medium",
  tools: ["read"],
  skills: ["tdd"],
  systemPrompt: { mode: "append", text: "Default prompt" },
  cwd: "definition-relative",
  metadata: { consumer: { interactive: false } },
};

test("explicit shared overrides win without mutating inputs", () => {
  const overrides = {
    model: "override-model",
    thinking: "high",
    tools: ["bash"],
    skills: ["commit"],
    systemPrompt: { mode: "replace", text: "Override prompt" },
    cwd: "caller-selected-cwd",
  };
  const definitionBefore = structuredClone(definition);
  const overridesBefore = structuredClone(overrides);

  const intent = resolveAgentLaunchIntent(definition, "Implement it", "/caller/cwd", overrides);

  assert.deepEqual(intent.effective, {
    model: "override-model",
    thinking: "high",
    tools: ["bash"],
    skills: ["commit"],
    systemPrompt: { mode: "replace", text: "Override prompt" },
  });
  assert.equal(intent.cwd, "caller-selected-cwd");
  assert.equal(intent.task, "Implement it");
  assert.deepEqual(definition, definitionBefore);
  assert.deepEqual(overrides, overridesBefore);
});

test("omitted and blank string overrides preserve definition defaults and cwd text", () => {
  const intent = resolveAgentLaunchIntent(definition, "Task", "/caller/cwd", {
    model: "  ",
    thinking: "",
    cwd: " \t ",
  });

  assert.deepEqual(intent.effective, {
    model: "default-model",
    thinking: "medium",
    tools: ["read"],
    skills: ["tdd"],
    systemPrompt: { mode: "append", text: "Default prompt" },
  });
  assert.equal(intent.cwd, "definition-relative");
});

test("a prompt text override inherits the declared mode when omitted", () => {
  const intent = resolveAgentLaunchIntent(definition, "Task", "/caller", {
    systemPrompt: { text: "Replacement text" },
  });
  assert.deepEqual(intent.effective.systemPrompt, { mode: "append", text: "Replacement text" });

  const implicit = resolveAgentLaunchIntent(
    { name: "implicit", systemPrompt: { text: "Body" }, metadata: {} },
    "Task",
    "/caller",
    { systemPrompt: { text: "Override" } },
  );
  assert.deepEqual(implicit.effective.systemPrompt, { text: "Override" });
});

test("caller cwd is used verbatim when no definition or override cwd exists", () => {
  const minimal = { name: "worker", metadata: {} };
  assert.equal(resolveAgentLaunchIntent(minimal, "Task", "relative/caller", {}).cwd, "relative/caller");
});

test("accepts every public thinking level", () => {
  for (const thinking of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    assert.equal(resolveAgentLaunchIntent(definition, "Task", "/caller", { thinking }).effective.thinking, thinking);
  }
});

test("invalid explicit thinking is rejected", () => {
  assert.throws(
    () => resolveAgentLaunchIntent(definition, "Task", "/caller", { thinking: "extreme" }),
    /Invalid thinking level 'extreme'/,
  );
});

test("cyclic preserved metadata is cloned and frozen without overflowing", () => {
  const self = {};
  self.self = self;
  const intent = resolveAgentLaunchIntent({ name: "cyclic", metadata: { extra: self } }, "Task", "/caller");

  assert.equal(intent.definition.metadata.extra.self, intent.definition.metadata.extra);
  assert.equal(Object.isFrozen(intent.definition.metadata.extra), true);
});

test("launch intent is deeply immutable and detached from its inputs", () => {
  const mutableDefinition = structuredClone(definition);
  const mutableOverrides = { tools: ["bash"], systemPrompt: { mode: "replace", text: "Prompt" } };
  const intent = resolveAgentLaunchIntent(mutableDefinition, "Task", "/caller", mutableOverrides);

  assert.ok(Object.isFrozen(intent));
  assert.ok(Object.isFrozen(intent.definition));
  assert.ok(Object.isFrozen(intent.definition.metadata));
  assert.ok(Object.isFrozen(intent.definition.metadata.consumer));
  assert.ok(Object.isFrozen(intent.effective));
  assert.ok(Object.isFrozen(intent.effective.tools));
  assert.ok(Object.isFrozen(intent.effective.systemPrompt));
  assert.throws(() => intent.effective.tools.push("write"), TypeError);

  mutableDefinition.metadata.consumer.interactive = true;
  mutableOverrides.tools.push("write");
  mutableOverrides.systemPrompt.text = "Changed";
  assert.equal(intent.definition.metadata.consumer.interactive, false);
  assert.deepEqual(intent.effective.tools, ["bash"]);
  assert.equal(intent.effective.systemPrompt.text, "Prompt");
});
