export const contractVersion = 1 as const;

export {
  UnsupportedAgentRunCapability,
  requireCapability,
  visibleHerdrCapabilities,
  workflowHeadlessCapabilities,
  type AgentRunCapabilities,
} from "./capabilities.js";

export {
  parseAgentDefinition,
  type AgentDefinitionPolicy,
  type Diagnostic,
  type NormalizedAgentDefinition,
  type ParseAgentDefinitionResult,
  type ThinkingLevel,
} from "./definitions.js";

export {
  resolveAgentLaunchIntent,
  type AgentLaunchIntent,
  type AgentLaunchOverrides,
} from "./resolve.js";

export {
  createAgentRunState,
  projectAgentRunStatus,
  reduceAgentRunEvidence,
  type AgentRunDisposition,
  type AgentRunEvidence,
  type AgentRunProjectedStatus,
  type AgentRunState,
  type CompletionReason,
  type InterruptMode,
  type TerminationMode,
} from "./lifecycle.js";
