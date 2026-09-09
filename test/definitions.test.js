import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseAgentDefinition } from "../dist/index.js";

const fixture = async (name) => ({
  path: `/agents/${name}`,
  content: await readFile(new URL(`fixtures/agents/${name}`, import.meta.url), "utf8"),
});

test("normalizes a declared agent definition and preserves consumer metadata", async () => {
  const result = parseAgentDefinition(await fixture("scout.md"), {
    requiredFields: ["name", "description"],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.definition, {
    name: "scout",
    description: "Fast codebase reconnaissance",
    model: "github-copilot/gpt-5.6-luna",
    thinking: "low",
    tools: ["read", "bash", "write"],
    skills: ["learn-codebase", "researcher"],
    systemPrompt: {
      mode: "append",
      text: "# Scout Agent\n\nMap the relevant code and report findings.",
    },
    cwd: "/tmp/scout",
    metadata: {
      "deny-tools": "claude",
      spawning: false,
      "auto-exit": true,
    },
  });
});

test("uses caller fallback name and singular skill alias", async () => {
  const result = parseAgentDefinition(await fixture("visible-worker.md"), {
    fallbackName: "visible-worker",
    requiredFields: ["name"],
  });

  assert.equal(result.ok, true);
  assert.equal(result.definition.name, "visible-worker");
  assert.deepEqual(result.definition.skills, ["tdd", "commit"]);
  assert.deepEqual(result.definition.systemPrompt, {
    mode: "replace",
    text: "Work visibly and report the result.",
  });
  assert.deepEqual(result.definition.metadata, {
    interactive: true,
    "session-mode": "fork",
    "disable-model-invocation": false,
  });
});

test("reports missing policy-required fields at the source", () => {
  const result = parseAgentDefinition(
    { path: "/agents/unnamed.md", content: "---\nmodel: test/model\n---\nBody\n" },
    { requiredFields: ["name", "description"] },
  );

  assert.equal(result.ok, false);
  assert.deepEqual(result.diagnostics.map(({ path, field, message }) => ({ path, field, message })), [
    { path: "/agents/unnamed.md", field: "name", message: "Required field 'name' is missing" },
    { path: "/agents/unnamed.md", field: "description", message: "Required field 'description' is missing" },
  ]);
});

test("rejects invalid explicit thinking with its source location", () => {
  const result = parseAgentDefinition(
    { path: "/agents/bad-thinking.md", content: "---\nname: bad\nthinking: enormous\n---\nBody\n" },
    { requiredFields: ["name"] },
  );

  assert.equal(result.ok, false);
  assert.deepEqual(result.diagnostics, [{
    path: "/agents/bad-thinking.md",
    field: "thinking",
    location: { line: 3, column: 1 },
    message: "Invalid thinking level 'enormous'",
  }]);
});

test("preserves prompt mode absence for an implicit body", () => {
  const result = parseAgentDefinition(
    { path: "/agents/implicit.md", content: "---\nname: implicit\n---\nBody\n" },
    { requiredFields: ["name"] },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.definition.systemPrompt, { text: "Body" });
});

test("preserves an explicit system prompt mode when the body is empty", () => {
  const result = parseAgentDefinition(
    { path: "/agents/probe.md", content: "---\nname: probe\nsystem-prompt: replace\n---\n" },
    { requiredFields: ["name"] },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.definition.systemPrompt, { mode: "replace", text: "" });
});

test("reports malformed YAML at its source location", () => {
  const result = parseAgentDefinition(
    { path: "/agents/malformed.md", content: "---\nname: [broken\n---\n" },
    { requiredFields: ["name"] },
  );

  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0].path, "/agents/malformed.md");
  assert.deepEqual(result.diagnostics[0].location, { line: 2, column: 14 });
});

test("keeps absent optional values absent", () => {
  const result = parseAgentDefinition(
    { path: "/agents/minimal.md", content: "---\nname: minimal\n---\n" },
    { requiredFields: ["name"] },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.definition, { name: "minimal", metadata: {} });
});
