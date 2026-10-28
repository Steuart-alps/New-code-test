// What a request to Claude costs, from the tokens in its reply. Kept free of
// imports so the AI reading code and its pure tests can use it.

/** US dollars per million tokens, from Anthropic's price list (checked 2026-10-27). */
interface ModelRates { input: number; output: number; cacheRead: number; cacheWrite: number }
const MODEL_RATES: Record<string, ModelRates> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};
/** Claude Haiku 5.5 is dearer for prompts over 100,000 tokens. */
const HAIKU_LONG_RATES: ModelRates = { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 };
/** An unknown model is priced at the dearest rates, so the allowance never under-counts. */
const UNKNOWN_MODEL_RATES = MODEL_RATES["claude-fable-5-1"];
const WEB_SEARCH_USD = 0.01;

export interface AiCallUsage {
  /** The model the request asked for. */
  requestedModel: string;
  /** The model that answered (differs when a server-side fallback ran). */
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches: number;
}

type MessageUsageLike = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number | null } | null;
};

/** The billable parts of a Claude reply. */
export function usageFromMessage(
  message: { model?: string | null; usage?: MessageUsageLike | null },
  requestedModel: string,
): AiCallUsage {
  const usage = message.usage ?? {};
  return {
    requestedModel,
    model: message.model || requestedModel,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    webSearches: usage.server_tool_use?.web_search_requests ?? 0,
  };
}

/**
 * A request together with an earlier one it was sent again after (a declined
 * Claude Haiku list tried on Claude Sonnet). Both sets of tokens are priced at
 * the later request's rates, which are the dearer ones.
 */
export function combinedUsage(usage: AiCallUsage, earlier: AiCallUsage): AiCallUsage {
  return {
    ...usage,
    inputTokens: usage.inputTokens + earlier.inputTokens,
    outputTokens: usage.outputTokens + earlier.outputTokens,
    cacheReadTokens: usage.cacheReadTokens + earlier.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens + earlier.cacheWriteTokens,
    webSearches: usage.webSearches + earlier.webSearches,
  };
}

function ratesFor(model: string, promptTokens: number): ModelRates {
  const known = MODEL_RATES[model];
  if (!known) return UNKNOWN_MODEL_RATES;
  return model === "claude-haiku-5-5" && promptTokens > 100_000 ? HAIKU_LONG_RATES : known;
}

/**
 * What a request cost, in millionths of a dollar. When a fallback model
 * answered, the dearer of the two models' rates is used.
 */
export function aiCostUsdMicros(usage: AiCallUsage): number {
  const prompt = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const cost = (rates: ModelRates) =>
    usage.inputTokens * rates.input
    + usage.outputTokens * rates.output
    + usage.cacheReadTokens * rates.cacheRead
    + usage.cacheWriteTokens * rates.cacheWrite;
  // Tokens × dollars per million tokens = millionths of a dollar.
  const tokens = Math.max(cost(ratesFor(usage.model, prompt)), cost(ratesFor(usage.requestedModel, prompt)));
  return Math.ceil(tokens + usage.webSearches * WEB_SEARCH_USD * 1_000_000);
}
