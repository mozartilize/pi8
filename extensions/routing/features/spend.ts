/**
 * Economic cost proxy of one action and its cost feature.
 *
 * The proxy is the prompt cost of the current request plus the benchmark
 * output cost: the AA output tokens per task at the registry output price.
 * The two terms have different horizons (one invocation and one benchmark
 * task), so the sum is a routing proxy, not the spend of the next invocation.
 * The prompt is split into disjoint buckets: cache read, cache write (only
 * where the registry bills writes) and uncached input. Each prompt token is
 * priced once. Cache savings enter the cost once and nowhere else;
 * nonfinancial continuity is a separate feature. A missing price or a missing
 * output-token count gives an interval, never invented dollars.
 */
import type { CacheRetention } from '@earendil-works/pi-ai';

import type { EffectiveAction } from './actions.js';
import { billedPromptTokens, cacheTtlMs, usableWarmPrefix, type CacheEligibility } from './cache.js';
import { clamp01, usable } from './mapping.js';
import type { Interval } from './schema.js';
import { outputEvidenceDetail, type BenchmarkOutputEvidence } from './benchmark-output.js';
import { FEATURE_MAPPING_VERSION, type FeatureEvidence } from './schema.js';
import type { PriceSnapshot, SpendSnapshot } from './state.js';

export type Pricing = NonNullable<PriceSnapshot['cost']>;

export interface CostBuckets {
  uncachedInput: number;
  cacheRead: number;
  cacheWrite: number;
  /** AA output tokens per task at the action's effort; absent without a measured observation. */
  output?: number;
}

export interface CostProxyV1 {
  priceKnown: boolean;
  /**
   * Absent when the price is unknown, or when the output price is positive
   * and the output-token count is missing: a prompt-only value would then
   * look cheaper than the cost of an action with a measured count.
   */
  centralUSD?: number;
  /** Absent when the price is unknown. With a missing output-token count, the prompt cost at zero output. */
  minUSD?: number;
  /**
   * Absent when `centralUSD` is absent, or when a cache hit is possible and
   * the registry gives no cache-read price. A read can cost more than a miss,
   * so the cost then has no known upper bound.
   */
  maxUSD?: number;
  /** True when a cache hit is possible and the registry gives no cache-read price. */
  cacheReadPriceUnknown?: true;
  cacheHitEstimate: 'uncertain' | 'none';
  cacheEligibility: CacheEligibility;
  tokens: CostBuckets;
}

const perToken = (pricePer1M: number): number => pricePer1M / 1_000_000;

/**
 * Price per token of a prompt token that the cache does not hold. A request at
 * retention `none` writes no cache, so the token is input. A model without a
 * write charge bills the input price. Pi bills a 1h (`long`) cache write at
 * twice the input price; a model writes 1h entries only when it declares a
 * `long` lifetime, else the write is a short write at the write price.
 */
function missPricePerToken(pricing: Pricing, model: PriceSnapshot, retention: CacheRetention): number {
  const inputPrice = perToken(pricing.input!);
  if (!writeBilled(pricing, retention)) return inputPrice;
  if (retention === 'long' && cacheTtlMs(model.promptCache, 'long') !== undefined) return 2 * inputPrice;
  return perToken(pricing.cacheWrite!);
}

const writeBilled = (pricing: Pricing | undefined, retention: CacheRetention): boolean =>
  retention !== 'none' && usable(pricing?.cacheWrite) && pricing!.cacheWrite! > 0;

/**
 * Rates of the whole request: the tier with the highest `inputTokensAbove`
 * that the billed prompt tokens exceed, else the base rates. This is Pi's
 * billing rule; the billed prompt is input, cache read and cache write
 * together, so cache reuse does not change the tier.
 */
export function requestRates(pricing: Pricing, promptTokens: number): Pricing {
  let rates: Pricing = pricing;
  let matched = -1;
  for (const tier of pricing.tiers ?? []) {
    if (promptTokens > tier.inputTokensAbove && tier.inputTokensAbove > matched) {
      rates = tier;
      matched = tier.inputTokensAbove;
    }
  }
  return rates;
}

export function predictCostProxy(
  state: SpendSnapshot,
  action: EffectiveAction,
  model: PriceSnapshot,
  output: BenchmarkOutputEvidence,
): CostProxyV1 {
  const input = billedPromptTokens(state, action);
  const pricing = model.cost && requestRates(model.cost, input);
  const { tokens: warm, hitTokens, eligibility: cacheEligibility } = usableWarmPrefix(state, action, model);
  // Without cache evidence the request has Pi's default tier.
  const retention = state.cache?.retention ?? 'short';
  const writes = writeBilled(pricing, retention);
  const tokens: CostBuckets = {
    cacheRead: warm,
    cacheWrite: writes ? input - warm : 0,
    uncachedInput: writes ? 0 : input - warm,
    ...(output.kind === 'measured' ? { output: output.tokensPerTask } : {}),
  };
  const cacheHitEstimate = hitTokens > 0 ? 'uncertain' as const : 'none' as const;
  if (!pricing || !usable(pricing.input) || !usable(pricing.output)) {
    return { priceKnown: false, cacheHitEstimate, cacheEligibility, tokens };
  }
  const missPrice = missPricePerToken(pricing, model, retention);
  const readKnown = usable(pricing.cacheRead);
  // The central input uses the weighted prefix. The bounds use the two outcomes
  // that the weight does not decide: a miss, and a hit of the largest prefix
  // that can hit. A cache read can cost more than a miss, so neither outcome is
  // always cheaper. An unknown read price gives no credit in the center, a free
  // read at the minimum, and no maximum when a hit is possible.
  const readCentral = readKnown ? perToken(pricing.cacheRead!) : missPrice;
  const readLow = readKnown ? readCentral : 0;
  const missInput = input * missPrice;
  const hitInput = (read: number) => hitTokens * read + (input - hitTokens) * missPrice;
  const promptMin = Math.min(missInput, hitInput(readLow));
  const known = { priceKnown: true, cacheHitEstimate, cacheEligibility, tokens };
  // A zero output price makes the token count irrelevant. A positive price
  // with no count gives only a lower bound: the output costs zero or more.
  const outputUSD = pricing.output === 0 ? 0
    : output.kind === 'measured' ? output.tokensPerTask * perToken(pricing.output) : undefined;
  if (outputUSD === undefined) return { ...known, minUSD: promptMin };
  const centralUSD = warm * readCentral + (input - warm) * missPrice + outputUSD;
  const minUSD = promptMin + outputUSD;
  if (!readKnown && hitTokens > 0) return { ...known, centralUSD, minUSD, cacheReadPriceUnknown: true };
  const maxUSD = Math.max(missInput, hitInput(readCentral)) + outputUSD;
  return { ...known, centralUSD, minUSD, maxUSD };
}

export function costFeature(cost: CostProxyV1, output: BenchmarkOutputEvidence): { interval: Interval; evidence: FeatureEvidence } {
  if (!cost.priceKnown) {
    return {
      interval: { center: PRICE_UNKNOWN_VALUE, lower: 0, upper: 1 },
      evidence: { feature: 'costDesirability', code: 'price-unknown', mapping: FEATURE_MAPPING_VERSION, details: [`cache-eligibility:${cost.cacheEligibility}`] },
    };
  }
  // Desirability falls with cost, so the bounds swap. No maximum cost gives
  // the lowest desirability. Without a central cost the center is the
  // midpoint of the bounds.
  const upper = costDesirability(cost.minUSD!);
  const lower = cost.maxUSD === undefined ? 0 : costDesirability(cost.maxUSD);
  return {
    interval: { center: cost.centralUSD === undefined ? (lower + upper) / 2 : costDesirability(cost.centralUSD), lower, upper },
    evidence: {
      feature: 'costDesirability', code: 'price-known', mapping: FEATURE_MAPPING_VERSION,
      details: [
        `cache:${cost.cacheHitEstimate}`, `cache-eligibility:${cost.cacheEligibility}`,
        ...(cost.cacheReadPriceUnknown ? ['cache-read-price:unknown'] : []), outputEvidenceDetail(output),
      ],
    },
  };
}

/** Lower end of the cost scale, USD. A cheaper or free action has desirability 1. */
export const COST_FLOOR_USD = 0.00001;
/** Decades of cost from the lower end to desirability 0, at $10. */
export const COST_DECADES = 6;

/**
 * Desirability of the economic cost proxy of one decision: log10 of the
 * cost, linear over [$0.00001, $10]. The selector compares only differences,
 * so the difference of two actions depends only on their cost ratio: an action
 * at half the cost gains log10(2)/6 at any price level. A preference answer
 * about a relative saving then applies the same way to a $0.001 turn and a $1 turn.
 */
export function costDesirability(usd: number): number {
  if (usd <= COST_FLOOR_USD) return 1;
  return clamp01(1 - Math.log10(usd / COST_FLOOR_USD) / COST_DECADES);
}

/** Common cost value when the price is unknown. Not a USD estimate. */
export const PRICE_UNKNOWN_VALUE = 0.5;
