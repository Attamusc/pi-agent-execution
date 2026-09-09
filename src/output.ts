export type AssistantOutput = Readonly<{
  output: string;
  errorMessage?: string;
}>;

export type SessionEntryLike = Readonly<{
  type?: string;
  message?: unknown;
  role?: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
}>;

type AssistantMessageLike = Readonly<{
  role: "assistant";
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
}>;

function assistantMessage(value: SessionEntryLike): AssistantMessageLike | undefined {
  const candidate = value.type === "message" ? value.message : value;
  if (candidate === null || typeof candidate !== "object") return undefined;
  const message = candidate as Record<string, unknown>;
  if (message.role !== "assistant") return undefined;
  return message as AssistantMessageLike;
}

/**
 * Reads either current Pi SessionMessageEntry-shaped values or their contained
 * AgentMessage values. Callers remain responsible for selecting the active
 * session branch before passing entries through this structural seam.
 */
export function extractLatestAssistantOutput(entries: readonly SessionEntryLike[]): AssistantOutput {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const message = assistantMessage(entries[index]);
    if (!message) continue;

    const text = Array.isArray(message.content)
      ? message.content.flatMap((block) => {
          if (block === null || typeof block !== "object") return [];
          const content = block as Record<string, unknown>;
          return content.type === "text" && typeof content.text === "string" ? [content.text] : [];
        })
      : [];
    const output = text.join("\n");
    if (output.length > 0) return { output };

    const terminalError = message.stopReason === "error" || message.stopReason === "aborted";
    return {
      output: "",
      ...(terminalError && message.errorMessage ? { errorMessage: message.errorMessage } : {}),
    };
  }
  return { output: "" };
}
