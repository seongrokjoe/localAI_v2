import assert from "node:assert/strict";
import {
  assertChatRequestFits,
  createTokenBudget,
  estimateChatInputTokens,
  estimateTokens,
  sliceTextToTokens,
  TokenBudgetConfigurationError,
  TokenBudgetExceededError,
  truncateToTokens,
} from "../dist/tokenBudget.js";

const budget = createTokenBudget(200000, 60000);
assert.deepEqual(budget, {
  contextWindowTokens: 200000,
  outputTokens: 60000,
  safetyTokens: 10000,
  inputTokens: 130000,
});
assert.equal(budget.inputTokens + budget.outputTokens + budget.safetyTokens, 200000);

assert.equal(estimateTokens("abcdefgh"), 4);
assert.equal(estimateTokens("가나다라"), 4);
assert.equal(estimateTokens("ab가나"), 3);
assert.ok(estimateTokens(truncateToTokens("가".repeat(100), 20)) <= 20);
assert.ok(estimateTokens(sliceTextToTokens("x".repeat(100), 20)) <= 20);

assert.throws(() => createTokenBudget(8000, 1024), TokenBudgetConfigurationError);

const messages = [{ role: "user", content: "x".repeat(1000) }];
const tools = [{
  type: "function",
  function: {
    name: "readFile",
    description: "read",
    parameters: { type: "object", properties: { path: { type: "string" } } },
  },
}];
const requestEstimate = estimateChatInputTokens(messages, tools);
assert.ok(requestEstimate > estimateTokens(messages[0].content));
assert.equal(assertChatRequestFits(messages, tools, createTokenBudget(20000, 4096)), requestEstimate);
assert.throws(
  () => assertChatRequestFits(messages, tools, { contextWindowTokens: 2000, outputTokens: 1000, safetyTokens: 500, inputTokens: 100 }),
  TokenBudgetExceededError,
);

console.log("Token budget tests passed.");
