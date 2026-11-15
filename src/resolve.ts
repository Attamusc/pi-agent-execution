import { bindNativeMcp, requireTrustedNativeOrigin, type DefinitionOrigin, type NativeRuntimeContext, type NativeScopeBindings, type AgentRunner, type NormalizedAgentDefinition, type SystemPrompt, type ThinkingLevel } from "./definitions.js";
import { deepFreeze, isThinkingLevel } from "./internal.js";

export type AgentLaunchOverrides = Readonly<{
  model?: string;
  thinking?: string;
  tools?: readonly string[];
  skills?: readonly string[];
  systemPrompt?: SystemPrompt;
  cwd?: string;
}>;

export type AgentLaunchIntent = Readonly<{
  definition: NormalizedAgentDefinition;
  task: string;
  runner: AgentRunner;
  cwd: string;
  effective: Readonly<{
    model?: string;
    thinking?: ThinkingLevel;
    tools?: readonly string[];
    skills?: readonly string[];
    systemPrompt?: SystemPrompt;
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
  if (definition.metadata.cli !== undefined && definition.metadata.cli !== "pi") throw new TypeError("Legacy CLI review metadata requires its separate consumer route");
  const runner = definition.runner ?? "pi";
  if (runner !== "pi" && runner !== "copilot" && runner !== "claude") throw new TypeError("Unknown runner");
  if (runner === "copilot" || runner === "claude") {
    requireTrustedNativeOrigin(definition.origin);
    if (!definition.native) throw new TypeError("Missing native policy");
    if (overrides.tools !== undefined || definition.tools !== undefined) throw new TypeError(`${runner} does not support Pi tools`);
    if (definition.metadata.interactive !== false || definition.metadata["auto-exit"] !== true) throw new TypeError(`${runner} requires auto-exit job mode`);
    if (runner === "claude" && (definition.native.workspaceTrust !== "existing" ||
        !Array.isArray(definition.native.nativeTools) || definition.native.nativeTools.some((tool) => !/^[A-Za-z][A-Za-z0-9]*$/.test(tool)) ||
        !["manual", "dontAsk", "plan"].includes(definition.native.permissionMode ?? ""))) throw new TypeError("Invalid Claude native policy");
  } else if (definition.native) throw new TypeError("Native policy conflicts with Pi runner");
  const explicitThinking = nonblank(overrides.thinking);
  if (explicitThinking !== undefined && !isThinkingLevel(explicitThinking)) {
    throw new TypeError(`Invalid thinking level '${explicitThinking}'`);
  }

  const model = nonblank(overrides.model) ?? definition.model;
  const thinking = (explicitThinking as ThinkingLevel | undefined) ?? definition.thinking;
  const tools = overrides.tools ?? definition.tools;
  const skills = overrides.skills ?? definition.skills;
  const inheritedPromptMode = overrides.systemPrompt?.mode ?? definition.systemPrompt?.mode;
  const overridePrompt = overrides.systemPrompt && nonblank(overrides.systemPrompt.text)
    ? {
        ...(inheritedPromptMode === undefined ? {} : { mode: inheritedPromptMode }),
        text: overrides.systemPrompt.text.trim(),
      }
    : undefined;
  const systemPrompt = overridePrompt ?? definition.systemPrompt;
  const cwd = nonblank(overrides.cwd) ?? definition.cwd ?? callerCwd;

  const intent = structuredClone({
    definition,
    runner,
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

export type NativeSessionReference = Readonly<{
  managedSessionId: string;
  cwd: string;
} & (
  | { runner: "copilot"; selector: Readonly<{ kind: "name"; value: string }> }
  | { runner: "claude"; selector: Readonly<{ kind: "uuid"; value: string }> }
)>;

function validNativeSelector(reference: NativeSessionReference): boolean {
  return reference.runner === "copilot"
    ? reference.selector?.kind === "name" && validLiteral(reference.selector.value)
    : reference.runner === "claude" && reference.selector?.kind === "uuid" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reference.selector.value);
}

export type NativeSkillSnapshot = Readonly<{ name: string; body: string; baseDir: string }>;
export type ManagedNativeSessionRecord = Readonly<{
  callerSessionId: string;
  reference: NativeSessionReference;
  definitionOrigin: DefinitionOrigin;
  definitionSha256: string;
  bindings: NativeScopeBindings;
  skills: readonly NativeSkillSnapshot[];
}>;
function validLiteral(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim()) && !value.includes("\0");
}

function validateSkillSnapshots(skills: unknown): asserts skills is readonly NativeSkillSnapshot[] {
  if (!Array.isArray(skills) || skills.some((skill) => !skill || !validLiteral(skill.name) ||
      typeof skill.body !== "string" || !validLiteral(skill.baseDir) || !skill.baseDir.startsWith("/"))) {
    throw new TypeError("Invalid trusted skill snapshots");
  }
}

export type ManagedNativeResumeInput = Readonly<{ managedSessionId: string; agent?: string; message?: string; autoExit?: true }>;

// The host must load/hash the definition from trusted discovery. A snapshot is
// deliberately not accepted as executable policy or as a source of authority.
export function resolveManagedNativeResume(
  input: unknown,
  callerSessionId: string,
  records: readonly ManagedNativeSessionRecord[],
  trusted: Readonly<{ definition: NormalizedAgentDefinition; sha256: string; runtime: NativeRuntimeContext; skills?: readonly NativeSkillSnapshot[] }>,
) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Invalid managed resume input");
  const fields = input as Record<string, unknown>;
  if (Object.keys(fields).some((key) => !["managedSessionId", "agent", "message", "autoExit"].includes(key)) ||
      typeof fields.managedSessionId !== "string" || !fields.managedSessionId.trim() ||
      (fields.agent !== undefined && (typeof fields.agent !== "string" || !fields.agent.trim())) ||
      (fields.message !== undefined && typeof fields.message !== "string") ||
      (fields.autoExit !== undefined && fields.autoExit !== true)) throw new TypeError("Native resume accepts managed ID, optional trusted agent/message and autoExit:true only");
  if (!validLiteral(callerSessionId)) throw new TypeError("Invalid caller identity");
  const matches = records.filter((record) => record?.callerSessionId === callerSessionId && record.reference?.managedSessionId === fields.managedSessionId);
  if (matches.length !== 1) throw new TypeError("Unknown or ambiguous caller-bound managed native session");
  const record = matches[0];
  requireTrustedNativeOrigin(record.definitionOrigin);
  requireTrustedNativeOrigin(trusted.definition.origin);
  if (!validNativeSelector(record.reference) ||
      !validLiteral(record.reference.cwd) || !record.reference.cwd.startsWith("/") ||
      trusted.definition.runner !== record.reference.runner || !trusted.definition.native ||
      !record.bindings || record.bindings.managedSessionId !== record.reference.managedSessionId) throw new TypeError("Invalid native session record or runner");
  validateSkillSnapshots(record.skills);
  // Copy only captured scope data. Runtime values from records are never read,
  // spread into command context, or returned as if they were trusted policy.
  const bindings: NativeScopeBindings = {
    parentCwd: record.bindings.parentCwd,
    managedSessionId: record.bindings.managedSessionId,
    todoPathLiteral: record.bindings.todoPathLiteral,
  };
  if (!trusted.runtime) throw new TypeError("Missing current trusted native runtime");
  const mcp = bindNativeMcp(trusted.definition.native, {
    ...bindings,
    home: trusted.runtime.home,
    node: trusted.runtime.node,
  });
  if (!/^[a-f0-9]{64}$/.test(trusted.sha256) || !/^[a-f0-9]{64}$/.test(record.definitionSha256)) throw new TypeError("Missing verified definition hash");
  if (fields.agent === undefined) {
    if (trusted.sha256 !== record.definitionSha256 || trusted.definition.origin!.kind !== record.definitionOrigin.kind ||
        trusted.definition.origin!.canonicalPath !== record.definitionOrigin.canonicalPath ||
        trusted.definition.origin!.canonicalRoot !== record.definitionOrigin.canonicalRoot) throw new TypeError("Native definition changed; select an explicit trusted profile");
  } else {
    if (fields.agent !== trusted.definition.name) throw new TypeError("Trusted profile selection mismatch");
    validateSkillSnapshots(trusted.skills);
    const names = trusted.definition.skills ?? [];
    if (trusted.skills!.length !== names.length || trusted.skills!.some((skill, index) => skill.name !== names[index])) {
      throw new TypeError("Trusted profile skill snapshots must match declared skills in order");
    }
  }
  const reference: NativeSessionReference = {
    ...(record.reference.runner === "claude"
      ? { runner: "claude" as const, selector: { kind: "uuid" as const, value: record.reference.selector.value } }
      : { runner: "copilot" as const, selector: { kind: "name" as const, value: record.reference.selector.value } }),
    managedSessionId: record.reference.managedSessionId,
    cwd: record.reference.cwd,
  };
  const skills = (fields.agent === undefined ? record.skills : trusted.skills!).map(({ name, body, baseDir }) => ({ name, body, baseDir }));
  const intent = resolveAgentLaunchIntent(trusted.definition, typeof fields.message === "string" ? fields.message : "", reference.cwd, { cwd: reference.cwd });
  return deepFreeze(structuredClone({
    reference,
    definition: intent.definition,
    definitionSha256: trusted.sha256,
    bindings,
    skills,
    mcp,
    intent,
  }));
}
