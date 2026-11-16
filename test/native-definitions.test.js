import assert from "node:assert/strict";
import test from "node:test";
import * as api from "../dist/index.js";

const origin = { kind: "global-user", canonicalPath: "/home/me/agents/worker.md", canonicalRoot: "/home/me/agents" };
const parse = (yaml, provenance = origin) => api.parseAgentDefinition({ path: "/agents/worker.md", content: `---\nname: worker\n${yaml}\n---\nWork`, origin: provenance }, { requiredFields: ["name"] });

const nativeYaml = `runner: copilot\nrunner-version: 1.0.106-3\nauto-exit: true\ninteractive: false\nworkspace-trust: session\nnative-allow: [write, shell, "tasks(todo)"]\nnative-deny: []\nmcp:\n  tasks:\n    command: "{node}"\n    args: ["--scope-cwd", "{parentCwd}", "--store-override={env.PI_TODO_PATH}"]`;

const claudeYaml = nativeYaml.replace("runner: copilot", "runner: claude").replace("1.0.106-3", "2.1.325").replace("workspace-trust: session", "workspace-trust: existing") + '\nnative-tools: [Read, Edit, Bash]\npermission-mode: dontAsk';

test("Claude policy requires explicit tools, bounded permissions and existing trust", () => {
  const result = parse(claudeYaml);
  assert.equal(result.ok, true);
  assert.deepEqual(result.definition.native.nativeTools, ["Read", "Edit", "Bash"]);
  assert.equal(result.definition.native.permissionMode, "dontAsk");
  assert.equal(result.definition.metadata["native-tools"], undefined);
  assert.equal(api.resolveAgentLaunchIntent(result.definition, "Task", "/caller").runner, "claude");
  for (const yaml of [
    claudeYaml.replace("workspace-trust: existing", "workspace-trust: session"),
    claudeYaml.replace("permission-mode: dontAsk", "permission-mode: bypassPermissions"),
    claudeYaml.replace("\nnative-tools: [Read, Edit, Bash]", ""),
    claudeYaml.replace("[Read, Edit, Bash]", '["*"]'),
    claudeYaml + "\ncli: claude",
    nativeYaml + "\npermission-mode: manual",
  ]) assert.equal(parse(yaml).ok, false, yaml);
  assert.equal(parse(claudeYaml, { kind: "project", canonicalPath: "/project/worker.md", canonicalRoot: "/project" }).ok, false);
  const project = parse("description: shadow").definition;
  assert.throws(() => api.selectAgentDefinition([result.definition, { ...project, origin: undefined }]), /shadow/i);
  assert.throws(() => api.resolveAgentLaunchIntent(result.definition, "Task", "/caller", { tools: ["read"] }), /Pi tools/);
  assert.equal(api.claudeJobCapabilities.resume, "managed-native-uuid");
});

test("trusted native policy is normalized separately from metadata and model overrides", () => {
  const result = parse(nativeYaml);
  assert.equal(result.ok, true);
  assert.equal(result.definition.runner, "copilot");
  assert.equal(result.definition.native.runnerVersion, "1.0.106-3");
  assert.deepEqual(result.definition.native.allow, ["write", "shell", "tasks(todo)"]);
  assert.deepEqual(result.definition.origin, origin);
  const intent = api.resolveAgentLaunchIntent(result.definition, "Task", "/caller", { model: "native-model" });
  assert.equal(intent.runner, "copilot");
  assert.equal(intent.effective.model, "native-model");
  assert.equal(Object.isFrozen(intent.definition.native.allow), true);
});

test("native config rejects unknown runners, conflicts, malformed policies and spoofed origin", () => {
  for (const yaml of ["runner: other", "runner: pi\nnative-allow: [shell]", nativeYaml + "\ntools: read", nativeYaml.replace("auto-exit: true", "auto-exit: false"), nativeYaml.replace("interactive: false", "interactive: true"), nativeYaml + "\nsession-mode: fork", nativeYaml.replace("[write, shell, \"tasks(todo)\"]", "shell"), nativeYaml.replace('command: "{node}"', 'command: 42')]) {
    assert.equal(parse(yaml).ok, false, yaml);
  }
  const spoof = api.parseAgentDefinition({ path: "/project/worker.md", content: `---\nname: worker\norigin: {kind: global-user}\n${nativeYaml}\n---\nWork` }, { requiredFields: ["name"] });
  assert.equal(spoof.ok, false);
  for (const provenance of [{ kind: "project", canonicalPath: "/project/worker.md", canonicalRoot: "/project" }, { ...origin, canonicalPath: "/project/escape.md" }, { ...origin, canonicalPath: "/home/me/agents/../escape.md" }, { ...origin, canonicalRoot: "relative" }]) {
    assert.equal(parse(nativeYaml, provenance).ok, false);
  }
});

test("legacy CLI review metadata stays available but cannot silently resolve as Pi", () => {
  const legacy = parse("cli: claude\nmodel: sonnet").definition;
  assert.equal(legacy.metadata.cli, "claude");
  assert.throws(() => api.resolveAgentLaunchIntent(legacy, "Review", "/caller"), /CLI/);
});

test("precedence rejects project shadows of trusted native roles without policy merging", () => {
  const trusted = parse(nativeYaml).definition;
  const project = parse("description: Project body", { kind: "project", canonicalPath: "/project/worker.md", canonicalRoot: "/project" }).definition;
  assert.throws(() => api.selectAgentDefinition([trusted, project]), /shadow/i);
  const pi = parse("model: pi-default").definition;
  assert.equal(api.selectAgentDefinition([pi, project]), project);
  assert.equal(api.resolveAgentLaunchIntent(pi, "Task", "/caller").runner, "pi");
});
