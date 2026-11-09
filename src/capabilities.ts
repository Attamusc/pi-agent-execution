export type AgentRunCapabilities = Readonly<{
  session: "ephemeral" | "persistent";
  progress: "pi-json-events" | "activity-snapshot";
  interrupt: "process-abort" | "turn-escape";
  termination: "process-signal" | "herdr-pane-close" | "core-terminal-kill";
  timeout: "process-deadline" | "unsupported";
  resume: "unsupported" | "pi-session-file";
  fork: "unsupported" | "seeded-pi-session";
  interaction: "none" | "user-takeover";
}>;

export const workflowHeadlessCapabilities = {
  session: "ephemeral",
  progress: "pi-json-events",
  interrupt: "process-abort",
  termination: "process-signal",
  timeout: "process-deadline",
  resume: "unsupported",
  fork: "unsupported",
  interaction: "none",
} as const satisfies AgentRunCapabilities;

export const visibleHerdrCapabilities = {
  session: "persistent",
  progress: "activity-snapshot",
  interrupt: "turn-escape",
  termination: "herdr-pane-close",
  timeout: "unsupported",
  resume: "pi-session-file",
  fork: "seeded-pi-session",
  interaction: "user-takeover",
} as const satisfies AgentRunCapabilities;

export const visibleHerdrCoreCapabilities = {
  ...visibleHerdrCapabilities,
  termination: "core-terminal-kill",
} as const satisfies AgentRunCapabilities;

export class UnsupportedAgentRunCapability extends Error {
  readonly capability: keyof AgentRunCapabilities;

  constructor(capability: keyof AgentRunCapabilities) {
    super(`Agent run capability '${capability}' is unsupported`);
    this.name = "UnsupportedAgentRunCapability";
    this.capability = capability;
  }
}

export function requireCapability<
  Profile extends AgentRunCapabilities,
  Capability extends keyof AgentRunCapabilities,
>(profile: Profile, capability: Capability): Exclude<Profile[Capability], "unsupported"> {
  const mode = profile[capability];
  if (mode === "unsupported") throw new UnsupportedAgentRunCapability(capability);
  return mode as Exclude<Profile[Capability], "unsupported">;
}
