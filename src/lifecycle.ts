import { deepFreeze } from "./internal.js";
import type { AgentLaunchIntent } from "./resolve.js";

export type CompletionReason = "done" | "auto-exit" | "ping" | "agent-error";
export type InterruptMode = "process-abort" | "turn-escape";
export type TerminationMode = "process-signal" | "herdr-pane-close" | "core-terminal-kill";

export type AgentProcessExit =
  | Readonly<{ kind: "native"; code: number | null; signal: string | null }>
  | Readonly<{ kind: "shell"; shellStatus: number }>
  | Readonly<{ kind: "process-not-found" }>;

export type ProcessExit = AgentProcessExit;

type Evidence<Kind extends string, Data extends object> = Readonly<{
  kind: Kind;
  runId: string;
  sourceId: string;
  sequence: number;
  observedAt: string;
}> & Readonly<Data>;

export type AgentRunEvidence =
  | Evidence<"launch-requested", { intent: AgentLaunchIntent }>
  | Evidence<"host-started", { hostRef: string }>
  | Evidence<"host-start-failed", { message: string }>
  | Evidence<"progress", { activity?: string; estimated: boolean }>
  | Evidence<"turn-ended", { turnIndex?: number; stopReason?: string }>
  | Evidence<"agent-ended", { willRetry?: boolean }>
  | Evidence<"agent-settled", Record<string, never>>
  | Evidence<"completion-requested", { reason: CompletionReason }>
  | Evidence<"session-shutdown", { reason: string }>
  | Evidence<"process-exited", { exit: AgentProcessExit }>
  | Evidence<"timeout-fired", { timeoutMs: number }>
  | Evidence<"interrupt-requested", { mode: InterruptMode }>
  | Evidence<"terminate-requested", { mode: TerminationMode }>
  | Evidence<"transport-failed", { message: string }>;

export type AgentRunState = Readonly<{
  runId: string;
  execution: Readonly<{
    status: "idle" | "launching" | "active" | "settling" | "settled";
  }>;
  completionIntent: Readonly<{ reason: CompletionReason; observedAt: string }> | null;
  session: Readonly<{
    status: "unknown" | "open" | "closed";
    hostRef?: string;
    shutdownReason?: string;
  }>;
  process: Readonly<{
    status: "not-started" | "starting" | "running" | "failed-to-start" | "exited";
    exit?: AgentProcessExit;
  }>;
  startFailure: Readonly<{ message: string }> | null;
  control:
    | Readonly<{ status: "none" }>
    | Readonly<{ status: "interrupted"; mode: InterruptMode }>
    | Readonly<{ status: "terminate-requested"; mode: TerminationMode }>
    | Readonly<{ status: "timed-out"; timeoutMs: number }>;
  transportFailure: Readonly<{ message: string }> | null;
  lastSequenceBySource: Readonly<Record<string, number>>;
}>;

export type AgentRunDisposition =
  | "pending"
  | "completed"
  | "abnormal-exit"
  | "timed-out"
  | "aborted"
  | "interrupted"
  | "terminated"
  | "agent-error"
  | "transport-failed";

export type AgentRunUsage = Readonly<{
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}>;

export type AgentRunCompletion = Readonly<{
  runId: string;
  execution: "normal-exit" | "agent-error" | "aborted" | "timed-out" | "terminated" | "transport-failure";
  output: string;
  taskOutcome: "unknown";
  settled: boolean;
  processExit?: AgentProcessExit;
  sessionRef?: string;
  errorMessage?: string;
  usage?: AgentRunUsage;
}>;

export type AgentRunCompletionInput = Readonly<{
  output: string;
  errorMessage?: string;
  usage?: AgentRunUsage;
  sessionRef?: string;
}>;

export type AgentRunProjectedStatus = Readonly<{
  status:
    | "idle"
    | "launching"
    | "running"
    | "waiting"
    | "finishing"
    | "completed"
    | "abnormal"
    | "timed-out"
    | "aborted"
    | "interrupted"
    | "terminated"
    | "failed";
  disposition: AgentRunDisposition;
  terminal: boolean;
  taskOutcome: "unknown";
}>;

export function createAgentRunState(runId: string): AgentRunState {
  if (!runId.trim()) throw new TypeError("runId must not be blank");
  return deepFreeze({
    runId,
    execution: { status: "idle" },
    completionIntent: null,
    session: { status: "unknown" },
    process: { status: "not-started" },
    startFailure: null,
    control: { status: "none" },
    transportFailure: null,
    lastSequenceBySource: {},
  });
}

export function reduceAgentRunEvidence(
  state: AgentRunState,
  evidence: AgentRunEvidence,
): AgentRunState {
  if (evidence.runId !== state.runId) return state;
  if (!Number.isSafeInteger(evidence.sequence) || evidence.sequence < 0) return state;
  const previousSequence = state.lastSequenceBySource[evidence.sourceId];
  if (previousSequence !== undefined && evidence.sequence <= previousSequence) return state;

  let execution = state.execution;
  let completionIntent = state.completionIntent;
  let session = state.session;
  let process = state.process;
  let startFailure = state.startFailure;
  let control = state.control;
  let transportFailure = state.transportFailure;

  switch (evidence.kind) {
    case "launch-requested":
      if (execution.status === "idle") execution = { status: "launching" };
      if (process.status === "not-started") process = { status: "starting" };
      break;
    case "host-started":
      if (process.status !== "failed-to-start") {
        if (execution.status === "idle" || execution.status === "launching") execution = { status: "active" };
        if (session.status !== "closed") session = { status: "open", hostRef: evidence.hostRef };
        if (process.status !== "exited") process = { status: "running" };
      }
      break;
    case "host-start-failed":
      if (process.status === "not-started" || process.status === "starting") {
        process = { status: "failed-to-start" };
        startFailure = { message: evidence.message };
      }
      break;
    case "progress":
      execution = { status: "active" };
      if (control.status === "interrupted" && control.mode === "turn-escape") {
        control = { status: "none" };
      }
      break;
    case "turn-ended":
      execution = { status: "settling" };
      break;
    case "agent-ended":
      execution = { status: evidence.willRetry ? "active" : "settling" };
      break;
    case "agent-settled":
      execution = { status: "settled" };
      break;
    case "completion-requested":
      if (completionIntent?.reason !== "agent-error") {
        completionIntent = { reason: evidence.reason, observedAt: evidence.observedAt };
      }
      break;
    case "session-shutdown":
      session = {
        status: "closed",
        ...(state.session.hostRef === undefined ? {} : { hostRef: state.session.hostRef }),
        shutdownReason: evidence.reason,
      };
      break;
    case "process-exited":
      if (process.status !== "exited" && process.status !== "failed-to-start") {
        process = { status: "exited", exit: { ...evidence.exit } };
      }
      break;
    case "timeout-fired":
      if (control.status === "none" || (control.status === "interrupted" && control.mode === "turn-escape")) {
        control = { status: "timed-out", timeoutMs: evidence.timeoutMs };
      }
      break;
    case "interrupt-requested":
      if (control.status === "none" || (control.status === "interrupted" && control.mode === "turn-escape")) {
        control = { status: "interrupted", mode: evidence.mode };
      }
      break;
    case "terminate-requested":
      if (control.status === "none" || (control.status === "interrupted" && control.mode === "turn-escape")) {
        control = { status: "terminate-requested", mode: evidence.mode };
      }
      break;
    case "transport-failed":
      transportFailure = { message: evidence.message };
      break;
  }

  return deepFreeze({
    ...state,
    execution,
    completionIntent,
    session,
    process,
    startFailure,
    control,
    transportFailure,
    lastSequenceBySource: {
      ...state.lastSequenceBySource,
      [evidence.sourceId]: evidence.sequence,
    },
  });
}

export function projectAgentRunStatus(state: AgentRunState): AgentRunProjectedStatus {
  // A transport failure before any process exists is a terminal spawn failure.
  // Once startup begins, loss of observation cannot prove that the host ended;
  // correlated process-exit evidence remains the terminal fact.
  const terminal =
    state.process.status === "exited" ||
    state.process.status === "failed-to-start" ||
    (state.transportFailure !== null && state.process.status === "not-started");

  // The first process-ending control request remains the execution cause even
  // when shutdown subsequently emits agent or transport errors.
  if (state.control.status === "timed-out") {
    return { status: "timed-out", disposition: "timed-out", terminal, taskOutcome: "unknown" };
  }
  if (state.control.status === "terminate-requested") {
    return { status: "terminated", disposition: "terminated", terminal, taskOutcome: "unknown" };
  }
  if (state.control.status === "interrupted" && state.control.mode === "process-abort") {
    return { status: "aborted", disposition: "aborted", terminal, taskOutcome: "unknown" };
  }
  if (state.startFailure) {
    return { status: "failed", disposition: "transport-failed", terminal: true, taskOutcome: "unknown" };
  }
  if (state.transportFailure) {
    return { status: "failed", disposition: "transport-failed", terminal, taskOutcome: "unknown" };
  }
  if (state.completionIntent?.reason === "agent-error") {
    return { status: "failed", disposition: "agent-error", terminal, taskOutcome: "unknown" };
  }
  if (state.process.status === "exited") {
    const normalExit = state.process.exit?.kind === "native"
      ? state.process.exit.code === 0 && state.process.exit.signal === null
      : state.process.exit?.kind === "shell" && state.process.exit.shellStatus === 0;
    const gracefulHandshake = state.completionIntent !== null && state.execution.status === "settled";
    if (!normalExit || !gracefulHandshake) {
      return { status: "abnormal", disposition: "abnormal-exit", terminal: true, taskOutcome: "unknown" };
    }
    return { status: "completed", disposition: "completed", terminal: true, taskOutcome: "unknown" };
  }
  if (state.control.status === "interrupted") {
    return { status: "interrupted", disposition: "interrupted", terminal: false, taskOutcome: "unknown" };
  }
  if (state.completionIntent) {
    return { status: "finishing", disposition: "pending", terminal: false, taskOutcome: "unknown" };
  }
  if (state.execution.status === "settled") {
    return { status: "waiting", disposition: "pending", terminal: false, taskOutcome: "unknown" };
  }
  if (state.execution.status === "launching") {
    return { status: "launching", disposition: "pending", terminal: false, taskOutcome: "unknown" };
  }
  if (state.execution.status === "active" || state.execution.status === "settling") {
    return { status: "running", disposition: "pending", terminal: false, taskOutcome: "unknown" };
  }
  return { status: "idle", disposition: "pending", terminal: false, taskOutcome: "unknown" };
}

function describeAbnormalExit(exit: AgentProcessExit | undefined): string {
  if (!exit) return "Process exit was observed without exit details";
  if (exit.kind === "shell") {
    return `Shell command exited with status ${exit.shellStatus} without a graceful completion handshake`;
  }
  if (exit.kind === "process-not-found") {
    return "Owned process is no longer present, but its exit status is unavailable";
  }
  return exit.signal
    ? `Native process exited from signal ${exit.signal} without a graceful completion handshake`
    : `Native process exited with code ${exit.code ?? "unknown"} without a graceful completion handshake`;
}

/**
 * Returns a completion only when lifecycle projection is terminal. Callers must
 * retain the run when this returns undefined; the helper never manufactures a
 * successful result from nonterminal evidence.
 */
export function projectAgentRunCompletion(
  state: AgentRunState,
  input: AgentRunCompletionInput,
): AgentRunCompletion | undefined {
  const projected = projectAgentRunStatus(state);
  if (!projected.terminal) return undefined;

  const execution = projected.disposition === "completed"
    ? "normal-exit"
    : projected.disposition === "agent-error"
      ? "agent-error"
      : projected.disposition === "aborted"
        ? "aborted"
        : projected.disposition === "timed-out"
          ? "timed-out"
          : projected.disposition === "terminated"
            ? "terminated"
            : "transport-failure";
  const abnormalExitMessage = projected.disposition === "abnormal-exit" && state.process.status === "exited"
    ? describeAbnormalExit(state.process.exit)
    : undefined;
  const errorMessage = input.errorMessage ?? state.startFailure?.message ?? state.transportFailure?.message ?? abnormalExitMessage;

  return deepFreeze({
    runId: state.runId,
    execution,
    output: input.output,
    taskOutcome: "unknown",
    settled: state.execution.status === "settled",
    ...(state.process.status === "exited" && state.process.exit !== undefined
      ? { processExit: structuredClone(state.process.exit) }
      : {}),
    ...(input.sessionRef === undefined ? {} : { sessionRef: input.sessionRef }),
    ...(errorMessage === undefined ? {} : { errorMessage }),
    ...(input.usage === undefined ? {} : { usage: structuredClone(input.usage) }),
  });
}
