import assert from "node:assert/strict";
import test from "node:test";
import * as api from "../dist/index.js";

const origin = { kind: "global-user", canonicalPath: "/global/agents/w.md", canonicalRoot: "/global/agents" };
const source = { path: origin.canonicalPath, origin, content: '---\nname: w\nrunner: copilot\nrunner-version: 1.0.106-3\nauto-exit: true\ninteractive: false\nworkspace-trust: session\nnative-allow: [shell]\nskills: tdd, commit\nmcp:\n  tasks:\n    command: "{node}"\n    args: ["{home}", "{parentCwd}", "{managedSessionId}", "{env.PI_TODO_PATH}"]\n---\nWork' };
const definition = api.parseAgentDefinition(source, { requiredFields: ["name"] }).definition;
const sha256 = "a".repeat(64);
const bindings = { parentCwd: "/parent", managedSessionId: "managed", todoPathLiteral: "../tasks" };
const runtime = { home: "/current/home", node: "/current/node" };
const skills = [{ name: "tdd", body: "captured tdd", baseDir: "/skills/tdd" }, { name: "commit", body: "captured commit", baseDir: "/skills/commit" }];
const record = { callerSessionId: "caller", reference: { runner: "copilot", selector: { kind: "name", value: "native-name" }, managedSessionId: "managed", cwd: "/job" }, definitionOrigin: origin, definitionSha256: sha256, bindings, skills };
const trusted = { definition, sha256, runtime, skills };
const resume = (entry = record, policy = trusted, input = { managedSessionId: "managed" }, caller = "caller") => api.resolveManagedNativeResume(input, caller, [entry], policy);

test("resume uses current trusted runtime and emits only captured scope, not executable record fields", () => {
  const poisoned = { ...record, node: "/injected", reference: { ...record.reference, command: "injected" }, skills: skills.map((skill) => ({ ...skill, argv: ["injected"] })), bindings: { ...bindings, home: "/old-or-injected/home", node: "/old-or-injected/node" } };
  const result = resume(poisoned);
  assert.equal(result.mcp.tasks.command, "/current/node");
  assert.deepEqual(result.mcp.tasks.args, ["/current/home", "/parent", "managed", "../tasks"]);
  assert.deepEqual(result.bindings, bindings);
  assert.deepEqual(result.reference, record.reference);
  assert.deepEqual(result.skills, skills);
  const changed = resume(poisoned, { ...trusted, runtime: { home: "/new/home", node: "/new/node" } });
  assert.equal(changed.mcp.tasks.command, "/new/node");
  assert.equal(changed.mcp.tasks.args[0], "/new/home");
  assert.throws(() => resume(poisoned, { ...trusted, runtime: undefined }), TypeError);
});

test("all MCP binding values are nonblank except the captured todo override", () => {
  const context = { ...bindings, ...runtime };
  for (const key of ["home", "node", "parentCwd", "managedSessionId"]) {
    for (const value of ["", "  ", null, undefined, "bad\0value"]) {
      assert.throws(() => api.bindNativeMcp({ ...definition.native, mcp: {} }, { ...context, [key]: value }), TypeError, key);
    }
  }
  assert.deepEqual(api.bindNativeMcp(definition.native, { ...context, todoPathLiteral: "" }).tasks.args.at(-1), "");
});

test("explicit profile skills must exactly match declared trusted snapshots in order", () => {
  const input = { managedSessionId: "managed", agent: "w" };
  for (const snapshots of [undefined, [], skills.slice(0, 1), [...skills].reverse(), [...skills, skills[0]], [{ ...skills[0], name: "other" }, skills[1]]]) {
    assert.throws(() => resume({ ...record, bindings: { ...bindings, ...runtime } }, { ...trusted, skills: snapshots }, input), /skill/i);
  }
  assert.deepEqual(resume(record, trusted, input).skills, skills);
  assert.deepEqual(resume(record).skills, skills);
});

test("resume rejects malformed captured fields and actor/hash/path boundaries", () => {
  for (const entry of [
    { ...record, callerSessionId: "other" },
    { ...record, callerSessionId: "" },
    { ...record, bindings: { ...bindings, managedSessionId: "other-actor" } },
    { ...record, bindings: { ...bindings, parentCwd: " " } },
    { ...record, bindings: { ...bindings, todoPathLiteral: null } },
    { ...record, reference: { ...record.reference, cwd: "" } },
    { ...record, reference: { ...record.reference, cwd: "relative" } },
    { ...record, reference: { ...record.reference, selector: { kind: "terminal", value: "terminal-id" } } },
    { ...record, reference: { ...record.reference, selector: { kind: "name", value: "\0" } } },
    { ...record, definitionSha256: "" },
    { ...record, definitionOrigin: undefined },
    { ...record, definitionOrigin: { ...origin, canonicalPath: "/global/agents-escape/w.md" } },
    { ...record, skills: [{ name: "tdd", body: 42, baseDir: "/skills/tdd" }] },
  ]) assert.throws(() => resume({ ...entry, bindings: { ...entry.bindings, ...runtime } }), TypeError);
  assert.throws(() => resume(record, trusted, { managedSessionId: "managed" }, ""), TypeError);
  for (const altered of [
    { ...trusted, sha256: "b".repeat(64) },
    { ...trusted, definition: { ...definition, origin: undefined } },
    { ...trusted, definition: { ...definition, origin: { ...origin, canonicalPath: "/global/agents/changed.md" } } },
    { ...trusted, definition: { ...definition, origin: { ...origin, kind: "project" } } },
  ]) assert.throws(() => resume(record, altered), TypeError);
});

test("missing provenance and project-native/shadow sources fail without fallback", () => {
  assert.equal(api.parseAgentDefinition({ ...source, origin: undefined }, { requiredFields: ["name"] }).ok, false);
  const projectOrigin = { kind: "project", canonicalPath: "/project/w.md", canonicalRoot: "/project" };
  assert.equal(api.parseAgentDefinition({ ...source, origin: projectOrigin }, { requiredFields: ["name"] }).ok, false);
  const shadow = api.parseAgentDefinition({ path: projectOrigin.canonicalPath, origin: projectOrigin, content: "---\nname: w\n---\nProject content" }, { requiredFields: ["name"] }).definition;
  assert.throws(() => api.selectAgentDefinition([definition, shadow]), /shadow/);
  assert.throws(() => api.selectAgentDefinition([shadow, definition]), /shadow/);
});

test("explicit cli pi still resolves as Pi; non-Pi CLI review metadata stays separate", () => {
  const parse = (cli) => api.parseAgentDefinition({ path: "/pi.md", content: `---\nname: pi\ncli: ${cli}\n---\nReview` }, { requiredFields: ["name"] }).definition;
  assert.doesNotThrow(() => api.resolveAgentLaunchIntent(parse("pi"), "Task", "/cwd"));
  assert.equal(api.resolveAgentLaunchIntent(parse("pi"), "Task", "/cwd").runner, "pi");
  assert.throws(() => api.resolveAgentLaunchIntent(parse("claude"), "Task", "/cwd"), /CLI/);
});

const event = (kind, sequence, extra = {}) => ({ kind, runId: "job", sourceId: "host", sequence, observedAt: "now", ...extra });
const fold = (events) => events.reduce(api.reduceAgentRunEvidence, api.createAgentRunState("job", "native-job"));
const started = event("host-started", 0, { hostRef: "terminal" });
const output = event("job-output-captured", 1, { output: "response" });
const exited = event("process-exited", 2, { exit: { kind: "native", code: 0, signal: null } });
const timeout = event("request-timeout", 3, { operation: "observe", timeoutMs: 1000 });

test("request timeouts remain typed observation facts and cannot overturn correlated completion", () => {
  const active = fold([started, timeout]);
  assert.deepEqual(active.requestTimeout, { operation: "observe", timeoutMs: 1000 });
  assert.equal(active.transportFailure, null);
  assert.equal(api.projectAgentRunStatus(active).terminal, false);
  assert.equal(api.projectAgentRunStatus(active).disposition, "request-timeout");
  for (const events of [[started, output, exited, timeout], [started, { ...timeout, sequence: 1 }, { ...output, sequence: 2 }, { ...exited, sequence: 3 }]]) {
    const state = fold(events);
    assert.equal(api.projectAgentRunStatus(state).disposition, "completed");
    const completion = api.projectAgentRunCompletion(state, { output: "" });
    assert.equal(completion.execution, "normal-exit");
    assert.equal(completion.errorMessage, undefined);
    assert.deepEqual(completion.requestTimeout, { operation: "observe", timeoutMs: 1000 });
  }
});

test("Pi settlement and intent cannot substitute for native output", () => {
  const state = fold([started, event("completion-requested", 1, { reason: "done" }), event("agent-settled", 2), { ...exited, sequence: 3 }]);
  assert.equal(api.projectAgentRunStatus(state).disposition, "abnormal-exit");
  assert.equal(api.projectAgentRunCompletion(state, { output: "unproven text" }).settled, false);
});
