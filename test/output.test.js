import assert from "node:assert/strict";
import test from "node:test";

import { extractLatestAssistantOutput } from "../dist/index.js";

const assistant = (content, extra = {}) => ({
  type: "message",
  message: { role: "assistant", content, stopReason: "stop", ...extra },
});

test("joins every text block from the latest assistant message in order", () => {
  const result = extractLatestAssistantOutput([
    assistant([{ type: "text", text: "stale" }]),
    { type: "message", message: { role: "toolResult", content: [] } },
    assistant([
      { type: "thinking", thinking: "hidden" },
      { type: "text", text: "first" },
      { type: "toolCall", id: "call-1", name: "read", arguments: {} },
      { type: "text", text: "second" },
    ]),
  ]);

  assert.deepEqual(result, { output: "first\nsecond" });
});

test("a latest terminal assistant error never falls back to stale output", () => {
  const result = extractLatestAssistantOutput([
    assistant([{ type: "text", text: "stale success" }]),
    assistant([], { stopReason: "error", errorMessage: "provider failed" }),
  ]);

  assert.deepEqual(result, { output: "", errorMessage: "provider failed" });
});

test("accepts current Pi messages directly as well as session message entries", () => {
  const result = extractLatestAssistantOutput([
    assistant([{ type: "text", text: "entry" }]),
    { role: "assistant", content: [{ type: "text", text: "message" }], stopReason: "aborted", errorMessage: "stopped" },
  ]);

  assert.deepEqual(result, { output: "message" });
});

test("returns empty output when there is no assistant message", () => {
  assert.deepEqual(extractLatestAssistantOutput([{ type: "session", version: 3 }]), { output: "" });
});
