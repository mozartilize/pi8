/**
 * Counterfactual baseline selection and token pricing for `/router-report`.
 *
 * Pure and shared by both spend-recording paths (parent turns in
 * `provider.ts`/`delegation.ts` and foreground subagent children in
 * `subagent-spend.ts`) so the two can never drift into pricing the same
 * question on different rules.
 */
import type { Candidate, Dimension } from '../types.js';
import { capabilityForDimension } from '../routing/score/scorer.js';

export interface BaselinePick {
  registryId: string;
  source: 'config' | 'auto';
  cost?: Candidate['cost'];
}

export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Resolve the model this work is priced against: a config pin when it is
 * still in the routable pool, else the highest measured capability on the
 * work's own dimension axis. Price is only a tiebreak for a pool with no
 * benchmark coverage at all — an expensive unmeasured model is not evidence
 * of strength, so it must never outrank a measured one.
 */
export function pickBaseline(
  candidates: readonly Candidate[],
  dimension: Dimension,
  configBaselineModel?: string,
): BaselinePick | undefined {
  const pinned = configBaselineModel
    ? candidates.find((c) => c.registryId === configBaselineModel)
    : undefined;
  const byCapability = candidates.reduce<Candidate | undefined>((best, c) => {
    const cq = capabilityForDimension(c, dimension);
    if (cq == null) return best;
    const bq = best ? capabilityForDimension(best, dimension) : undefined;
    return bq == null || cq > bq ? c : best;
  }, undefined);
  const byPrice = candidates.reduce<Candidate | undefined>((best, c) => {
    const cp = c.cost?.output ?? c.cost?.input;
    if (cp == null) return best;
    const bp = best ? (best.cost?.output ?? best.cost?.input) : undefined;
    return bp == null || cp > bp ? c : best;
  }, undefined);
  const chosen = pinned ?? byCapability ?? byPrice;
  if (!chosen) return undefined;
  return {
    registryId: chosen.registryId,
    source: pinned ? 'config' : 'auto',
    cost: chosen.cost,
  };
}

/**
 * Price observed tokens at registry rates. Registry `cost.*` are USD per 1M
 * tokens (Pi's own accounting divides by 1e6 before multiplying by observed
 * token counts), so pricing here divides by the same constant — otherwise the
 * report inflates spend by a factor of a million. Cache tokens fall back to
 * the input rate when the provider publishes no separate cache price, so a
 * model with unpublished cache rates is never counted as serving cache for
 * free. Undefined when the model publishes no price at all — an unpriced
 * model is excluded from the report rather than counted as $0.
 */
const TOKENS_PER_PRICE_UNIT = 1_000_000;

export function priceTokens(
  cost: Candidate['cost'] | undefined,
  usage: TokenTotals,
): number | undefined {
  if (!cost) return undefined;
  return (
    (cost.input ?? 0) * usage.inputTokens +
    (cost.output ?? 0) * usage.outputTokens +
    (cost.cacheRead ?? cost.input ?? 0) * usage.cacheRead +
    (cost.cacheWrite ?? cost.input ?? 0) * usage.cacheWrite
  ) / TOKENS_PER_PRICE_UNIT;
}
