/**
 * Cost and time features of one next provider invocation.
 *
 * The forecast prompt is split into disjoint buckets: cache read, cache write
 * (only where the registry bills writes), uncached input, and output. Each
 * token is priced once. Cache savings enter the cost once and nowhere else;
 * nonfinancial continuity is a separate feature. A missing price gives the
 * common feature interval, never invented dollars.
 */
import type { BenchModel, Candidate } from '../../types.js';
import { parseCandidateKey } from '../score/scorer.js';
import type { EffectiveAction } from './actions.js';
import {
  OUTPUT_TOKENS_CENTRAL,
  OUTPUT_TOKENS_MAX,
  OUTPUT_TOKENS_MIN,
  PRICE_UNKNOWN_VALUE,
  SPEED_UNKNOWN_VALUE,
  costDesirability,
  latencyProxySeconds,
  timeDesirability,
} from './mapping-v1.js';
import type { Interval } from './model.js';
import { FEATURE_MAPPING_VERSION, type FeatureEvidence } from './schema.js';
import type { DecisionStateV1 } from './state.js';

export type Pricing = NonNullable<Candidate['cost']>;

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
  tokens: SpendBuckets;
}

const usable = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value >= 0;

/**
 * Warm prefix tokens the action may reuse. The incumbent action keeps the
 * whole prefix; so does another effort of the incumbent model when effort
 * changes keep its cache. Other actions keep only their own warm entry.
 */
export function usableWarmPrefix(
  state: DecisionStateV1,
  action: EffectiveAction,
  effortSharesCache: boolean,
): number {
  const cache = state.cache;
  const input = Math.max(0, state.estimatedContextTokens);
  if (state.isSubagentSpawn || !cache || cache.source === 'none') return 0;
  if (state.promptIdentity === undefined || cache.promptIdentity !== state.promptIdentity) return 0;
  if (state.nowMs - cache.observedAtMs > cache.ttlMs) return 0;
  const incumbent = cache.incumbentKey === undefined ? undefined : parseCandidateKey(cache.incumbentKey);
  const incumbentRegistryId = incumbent && `${incumbent.provider}/${incumbent.id}`;
  if (action.key === cache.incumbentKey) return input;
  if (effortSharesCache && incumbentRegistryId === action.registryId) return input;
  return Math.min(input, Math.max(0, cache.warmPrefixTokens.get(action.key) ?? 0));
}

const perToken = (pricePer1M: number): number => pricePer1M / 1_000_000;

export function predictSpend(
  state: DecisionStateV1,
  action: EffectiveAction,
  pricing: Pricing | undefined,
  effortSharesCache: boolean,
): PredictedSpendV1 {
  const input = Math.max(0, state.estimatedContextTokens);
  const warm = usableWarmPrefix(state, action, effortSharesCache);
  const writeBilled = usable(pricing?.cacheWrite) && pricing!.cacheWrite! > 0;
  const tokens: SpendBuckets = {
    cacheRead: warm,
    cacheWrite: writeBilled ? input - warm : 0,
    uncachedInput: writeBilled ? 0 : input - warm,
    output: OUTPUT_TOKENS_CENTRAL,
  };
  const cacheHitEstimate = warm > 0 ? 'uncertain' as const : 'none' as const;
  if (!pricing || !usable(pricing.input) || !usable(pricing.output)) {
    return { priceKnown: false, cacheHitEstimate, tokens };
  }
  const inputPrice = perToken(pricing.input);
  const outputPrice = perToken(pricing.output);
  const missPrice = writeBilled ? perToken(pricing.cacheWrite!) : inputPrice;
  const readKnown = usable(pricing.cacheRead);
  // Unknown cache-read price: no credit in the center, a widened lower bound.
  const readCentral = readKnown ? perToken(pricing.cacheRead!) : missPrice;
  const readLow = readKnown ? perToken(pricing.cacheRead!) : 0;
  const centralUSD = warm * readCentral + (input - warm) * missPrice + OUTPUT_TOKENS_CENTRAL * outputPrice;
  const minUSD = warm * readLow + (input - warm) * missPrice + OUTPUT_TOKENS_MIN * outputPrice;
  const maxUSD = input * missPrice + OUTPUT_TOKENS_MAX * outputPrice;
  return { priceKnown: true, centralUSD, minUSD, maxUSD, cacheHitEstimate, tokens };
}

export function costFeature(spend: PredictedSpendV1): { interval: Interval; evidence: FeatureEvidence } {
  if (!spend.priceKnown) {
    return {
      interval: { center: PRICE_UNKNOWN_VALUE, lower: 0, upper: 1 },
      evidence: { feature: 'costDesirability', code: 'price-unknown', mapping: FEATURE_MAPPING_VERSION },
    };
  }
  return {
    // Desirability falls with cost, so the bounds swap.
    interval: { center: costDesirability(spend.centralUSD!), lower: costDesirability(spend.maxUSD!), upper: costDesirability(spend.minUSD!) },
    evidence: { feature: 'costDesirability', code: 'price-known', mapping: FEATURE_MAPPING_VERSION, details: [`cache:${spend.cacheHitEstimate}`] },
  };
}

export function timeFeature(row: BenchModel | undefined): { interval: Interval; evidence: FeatureEvidence } {
  const tps = row?.outputSpeedTps;
  if (!usable(tps) || tps === 0) {
    return {
      interval: { center: SPEED_UNKNOWN_VALUE, lower: 0, upper: 1 },
      evidence: { feature: 'timeDesirability', code: 'speed-unknown', mapping: FEATURE_MAPPING_VERSION },
    };
  }
  return {
    interval: {
      center: timeDesirability(latencyProxySeconds(OUTPUT_TOKENS_CENTRAL, tps)),
      lower: timeDesirability(latencyProxySeconds(OUTPUT_TOKENS_MAX, tps)),
      upper: timeDesirability(latencyProxySeconds(OUTPUT_TOKENS_MIN, tps)),
    },
    evidence: { feature: 'timeDesirability', code: 'speed-known', mapping: FEATURE_MAPPING_VERSION },
  };
}
