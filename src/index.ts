export const contractVersion = 2 as const;

export {
  copilotJobCapabilities,
  claudeJobCapabilities,
  UnsupportedAgentRunCapability,
  requireCapability,
  visibleHerdrCapabilities,
  visibleHerdrCoreCapabilities,
  workflowHeadlessCapabilities,
  type AgentRunCapabilities,
} from "./capabilities.js";

export {
  parseAgentDefinition,
  selectAgentDefinition,
  validateDefinitionOrigin,
  requireTrustedNativeOrigin,
  bindNativeMcp,
  type AgentRunner,
  type DefinitionOrigin,
  type NativeAgentPolicy,
  type NativeMcpServer,
  type NativeBindingContext,
  type NativeRuntimeContext,
  type NativeScopeBindings,
  type AgentDefinitionPolicy,
  type Diagnostic,
  type NormalizedAgentDefinition,
  type ParseAgentDefinitionResult,
  type SystemPrompt,
  type ThinkingLevel,
} from "./definitions.js";

export {
  resolveAgentLaunchIntent,
  resolveManagedNativeResume,
  type NativeSessionReference,
  type NativeSkillSnapshot,
  type ManagedNativeSessionRecord,
  type ManagedNativeResumeInput,
  type AgentLaunchIntent,
  type AgentLaunchOverrides,
} from "./resolve.js";

export {
  createAgentRunState,
  projectAgentRunCompletion,
  projectAgentRunStatus,
  reduceAgentRunEvidence,
  type AgentProcessExit,
  type AgentRequestTimeout,
  type AgentRunCompletion,
  type AgentRunCompletionInput,
  type AgentRunDisposition,
  type AgentRunEvidence,
  type AgentRunProjectedStatus,
  type AgentRunState,
  type AgentRunUsage,
  type CompletionReason,
  type InterruptMode,
  type ProcessExit,
  type TerminationMode,
} from "./lifecycle.js";

export {
  extractLatestAssistantOutput,
  type AssistantOutput,
  type SessionEntryLike,
} from "./output.js";
