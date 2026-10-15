/**
 * Spend of one next provider invocation and its cost feature.
 *
 * The forecast prompt is split into disjoint buckets: cache read, cache write
 * (only where the registry bills writes), uncached input, and output. Each
 * token is priced once. Cache savings enter the cost once and nowhere else;
 * nonfinancial continuity is a separate feature. A missing price gives the
 * common feature interval, never invented dollars.
 */
import type { CacheRetention } from '@earendil-works/pi-ai';

import type { EffectiveAction } from './actions.js';
import { billedPromptTokens, cacheTtlMs, usableWarmPrefix, type CacheEligibility } from './cache.js';
import { PRICE_UNKNOWN_VALUE, costDesirability } from './mapping.js';
import type { Interval } from './model.js';
import { demandDetail, outputTokenForecast, UNKNOWN_DEMAND, usable, type OutputDemandPrior, type OutputTokenForecast } from './output-demand.js';
import { FEATURE_MAPPING_VERSION, type FeatureEvidence } from './schema.js';
import type { PriceSnapshot, SpendSnapshot } from './state.js';

export type Pricing = NonNullable<PriceSnapshot['cost']>;

export interface SpendBuckets {
  uncachedInput: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface PredictedSpendV1 {
  priceKnown: boolean;
  centralUSD?: number;
  minUSD?: number;
  maxUSD?: number;
  cacheHitEstimate: 'uncertain' | 'none';
  cacheEligibility: CacheEligibility;
  tokens: SpendBuckets;
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

export function predictSpend(
  state: SpendSnapshot,
  action: EffectiveAction,
  model: PriceSnapshot,
  output: OutputTokenForecast = outputTokenForecast(UNKNOWN_DEMAND),
): PredictedSpendV1 {
  const outputCentral = output.center;
  const input = billedPromptTokens(state, action);
  const pricing = model.cost && requestRates(model.cost, input);
  const { tokens: warm, eligibility: cacheEligibility } = usableWarmPrefix(state, action, model);
  // Without cache evidence the request has Pi's default tier.
  const retention = state.cache?.retention ?? 'short';
  const writes = writeBilled(pricing, retention);
  const tokens: SpendBuckets = {
    cacheRead: warm,
    cacheWrite: writes ? input - warm : 0,
    uncachedInput: writes ? 0 : input - warm,
    output: outputCentral,
  };
  const cacheHitEstimate = warm > 0 ? 'uncertain' as const : 'none' as const;
  if (!pricing || !usable(pricing.input) || !usable(pricing.output)) {
    return { priceKnown: false, cacheHitEstimate, cacheEligibility, tokens };
  }
  const outputPrice = perToken(pricing.output);
  const missPrice = missPricePerToken(pricing, model, retention);
  const readKnown = usable(pricing.cacheRead);
  // Unknown cache-read price: no credit in the center, a widened lower bound.
  const readCentral = readKnown ? perToken(pricing.cacheRead!) : missPrice;
  const readLow = readKnown ? perToken(pricing.cacheRead!) : 0;
  const centralUSD = warm * readCentral + (input - warm) * missPrice + outputCentral * outputPrice;
  const minUSD = warm * readLow + (input - warm) * missPrice + output.low * outputPrice;
  const maxUSD = input * missPrice + output.high * outputPrice;
  return { priceKnown: true, centralUSD, minUSD, maxUSD, cacheHitEstimate, cacheEligibility, tokens };
}

export function costFeature(spend: PredictedSpendV1, demand: OutputDemandPrior = UNKNOWN_DEMAND): { interval: Interval; evidence: FeatureEvidence } {
  if (!spend.priceKnown) {
    return {
      interval: { center: PRICE_UNKNOWN_VALUE, lower: 0, upper: 1 },
      evidence: { feature: 'costDesirability', code: 'price-unknown', mapping: FEATURE_MAPPING_VERSION, details: [`cache-eligibility:${spend.cacheEligibility}`] },
    };
  }
  return {
    // Desirability falls with cost, so the bounds swap.
    interval: { center: costDesirability(spend.centralUSD!), lower: costDesirability(spend.maxUSD!), upper: costDesirability(spend.minUSD!) },
    evidence: { feature: 'costDesirability', code: 'price-known', mapping: FEATURE_MAPPING_VERSION, details: [`cache:${spend.cacheHitEstimate}`, `cache-eligibility:${spend.cacheEligibility}`, demandDetail(demand)] },
  };
}
