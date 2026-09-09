import type { NormalizedAgentDefinition, ThinkingLevel } from "./definitions.js";
import { deepFreeze, isThinkingLevel } from "./internal.js";

export type AgentLaunchOverrides = Readonly<{
  model?: string;
  thinking?: string;
  tools?: readonly string[];
  skills?: readonly string[];
  systemPrompt?: Readonly<{ mode: "append" | "replace"; text: string }>;
  cwd?: string;
}>;

export type AgentLaunchIntent = Readonly<{
  definition: NormalizedAgentDefinition;
  task: string;
  cwd: string;
  effective: Readonly<{
    model?: string;
    thinking?: ThinkingLevel;
    tools?: readonly string[];
    skills?: readonly string[];
    systemPrompt?: Readonly<{ mode: "append" | "replace"; text: string }>;
  }>;
}>;

function nonblank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveAgentLaunchIntent(
  definition: NormalizedAgentDefinition,
  task: string,
  callerCwd: string,
  overrides: AgentLaunchOverrides = {},
): AgentLaunchIntent {
  const explicitThinking = nonblank(overrides.thinking);
  if (explicitThinking !== undefined && !isThinkingLevel(explicitThinking)) {
    throw new TypeError(`Invalid thinking level '${explicitThinking}'`);
  }

  const model = nonblank(overrides.model) ?? definition.model;
  const thinking = (explicitThinking as ThinkingLevel | undefined) ?? definition.thinking;
  const tools = overrides.tools ?? definition.tools;
  const skills = overrides.skills ?? definition.skills;
  const overridePrompt = overrides.systemPrompt && nonblank(overrides.systemPrompt.text)
    ? { mode: overrides.systemPrompt.mode, text: overrides.systemPrompt.text.trim() }
    : undefined;
  const systemPrompt = overridePrompt ?? definition.systemPrompt;
  const cwd = nonblank(overrides.cwd) ?? definition.cwd ?? callerCwd;

  const intent = structuredClone({
    definition,
    task,
    cwd,
    effective: {
      ...(model === undefined ? {} : { model }),
      ...(thinking === undefined ? {} : { thinking }),
      ...(tools === undefined ? {} : { tools }),
      ...(skills === undefined ? {} : { skills }),
      ...(systemPrompt === undefined ? {} : { systemPrompt }),
    },
  }) as AgentLaunchIntent;
  return deepFreeze(intent);
}
