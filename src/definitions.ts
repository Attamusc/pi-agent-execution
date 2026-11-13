import { LineCounter, parseDocument } from "yaml";

import { isThinkingLevel } from "./internal.js";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type Diagnostic = Readonly<{
  path: string;
  field?: string;
  location?: Readonly<{ line: number; column: number }>;
  message: string;
}>;

export type AgentDefinitionPolicy = Readonly<{
  fallbackName?: string;
  requiredFields: readonly ("name" | "description")[];
}>;

export type AgentRunner = "pi" | "copilot";

// Supplied by host discovery, never taken from frontmatter. Paths must already
// have been canonicalized by that host; this library performs no filesystem IO.
export type DefinitionOrigin = Readonly<{
  kind: "global-user" | "installed-package" | "project";
  canonicalPath: string;
  canonicalRoot: string;
}>;

export type NativeMcpServer = Readonly<{ command: string; args: readonly string[]; env?: Readonly<Record<string, string>> }>;
export type NativeAgentPolicy = Readonly<{
  runnerVersion: string;
  workspaceTrust: "existing" | "session";
  allow: readonly string[];
  deny: readonly string[];
  mcp: Readonly<Record<string, NativeMcpServer>>;
}>;

export type SystemPrompt = Readonly<{ mode?: "append" | "replace"; text: string }>;

export type NormalizedAgentDefinition = Readonly<{
  name: string;
  runner?: AgentRunner;
  origin?: DefinitionOrigin;
  native?: NativeAgentPolicy;
  description?: string;
  model?: string;
  thinking?: ThinkingLevel;
  tools?: readonly string[];
  skills?: readonly string[];
  systemPrompt?: SystemPrompt;
  cwd?: string;
  metadata: Readonly<Record<string, unknown>>;
}>;

export type ParseAgentDefinitionResult =
  | Readonly<{ ok: true; definition: NormalizedAgentDefinition; diagnostics: readonly Diagnostic[] }>
  | Readonly<{ ok: false; diagnostics: readonly Diagnostic[] }>;

const normalizedKeys = new Set(["name", "description", "model", "thinking", "tools", "skill", "skills", "system-prompt", "cwd"]);

function fieldLocation(frontmatter: string, field: string): { line: number; column: number } | undefined {
  const lines = frontmatter.split("\n");
  const line = lines.findIndex((value) => new RegExp(`^\\s*${field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`).test(value));
  if (line < 0) return undefined;
  return { line: line + 2, column: lines[line].search(/\S/) + 1 };
}

function commaList(value: string | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  return entries.length > 0 ? entries : undefined;
}

export function parseAgentDefinition(
  source: Readonly<{ path: string; content: string; origin?: DefinitionOrigin }>,
  policy: AgentDefinitionPolicy,
): ParseAgentDefinitionResult {
  const diagnostics: Diagnostic[] = [];
  const match = source.content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    return { ok: false, diagnostics: [{ path: source.path, location: { line: 1, column: 1 }, message: "Agent definition must begin with YAML frontmatter" }] };
  }

  const frontmatter = match[1];
  const lineCounter = new LineCounter();
  const document = parseDocument(frontmatter, { lineCounter, prettyErrors: false });
  if (document.errors.length > 0) {
    return {
      ok: false,
      diagnostics: document.errors.map((error) => {
        const position = error.linePos?.[0] ?? (error.pos[0] === undefined ? undefined : lineCounter.linePos(error.pos[0]));
        return {
          path: source.path,
          location: position ? { line: position.line + 1, column: position.col } : undefined,
          message: error.message,
        };
      }),
    };
  }

  let parsed: unknown;
  try {
    parsed = document.toJS();
  } catch (error) {
    return {
      ok: false,
      diagnostics: [{
        path: source.path,
        location: { line: 2, column: 1 },
        message: error instanceof Error ? error.message : "Unable to convert agent frontmatter",
      }],
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, diagnostics: [{ path: source.path, location: { line: 2, column: 1 }, message: "Agent frontmatter must be a mapping" }] };
  }
  const frontmatterValues = parsed as Record<string, unknown>;

  const stringField = (field: string): string | undefined => {
    const value = frontmatterValues[field];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") {
      diagnostics.push({ path: source.path, field, location: fieldLocation(frontmatter, field), message: `Field '${field}' must be a string` });
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };

  const declaredName = stringField("name");
  const name = declaredName ?? policy.fallbackName;
  const description = stringField("description");
  const model = stringField("model");
  const thinkingValue = stringField("thinking");
  const tools = commaList(stringField("tools"));
  const skills = commaList(stringField("skill") ?? stringField("skills"));
  const cwd = stringField("cwd");
  const promptModeValue = stringField("system-prompt");

  let thinking: ThinkingLevel | undefined;
  if (thinkingValue !== undefined) {
    if (isThinkingLevel(thinkingValue)) thinking = thinkingValue;
    else diagnostics.push({ path: source.path, field: "thinking", location: fieldLocation(frontmatter, "thinking"), message: `Invalid thinking level '${thinkingValue}'` });
  }

  let promptMode: "append" | "replace" | undefined;
  if (promptModeValue !== undefined) {
    if (promptModeValue === "append" || promptModeValue === "replace") promptMode = promptModeValue;
    else diagnostics.push({ path: source.path, field: "system-prompt", location: fieldLocation(frontmatter, "system-prompt"), message: `Invalid system prompt mode '${promptModeValue}'` });
  }

  for (const field of new Set(["name" as const, ...policy.requiredFields])) {
    const value = field === "name" ? name : description;
    if (value === undefined) diagnostics.push({ path: source.path, field, message: `Required field '${field}' is missing` });
  }
  let nativeFields: Pick<NormalizedAgentDefinition, "runner" | "origin" | "native"> = {};
  try {
    nativeFields = parseRunnerPolicy(frontmatterValues, source.origin);
  } catch (error) {
    diagnostics.push({ path: source.path, message: error instanceof Error ? error.message : "Invalid native policy" });
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const body = source.content.slice(match[0].length).trim();
  const metadata = Object.fromEntries(Object.entries(frontmatterValues).filter(([key]) => !normalizedKeys.has(key) && !nativeKeys.has(key)));
  const definition: NormalizedAgentDefinition = {
    name: name!,
    ...nativeFields,
    ...(description === undefined ? {} : { description }),
    ...(model === undefined ? {} : { model }),
    ...(thinking === undefined ? {} : { thinking }),
    ...(tools === undefined ? {} : { tools }),
    ...(skills === undefined ? {} : { skills }),
    ...(body.length === 0 && promptMode === undefined
      ? {}
      : { systemPrompt: { ...(promptMode === undefined ? {} : { mode: promptMode }), text: body } }),
    ...(cwd === undefined ? {} : { cwd }),
    metadata,
  };
  return { ok: true, definition, diagnostics };
}

const nativeKeys = new Set(["runner", "runner-version", "workspace-trust", "native-allow", "native-deny", "mcp"]);

function canonicalAbsolute(value: string): boolean {
  return value.startsWith("/") && !value.includes("\\") && !value.includes("\0") &&
    !value.split("/").slice(1).some((part) => part === "." || part === ".." || part === "");
}

export function validateDefinitionOrigin(origin: DefinitionOrigin | undefined): void {
  if (!origin || !["global-user", "installed-package", "project"].includes(origin.kind) ||
      !canonicalAbsolute(origin.canonicalPath) || !canonicalAbsolute(origin.canonicalRoot) ||
      !origin.canonicalPath.startsWith(`${origin.canonicalRoot}/`)) {
    throw new TypeError("Definition requires host-verified canonical origin containment");
  }
}

export function requireTrustedNativeOrigin(origin: DefinitionOrigin | undefined): void {
  validateDefinitionOrigin(origin);
  if (origin!.kind === "project") throw new TypeError("Project definitions cannot enable native policy");
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim() && !item.includes("\0"))) {
    throw new TypeError(`${field} must be an array of nonblank strings`);
  }
  return value;
}

function parseRunnerPolicy(values: Record<string, unknown>, origin?: DefinitionOrigin): Pick<NormalizedAgentDefinition, "runner" | "origin" | "native"> {
  if (origin !== undefined) validateDefinitionOrigin(origin);
  const runner = values.runner;
  if (runner !== undefined && runner !== "pi" && runner !== "copilot") throw new TypeError(`Unknown runner '${String(runner)}'`);
  const privileged = [...nativeKeys].some((key) => key !== "runner" && Object.hasOwn(values, key));
  if (privileged && runner !== "copilot") throw new TypeError("Native policy requires runner: copilot");
  if (runner !== "copilot") return { ...(runner === undefined ? {} : { runner }), ...(origin === undefined ? {} : { origin: structuredClone(origin) }) };
  requireTrustedNativeOrigin(origin);
  if (values["auto-exit"] !== true || values.interactive !== false ||
      (values["session-mode"] !== undefined && values["session-mode"] !== "new")) {
    throw new TypeError("Copilot requires auto-exit: true, interactive: false and no fork/retained session mode");
  }
  for (const field of ["tools", "deny-tools", "provider", "cli", "command", "args", "argv"]) {
    if (Object.hasOwn(values, field)) throw new TypeError(`Copilot does not support '${field}' overrides`);
  }
  if (typeof values["runner-version"] !== "string" || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(values["runner-version"])) {
    throw new TypeError("Copilot requires a pinned runner-version");
  }
  const workspaceTrust = values["workspace-trust"];
  if (workspaceTrust !== "existing" && workspaceTrust !== "session") throw new TypeError("Invalid workspace-trust");
  const allow = strings(values["native-allow"], "native-allow");
  const deny = strings(values["native-deny"] ?? [], "native-deny");
  if (!record(values.mcp ?? {})) throw new TypeError("mcp must be a mapping");
  const mcp: Record<string, NativeMcpServer> = {};
  for (const [name, server] of Object.entries(values.mcp ?? {})) {
    if (!/^[\w-]+$/.test(name) || !record(server) || typeof server.command !== "string" || !server.command.trim() ||
        Object.keys(server).some((key) => !["command", "args", "env"].includes(key))) throw new TypeError(`Invalid MCP server '${name}'`);
    const args = strings(server.args ?? [], `mcp.${name}.args`);
    if (server.env !== undefined && (!record(server.env) || !Object.values(server.env).every((value) => typeof value === "string"))) throw new TypeError("MCP env must contain literal strings");
    for (const value of [server.command, ...args, ...Object.values(server.env ?? {})]) validateNativeTemplate(value as string);
    Object.defineProperty(mcp, name, { value: { command: server.command, args, ...(server.env === undefined ? {} : { env: server.env }) }, enumerable: true });
  }
  return { runner, origin: structuredClone(origin!), native: structuredClone({ runnerVersion: values["runner-version"], workspaceTrust, allow, deny, mcp }) as NativeAgentPolicy };
}

const substitutions = new Set(["home", "node", "parentCwd", "managedSessionId", "env.PI_TODO_PATH"]);
function validateNativeTemplate(value: string): void {
  if (value.includes("\0")) throw new TypeError("Native template contains NUL");
  const rest = value.replace(/\{([^{}]+)\}/g, (_match, key: string) => {
    if (!substitutions.has(key)) throw new TypeError(`Unknown native placeholder '${key}'`);
    return "";
  });
  if (/[{}]/.test(rest)) throw new TypeError("Malformed native placeholder");
}

// Candidates are ordered low to high precedence by the host. Selection never
// combines policy from one source with content from another.
export function selectAgentDefinition(candidates: readonly NormalizedAgentDefinition[]): NormalizedAgentDefinition {
  if (!candidates.length) throw new TypeError("No agent definition candidates");
  if (new Set(candidates.map((candidate) => candidate.name)).size !== 1) throw new TypeError("Definition candidates must have the same name");
  for (const candidate of candidates) {
    if (candidate.origin) validateDefinitionOrigin(candidate.origin);
    if (candidate.runner === "copilot" || candidate.native) requireTrustedNativeOrigin(candidate.origin);
  }
  if (candidates.some((candidate) => candidate.runner === "copilot") && candidates.some((candidate) => candidate.origin?.kind === "project" || !candidate.origin)) {
    throw new TypeError("Project or unprovenanced shadow of a trusted native role is forbidden");
  }
  return candidates[candidates.length - 1];
}

export type NativeBindingContext = Readonly<{
  home: string;
  node: string;
  parentCwd: string;
  managedSessionId: string;
  todoPathLiteral: string;
}>;

export function bindNativeMcp(policy: NativeAgentPolicy, context: NativeBindingContext): Readonly<Record<string, NativeMcpServer>> {
  const values: Record<string, string> = { home: context.home, node: context.node, parentCwd: context.parentCwd, managedSessionId: context.managedSessionId, "env.PI_TODO_PATH": context.todoPathLiteral };
  const expand = (value: string): string => {
    validateNativeTemplate(value);
    return value.replace(/\{([^{}]+)\}/g, (_match, key: string) => {
      const literal = values[key];
      if (typeof literal !== "string" || literal.includes("\0")) throw new TypeError(`Missing literal context '${key}'`);
      return literal;
    });
  };
  return Object.fromEntries(Object.entries(policy.mcp).map(([name, server]) => [name, { command: expand(server.command), args: server.args.map(expand), ...(server.env === undefined ? {} : { env: Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, expand(value)])) }) }]));
}
