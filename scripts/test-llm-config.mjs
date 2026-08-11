import assert from "node:assert/strict";
import { buildChatCompletionBody } from "../dist/llmClient.js";
import { normalizeServerProfiles, parseServerProfileId, parseToolCallMode, profileIsComplete } from "../dist/serverProfiles.js";
import { extractFinalResponse, finalResponseTool } from "../dist/requiredToolProtocol.js";

const profiles = normalizeServerProfiles({
  existing: {
    serverUrl: " http://old.internal/v1 ",
    model: " old-model ",
    toolCallMode: "native",
    maxContextTokens: 4000,
    maxOutputTokens: 999999,
    requestTimeoutMs: 5000,
  },
});

assert.deepEqual(profiles.existing, {
  serverUrl: "http://old.internal/v1",
  model: "old-model",
  toolCallMode: "native",
  maxContextTokens: 8000,
  maxOutputTokens: 60000,
  requestTimeoutMs: 10000,
});
assert.equal(profiles.new.toolCallMode, "required");
assert.equal(profileIsComplete(profiles.existing), true);
assert.equal(profileIsComplete(profiles.new), false);
assert.equal(parseServerProfileId("new"), "new");
assert.equal(parseServerProfileId("unexpected"), "existing");
assert.equal(parseToolCallMode("required"), "required");
assert.equal(parseToolCallMode("unexpected"), "auto");

const messages = [{ role: "user", content: "hello" }];
const tools = [{ type: "function", function: { name: "readFile", description: "read", parameters: { type: "object" } } }];
const base = { model: "model-a", maxOutputTokens: 2048 };

assert.deepEqual(buildChatCompletionBody(base, { messages }), {
  model: "model-a",
  messages,
  stream: true,
  max_tokens: 2048,
});
assert.equal(buildChatCompletionBody(base, { messages, tools, toolChoice: "auto" }).tool_choice, "auto");
assert.equal(buildChatCompletionBody(base, { messages, tools, toolChoice: "required" }).tool_choice, "required");
assert.equal(buildChatCompletionBody(base, { messages, tools: [] }).tool_choice, undefined);

assert.equal(finalResponseTool.function.name, "submitFinalResponse");
assert.equal(
  extractFinalResponse({
    id: "final-1",
    type: "function",
    function: { name: "submitFinalResponse", arguments: JSON.stringify({ content: "완료 답변" }) },
  }),
  "완료 답변",
);
assert.equal(
  extractFinalResponse({ id: "final-2", type: "function", function: { name: "submitFinalResponse", arguments: "not-json" } }),
  undefined,
);

console.log("LLM profile normalization and request serialization tests passed.");
