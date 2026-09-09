import { LineCounter, parseDocument } from "yaml";

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

export type NormalizedAgentDefinition = Readonly<{
  name: string;
  description?: string;
  model?: string;
  thinking?: ThinkingLevel;
  tools?: readonly string[];
  skills?: readonly string[];
  systemPrompt?: Readonly<{ mode: "append" | "replace"; text: string }>;
  cwd?: string;
  metadata: Readonly<Record<string, unknown>>;
}>;

export type ParseAgentDefinitionResult =
  | Readonly<{ ok: true; definition: NormalizedAgentDefinition; diagnostics: readonly Diagnostic[] }>
  | Readonly<{ ok: false; diagnostics: readonly Diagnostic[] }>;

const thinkingLevels = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
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
  source: Readonly<{ path: string; content: string }>,
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
        const position = error.linePos?.[0];
        return {
          path: source.path,
          location: position ? { line: position.line + 1, column: position.col } : undefined,
          message: error.message,
        };
      }),
    };
  }

  const parsed: unknown = document.toJS();
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
    if (thinkingLevels.has(thinkingValue as ThinkingLevel)) thinking = thinkingValue as ThinkingLevel;
    else diagnostics.push({ path: source.path, field: "thinking", location: fieldLocation(frontmatter, "thinking"), message: `Invalid thinking level '${thinkingValue}'` });
  }

  let promptMode: "append" | "replace" = "append";
  if (promptModeValue !== undefined) {
    if (promptModeValue === "append" || promptModeValue === "replace") promptMode = promptModeValue;
    else diagnostics.push({ path: source.path, field: "system-prompt", location: fieldLocation(frontmatter, "system-prompt"), message: `Invalid system prompt mode '${promptModeValue}'` });
  }

  for (const field of new Set(["name" as const, ...policy.requiredFields])) {
    const value = field === "name" ? name : description;
    if (value === undefined) diagnostics.push({ path: source.path, field, message: `Required field '${field}' is missing` });
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const body = source.content.slice(match[0].length).trim();
  const metadata = Object.fromEntries(Object.entries(frontmatterValues).filter(([key]) => !normalizedKeys.has(key)));
  const definition: NormalizedAgentDefinition = {
    name: name!,
    ...(description === undefined ? {} : { description }),
    ...(model === undefined ? {} : { model }),
    ...(thinking === undefined ? {} : { thinking }),
    ...(tools === undefined ? {} : { tools }),
    ...(skills === undefined ? {} : { skills }),
    ...(body.length === 0 ? {} : { systemPrompt: { mode: promptMode, text: body } }),
    ...(cwd === undefined ? {} : { cwd }),
    metadata,
  };
  return { ok: true, definition, diagnostics };
}
