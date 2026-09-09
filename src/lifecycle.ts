import type { AgentLaunchIntent } from "./resolve.js";

export type CompletionReason = "done" | "auto-exit" | "ping" | "agent-error";
export type InterruptMode = "process-abort" | "turn-escape";
export type TerminationMode = "process-signal" | "herdr-pane-close";

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
  | Evidence<"progress", { activity?: string; estimated: boolean }>
  | Evidence<"turn-ended", { turnIndex?: number; stopReason?: string }>
  | Evidence<"agent-ended", { willRetry?: boolean }>
  | Evidence<"agent-settled", Record<string, never>>
  | Evidence<"completion-requested", { reason: CompletionReason }>
  | Evidence<"session-shutdown", { reason: string }>
  | Evidence<"process-exited", { code: number | null; signal: string | null }>
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
    status: "not-started" | "starting" | "running" | "exited";
    code?: number | null;
    signal?: string | null;
  }>;
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

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function createAgentRunState(runId: string): AgentRunState {
  if (!runId.trim()) throw new TypeError("runId must not be blank");
  return deepFreeze({
    runId,
    execution: { status: "idle" },
    completionIntent: null,
    session: { status: "unknown" },
    process: { status: "not-started" },
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
  let control = state.control;
  let transportFailure = state.transportFailure;

  switch (evidence.kind) {
    case "launch-requested":
      if (execution.status === "idle") execution = { status: "launching" };
      if (process.status === "not-started") process = { status: "starting" };
      break;
    case "host-started":
      if (execution.status === "idle" || execution.status === "launching") {
        execution = { status: "active" };
      }
      if (session.status !== "closed") session = { status: "open", hostRef: evidence.hostRef };
      if (process.status !== "exited") process = { status: "running" };
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
      if (process.status !== "exited") {
        process = { status: "exited", code: evidence.code, signal: evidence.signal };
      }
      break;
    case "timeout-fired":
      control = { status: "timed-out", timeoutMs: evidence.timeoutMs };
      break;
    case "interrupt-requested":
      if (
        control.status === "none" ||
        (control.status === "interrupted" && evidence.mode === "process-abort")
      ) {
        control = { status: "interrupted", mode: evidence.mode };
      }
      break;
    case "terminate-requested":
      if (control.status !== "timed-out") {
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
    (state.transportFailure !== null && state.process.status === "not-started");

  if (state.transportFailure) {
    return { status: "failed", disposition: "transport-failed", terminal, taskOutcome: "unknown" };
  }
  if (state.completionIntent?.reason === "agent-error") {
    return { status: "failed", disposition: "agent-error", terminal, taskOutcome: "unknown" };
  }
  if (state.control.status === "timed-out") {
    return { status: "timed-out", disposition: "timed-out", terminal, taskOutcome: "unknown" };
  }
  if (state.control.status === "terminate-requested") {
    return { status: "terminated", disposition: "terminated", terminal, taskOutcome: "unknown" };
  }
  if (state.control.status === "interrupted" && state.control.mode === "process-abort") {
    return { status: "aborted", disposition: "aborted", terminal, taskOutcome: "unknown" };
  }
  if (state.process.status === "exited") {
    const normalExit = state.process.code === 0 && state.process.signal === null;
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
