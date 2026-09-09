# pi-agent-execution

Shared, process-neutral contracts for Pi agent definitions and run lifecycle semantics. This is an ordinary ESM library, not a Pi extension. It does not discover definitions, create processes or panes, own sessions, schedule work, apply workflow policy, or deliver results.

## Package contract

The package requires Node.js 24.19 or newer and exposes only its root ESM entry point. `contractVersion` is `1`; consumers should assert it during tests or build when pinning a revision.

```ts
import {
  contractVersion,
  parseAgentDefinition,
  resolveAgentLaunchIntent,
  workflowHeadlessCapabilities,
} from "pi-agent-execution";

if (contractVersion !== 1) throw new Error("Unsupported execution contract");
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
| `timeout` | `process-deadline` | The host enforces a process deadline. |
| | `unsupported` | The host has no timeout operation. |
| `resume` | `pi-session-file` | The host can resume a Pi session file. |
| | `unsupported` | Resume is unavailable. |
| `fork` | `seeded-pi-session` | The host can seed a forked Pi session. |
| | `unsupported` | Fork is unavailable. |
| `interaction` | `none` | There is no user takeover. |
| | `user-takeover` | A user can interact with the running session. |

`workflowHeadlessCapabilities` uses ephemeral sessions, JSON progress, process abort/signals/deadlines, no resume or fork, and no takeover. `visibleHerdrCapabilities` uses persistent sessions, activity snapshots, turn Escape, pane closure, session resume/fork, and takeover; timeout is unsupported.

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
| Task outcome | always `unknown` in contract version 1. No prose classification or structured outcome protocol is required. |

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

## Development

```sh
npm install
npm run check
npm pack --dry-run
```
