import assert from "node:assert/strict";
import test from "node:test";
import * as api from "../dist/index.js";

const origin = { kind: "installed-package", canonicalPath: "/pkg/agents/w.md", canonicalRoot: "/pkg/agents" };
const definition = api.parseAgentDefinition({ path: origin.canonicalPath, origin, content: '---\nname: w\nrunner: copilot\nrunner-version: 1.0.106-3\nauto-exit: true\ninteractive: false\nworkspace-trust: session\nnative-allow: [shell]\nmcp:\n  tasks:\n    command: "{node}"\n    args: ["{home}", "{parentCwd}", "{managedSessionId}", "--store-override={env.PI_TODO_PATH}"]\n---\nWork' }, { requiredFields: ["name"] }).definition;
const context = { home: "/home/me", node: "/bin/node", parentCwd: "/parent", managedSessionId: "managed-1", todoPathLiteral: "../tasks/{node};$(do-not-run)" };

test("MCP expansion is one-pass literal substitution, never ambient env or shell", () => {
  assert.deepEqual(api.bindNativeMcp(definition.native, context).tasks, { command: "/bin/node", args: ["/home/me", "/parent", "managed-1", "--store-override=../tasks/{node};$(do-not-run)"] });
  assert.equal(api.bindNativeMcp(definition.native, { ...context, todoPathLiteral: "" }).tasks.args.at(-1), "--store-override=");
  for (const token of ["{env.HOME}", "{unknown}", "{node", "{{home}}"] ) {
    assert.throws(() => api.bindNativeMcp({ ...definition.native, mcp: { x: { command: token, args: [] } } }, context), /placeholder/);
  }
});

test("native resume accepts caller-bound managed ID only and re-resolves hashed policy", () => {
  assert.equal(typeof api.resolveManagedNativeResume, "function");
  const sha256 = "a".repeat(64);
  const record = { callerSessionId: "parent", reference: { runner: "copilot", selector: { kind: "name", value: "unique-native-name" }, managedSessionId: "managed-1", cwd: "/job" }, definitionOrigin: origin, definitionSha256: sha256, bindings: context, skills: [{ name: "tdd", body: "frozen skill bytes", baseDir: "/skills/tdd" }] };
  const trusted = { definition, sha256 };
  const resume = (input, caller = "parent", resolved = trusted) => api.resolveManagedNativeResume(input, caller, [record], resolved);
  const result = resume({ managedSessionId: "managed-1", message: "Continue" });
  assert.equal(result.reference.selector.value, "unique-native-name");
  assert.equal(result.mcp.tasks.command, "/bin/node");
  assert.equal(result.skills[0].body, "frozen skill bytes");
  assert.equal(Object.isFrozen(result.reference), true);
  for (const input of [{ managedSessionId: "unknown" }, { managedSessionId: "managed-1", sessionPath: "/tmp/model" }, { managedSessionId: "managed-1", snapshot: {} }, { managedSessionId: "managed-1", nativeAllow: ["all"] }, { managedSessionId: "managed-1", autoExit: false }]) assert.throws(() => resume(input));
  assert.throws(() => resume({ managedSessionId: "managed-1" }, "other"), /caller|Unknown/);
  assert.throws(() => resume({ managedSessionId: "managed-1" }, "parent", { ...trusted, sha256: "b".repeat(64) }), /changed|hash/i);
  assert.throws(() => resume({ managedSessionId: "managed-1" }, "parent", { ...trusted, definition: { ...definition, origin: { ...origin, kind: "project" } } }), /Project/);
  assert.equal(resume({ managedSessionId: "managed-1", agent: "w" }, "parent", { ...trusted, sha256: "b".repeat(64) }).definition.name, "w");
});
