/**
 * Usage-limit error detection for provider-level blacklisting.
 *
 * When an account's usage cap is exhausted — or a provider is hard-throttling
 * with a plain 429 — every model on that provider fails the same way, so the
 * whole provider is excluded rather than just the failing model (see
 * `blacklistProvider` in blacklist.ts and the delegation loop).
 *
 * The pattern set is drawn from real errors observed in pi session logs plus
 * documented provider API surfaces:
 *
 *  - OpenCode Go: `429 {"type":"GoUsageLimitError","message":"Weekly usage limit
 *    reached. Resets in N days…"}` / `"N-hour usage limit reached…"`; 401
 *    `{"type":"CreditsError","message":"No payment method…"/"Insufficient balance…"}`
 *  - Claude Code CLI: `Claude Code returned an error result: You've hit your
 *    limit · resets …` / `Usage credits are required for this model.`
 *  - Anthropic: plan-limit text (`.…not your plan limits…`)
 *  - OpenAI: `429 insufficient_quota` / `rate_limit_exceeded`; `billing_not_active`
 *  - Google: `429 quota exceeded` / gRPC `RESOURCE_EXHAUSTED`
 *  - DeepSeek / OpenRouter: `402 Insufficient Balance` / `Insufficient Credits`
 *  - any provider: plain `429` status
 *
 * This deliberately mirrors pi-ai's `NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN`
 * (dist/utils/retry.js) and extends it with the plain-429 class per router
 * policy: a 429 is treated as a provider-wide usage-limit signal, not a
 * retryable blip. Model-specific output-limit exhaustion ("output limit
 * reached") is deliberately NOT matched — it proves only that one model ran
 * out of room, not that its provider is unhealthy (AGENTS.md rule 8).
 */
const USAGE_LIMIT_ERROR_PATTERN =
  /GoUsageLimitError|FreeUsageLimitError|CreditsError|usage limit reached|usage cap|available balance|insufficient_quota|quota|out of budget|billing|insufficient balance|insufficient credits|no payment method|hit your limit|usage credits are required|plan limit|RESOURCE_EXHAUSTED|\b402\b|\b429\b|rate.?limit|too many requests/i;

/** True when a provider error message indicates a provider-wide usage limit. */
export const isUsageLimitErrorMessage = (message: string | null | undefined): boolean => {
  if (!message) return false;
  return USAGE_LIMIT_ERROR_PATTERN.test(message);
};
