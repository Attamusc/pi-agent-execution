# pi-agent-execution

Shared, process-neutral contracts for Pi agent definitions and run lifecycle semantics. This is an ordinary ESM library, not a Pi extension. It does not discover definitions, create processes or panes, own sessions, schedule work, apply workflow policy, or deliver results.

## Package contract

The package requires Node.js 24.19 or newer and exposes only its root ESM entry point. `contractVersion` is `2` (package 0.2.0); consumers should assert it during tests or build when pinning a revision.

```ts
import {
  contractVersion,
  parseAgentDefinition,
  resolveAgentLaunchIntent,
  workflowHeadlessCapabilities,
} from "pi-agent-execution";

if (contractVersion !== 2) throw new Error("Unsupported execution contract");
```

Published tarballs contain `dist` and this README. `prepare` performs a build-only TypeScript compilation, so ordinary npm installs from an immutable Git revision also create `dist`; it does not install or configure Pi. `npm pack` and Git dependencies therefore use the same root import and generated declarations. There are no supported deep imports.

## Definition and launch intent

```ts
parseAgentDefinition(
  { path: string, content: string },
  { fallbackName?: string, requiredFields: readonly ("name" | "description")[] },
): ParseAgentDefinitionResult

resolveAgentLaunchIntent(
  definition: NormalizedAgentDefinition,
  task: string,
  callerCwd: string,
  overrides?: AgentLaunchOverrides,
): AgentLaunchIntent
```

Parsing returns a discriminated result with source-located diagnostics. Discovery and eligibility remain caller policy. A prompt descriptor is `{ text: string; mode?: "append" | "replace" }`: Markdown body without a `system-prompt` directive preserves mode absence, while an explicit `append` or `replace` is retained even when the body is empty. Consumers decide how to route implicit body text. A nonblank prompt text override inherits a declared definition mode when its own mode is absent. Unrecognized YAML metadata is preserved. The resolved intent is detached from inputs and deeply immutable, including cyclic metadata.

Supported thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Invalid explicit values are rejected before host creation.

## Capabilities

Capability profiles describe exact host operations. `requireCapability(profile, key)` returns the declared mode or throws `UnsupportedAgentRunCapability`; it never substitutes another operation.

| Axis | Mode | Meaning |
| --- | --- | --- |
| `session` | `ephemeral` | A run does not retain a Pi session. |
| | `persistent` | The host retains a Pi session. |
| `progress` | `pi-json-events` | Progress comes from Pi's JSON event stream. |
| | `activity-snapshot` | Progress comes from host activity snapshots. |
| `interrupt` | `process-abort` | Interrupt aborts the hosted process. |
| | `turn-escape` | Interrupt ends only the active Pi turn. |
| `termination` | `process-signal` | Termination is performed with process signals. |
| | `herdr-pane-close` | Termination closes the selected Herdr pane. |
| | `core-terminal-kill` | Termination asks Herdr Core to end the selected terminal program; record removal is separate. |
| `timeout` | `process-deadline` | The host enforces a process deadline. |
| | `unsupported` | The host has no timeout operation. |
| `resume` | `pi-session-file` | The host can resume a Pi session file. |
| | `unsupported` | Resume is unavailable. |
| `fork` | `seeded-pi-session` | The host can seed a forked Pi session. |
| | `unsupported` | Fork is unavailable. |
| `interaction` | `none` | There is no user takeover. |
| | `user-takeover` | A user can interact with the running session. |

`workflowHeadlessCapabilities` uses ephemeral sessions, JSON progress, process abort/signals/deadlines, no resume or fork, and no takeover. `visibleHerdrCapabilities` uses persistent sessions, activity snapshots, turn Escape, pane closure, session resume/fork, and takeover; timeout is unsupported. `visibleHerdrCoreCapabilities` retains those session operations but uses `core-terminal-kill`. A kill request does not prove process exit, successful work or terminal-record removal; consumers must observe those separately.

## Lifecycle

Create state with `createAgentRunState(runId)`, fold correlated records with `reduceAgentRunEvidence(state, evidence)`, and inspect it with `projectAgentRunStatus(state)`. Evidence is ordered independently per `sourceId` by monotonic `sequence`; wrong-run, malformed, and stale records are ignored.

The state keeps facts on separate axes:

| Axis | States and meaning |
| --- | --- |
| Execution | `idle`, `launching`, `active`, `settling`, `settled`; Pi settlement does not imply process exit. |
| Completion intent | none, `done`, `auto-exit`, `ping`, or `agent-error`; intent does not imply settlement or exit. |
| Session | `unknown`, `open`, or `closed`, with optional host reference and shutdown reason. |
| Process | `not-started`, `starting`, `running`, `failed-to-start`, or `exited`. `failed-to-start` requires explicit host proof that no child started. An exit retains one tagged observation unchanged. |
| Control | none, turn/process interruption, termination request, or timeout. Timeout, process abort, and hard termination remain distinct; the first observed process-ending control cause is retained. Turn-only Escape may be superseded by a later process-ending cause or cleared by actual progress. |
| Transport | optional failure evidence. Failure before any launch request is terminal while the process remains `not-started`. Once launch is requested, generic telemetry loss while starting or running is nonterminal because a child may exist. `host-start-failed` is the separate terminal proof that no child started and cannot be overwritten by delayed host-start evidence. |
| Task outcome | always `unknown` in contract version 2. No prose classification or structured outcome protocol is required. |

Late launch/host evidence cannot reopen a closed session or resurrect an exited or failed-to-start process. `host-start-failed` must not represent ambiguous command dispatch. The first process-ending control cause cannot be overwritten by a later timeout, abort, or termination request and remains the normalized disposition if shutdown subsequently records agent or transport errors; those diagnostic facts remain available on state.

`process-exited` carries `{ exit: AgentProcessExit }`, where `AgentProcessExit` (also exported as `ProcessExit`) is exactly one of:

```ts
{ kind: "native"; code: number | null; signal: string | null }
{ kind: "shell"; shellStatus: number }
{ kind: "process-not-found" }
```

`native` is an actual child-process close observation. `shell` preserves the raw command status; status 143 does not imply or manufacture `SIGTERM`. `process-not-found` is a trustworthy OS observation that a previously owned child PID no longer exists while status remains unavailable—not pane disappearance or missing telemetry. The core performs no PID checks, syscalls, or watching.

### Normalized completion

```ts
projectAgentRunCompletion(
  state: AgentRunState,
  input: {
    output: string;
    errorMessage?: string;
    usage?: AgentRunUsage;
    sessionRef?: string;
  },
): AgentRunCompletion | undefined
```

The helper returns `undefined` when status projection is nonterminal. A caller must retain the run rather than manufacture a normal result. A terminal record contains `runId`, one execution value (`normal-exit`, `agent-error`, `aborted`, `timed-out`, `terminated`, or `transport-failure`), output, `taskOutcome: "unknown"`, settlement evidence, optional process exit/session/error data, and optional host-provided usage (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `totalTokens`, `costUsd`). It is deeply immutable. `sessionRef` is included only when the caller supplies verified Pi session evidence; an opaque lifecycle `hostRef` such as a pane or process identifier is never treated as session identity.

`normal-exit` certifies only the execution handshake: completion intent, Pi settlement, and either native code 0 with no signal or shell status 0. `process-not-found` never proves normal execution by itself; after an explicit termination request it can complete as `terminated`. This does **not** certify that the assigned business task succeeded. Abnormal or uncorrelated exits project as transport failure evidence rather than task failure or success. If neither the caller nor transport supplied an error, the completion explains the exact observed exit shape and missing graceful handshake.

## Assistant output seam

```ts
extractLatestAssistantOutput(
  entries: readonly SessionEntryLike[],
): { output: string; errorMessage?: string }
```

The structural seam accepts current Pi `SessionMessageEntry`-shaped values or their contained `AgentMessage` values without importing unsupported Pi internals. The caller must first select the active session branch. The extractor finds the latest assistant message, joins all of its text blocks in order with newlines, and ignores thinking and tool-call blocks. If that latest message has terminal error evidence and no text, it returns the error and never searches older assistant text. No assistant message yields empty output.

## Native job contracts (v2)

Existing Pi definition shapes, metadata, prompt/output semantics and capability profiles remain unchanged. Resolved intents now explicitly carry `runner`, defaulting to `pi`. Explicit unknown runners fail, without fallback. Legacy `cli` review metadata remains in the parser result for its separate consumer route; the shared launch resolver rejects it rather than silently constructing a Pi intent. Consumers must continue dispatching that existing route themselves.

### Trusted definitions and selection

`parseAgentDefinition` accepts an optional **host-supplied** `source.origin`:

```ts
{ kind: "global-user" | "installed-package" | "project",
  canonicalPath: "/absolute/canonical/agents/worker.md",
  canonicalRoot: "/absolute/canonical/agents" }
```

This is not frontmatter. Discovery must establish origin independently, canonicalize both paths (including symlinks), and supply a caller-configured trusted root. The passive library checks absolute canonical spelling and root containment; it cannot detect a host lying about realpaths or classify filesystem resources itself. Frontmatter `origin` remains untrusted metadata. Missing provenance never enables native execution. Hosts must reject discovery/parse errors, not remove the failed candidate and retry a lower-priority source.

`selectAgentDefinition(candidates)` accepts same-name definitions in host-defined low-to-high precedence order, returns one whole definition, and never merges content or grants. Any project or unprovenanced shadow of a trusted Copilot role fails even when the shadow omits `runner`. Ordinary Pi precedence remains last-candidate-wins. Consumers must collect *all* same-name candidates before selection; passing only an already-selected project winner defeats shadow detection.

Only global-user and installed-package definitions can declare `runner: copilot` or native policy. Supported fields:

```yaml
runner: copilot
runner-version: 1.0.106-3
model: gpt-6.1-sol
thinking: low
auto-exit: true
interactive: false
workspace-trust: session # or existing
native-allow: [write, shell, "tasks(todo)"]
native-deny: []
mcp:
  tasks:
    command: "{node}"
    args: ["{home}/.local/bin/pi-agent-tasks-mcp", "--scope-cwd", "{parentCwd}",
           "--store-override={env.PI_TODO_PATH}", "--actor", "{managedSessionId}"]
```

The native policy is normalized as `definition.native` with `runnerVersion`, `workspaceTrust`, `allow`, `deny`, and `mcp`. Explicit arrays (including empty arrays) express grants, not implicit allow-all. MCP server objects support only `command`, `args` and optional string-valued `env`. The declarations are trusted-job permissions, **not an OS sandbox**. Pi tools/deny-tools/provider and CLI command/argv controls conflict with native mode. Fork, retained/interactive mode and auto-exit=false fail. There is no model-facing native command, permission or trust override. Shared model/thinking overrides retain their documented precedence; thinking uses the existing public vocabulary.

`bindNativeMcp(policy, context)` substitutes only `{home}`, `{node}`, `{parentCwd}`, `{managedSessionId}` and `{env.PI_TODO_PATH}`. Context supplies these as `home`, `node`, `parentCwd`, `managedSessionId`, `todoPathLiteral`. The Pi host captures its override once; `todoPathLiteral` must be the captured value or `""` when absent. Unknown/malformed placeholders fail. Replacement is one-pass: braces, shell syntax and whitespace inside captured values stay literal. The helper does not read environment variables, evaluate shell, spawn anything, or split argv. Hosts must pass command/args directly to their native API, never through an interpolated shell command.

### Caller-bound resume

`NativeSessionReference` is `{runner:'copilot', selector:{kind:'name',value}, managedSessionId, cwd}`. The selector is the unique native conversation name, never a Core terminal ID. Each run has its own lifecycle runId/hostRef; persistent native context survives ephemeral job processes.

`resolveManagedNativeResume(input, callerSessionId, records, trusted)` accepts model input containing only `managedSessionId`, optional `agent`, `message`, and `autoExit:true`. It rejects raw Pi session paths, snapshot paths, executable fields and unknown keys. Existing Pi file-resume remains a separate consumer API. `records` must come from the caller's own correlated launch/session records, not worker result sidecars; unknown/cross-caller/ambiguous IDs fail.

A `ManagedNativeSessionRecord` stores caller identity, native reference, `definitionOrigin`, `definitionSha256`, captured binding context and skill snapshots `{name,body,baseDir}`. The host re-reads the definition through trusted discovery and hashes the exact source bytes before supplying `trusted: {definition,sha256,skills?}`. These host arguments are **not model input or proof by themselves**. The helper validates trusted origin and default-resume hash/path identity; executable policy always comes from the reloaded definition, never a record/snapshot. An explicit same-runner `agent` selection must match the new trusted definition name and can establish a new hash/profile; the host supplies that profile's trusted skill snapshots. Default resume keeps captured skills, scope/actor binding literals, native name and cwd. MCP arguments are regenerated from trusted policy and captured literals. No global session store or arbitrary personal history attachment is provided. Same-user shell tampering is outside this integrity boundary.

### Natural completion and capabilities

`copilotJobCapabilities` declares persistent session context, ephemeral processes, captured-output progress, managed-name resume, no fork/takeover, Core terminal kill and unsupported process-deadline timeout. A host request timeout is not a process deadline or proof of cancellation.

Use `createAgentRunState(runId, "native-job")` for native jobs; the default remains `"pi-handshake"`. Correlated `job-output-captured` evidence carries the host-captured bounded output (empty is valid; missing capture is not). Normal native completion requires both zero/no-signal process exit and captured output, without Pi settlement or completion intent. `agent-settled` cannot settle native state, and native output evidence cannot complete Pi state. Native completion returns `completionEvidence: "native-job-exit-output"`, `settled:false`, and `taskOutcome:"unknown"`; exit zero certifies invocation only. The completion output uses captured evidence, not an independently supplied string. Hosts own output collection, truncation policy and private full-output retention; this library never exports native history/config.

`request-timeout` evidence records `{operation,timeoutMs}` as observation failure. Ambiguous launch/request failure after dispatch remains nonterminal until correlated process exit or proven no-child start failure. Existing nonzero/signal/unavailable-exit, process deadline, abort, terminate, stale/wrong-run evidence rules remain in force. Hosts must correlate all evidence to owned programs, not infer completion from missing panes or quiet output.

## Development

```sh
npm install
npm run check
npm pack --dry-run
```
