// Pure tests for pricing a request to Claude (src/lib/aiPricing.ts), which the
// AI add-on's £15 allowance is counted in.
import assert from "node:assert/strict";
import { aiCostUsdMicros, usageFromMessage, type AiCallUsage } from "../src/lib/aiPricing";

const base: AiCallUsage = {
  requestedModel: "claude-opus-5-5",
  model: "claude-opus-5-5",
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  webSearches: 0,
};

// Tokens times dollars per million tokens gives millionths of a dollar.
assert.equal(aiCostUsdMicros({ ...base, inputTokens: 1800, outputTokens: 900 }), 1800 * 4 + 900 * 20);
assert.equal(aiCostUsdMicros({ ...base, cacheReadTokens: 1000, cacheWriteTokens: 1000 }), 1000 * 0.2 + 1000 * 5);
assert.equal(aiCostUsdMicros({ ...base, webSearches: 3 }), 30_000, "web searches are 1 cent each");
assert.equal(aiCostUsdMicros({ ...base, inputTokens: 1, outputTokens: 0, model: "claude-haiku-5-5", requestedModel: "claude-haiku-5-5" }), 1, "part-micros round up");

// A fallback is never cheaper than what was asked for, and unknown models get the dearest rates.
assert.equal(aiCostUsdMicros({ ...base, inputTokens: 1000, model: "claude-sonnet-5-5" }), 4000);
assert.equal(aiCostUsdMicros({ ...base, inputTokens: 1000, model: "claude-fable-5-1" }), 10_000);
assert.equal(aiCostUsdMicros({ ...base, inputTokens: 1000, model: "claude-new-model", requestedModel: "claude-new-model" }), 10_000);

// Haiku is dearer once the prompt passes 100,000 tokens.
const haiku = { ...base, model: "claude-haiku-5-5", requestedModel: "claude-haiku-5-5" };
assert.equal(aiCostUsdMicros({ ...haiku, inputTokens: 100_000 }), 10_000);
assert.equal(aiCostUsdMicros({ ...haiku, inputTokens: 100_001 }), Math.ceil(100_001 * 0.5));

// Reading usage from a reply, including missing fields.
assert.deepEqual(
  usageFromMessage({
    model: "claude-opus-4-8",
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40, server_tool_use: { web_search_requests: 2 } },
  }, "claude-opus-5-5"),
  { requestedModel: "claude-opus-5-5", model: "claude-opus-4-8", inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, webSearches: 2 },
);
assert.deepEqual(usageFromMessage({ usage: null }, "claude-opus-5-5"), base);

console.log("AI pricing: all checks passed");
