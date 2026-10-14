/**
 * Cost and time features of one next provider invocation.
 *
 * The forecast prompt is split into disjoint buckets: cache read, cache write
 * (only where the registry bills writes), uncached input, and output. Each
 * token is priced once. Cache savings enter the cost once and nowhere else;
 * nonfinancial continuity is a separate feature. A missing price gives the
 * common feature interval, never invented dollars.
 *
 * Output demand depends on the model and its effort. AA measures the cost of
 * one task at each effort of a model; at the row's output price this gives
 * output-equivalent tokens per task, on one scale for all models. Without
 * this scale a higher effort, or a model that writes more, would gain
 * quality at no cost or time.
 */
import type { BenchModel, Candidate } from '../../types.js';
import { parseCandidateKey } from '../score/scorer.js';
import { effortRank, type EffectiveAction } from './actions.js';
import {
  OUTPUT_TOKENS_CENTRAL,
  OUTPUT_TOKENS_MAX,
  OUTPUT_TOKENS_MIN,
  DEMAND_SCALE_UNKNOWN_MAX,
  DEMAND_SCALE_UNKNOWN_MIN,
  PRICE_UNKNOWN_VALUE,
  REFERENCE_TOKENS_PER_TASK,
  SPEED_UNKNOWN_VALUE,
  costDesirability,
  latencyProxySeconds,
  timeDesirability,
} from './mapping.js';
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

/**
 * How the demand scale was obtained: `measured` from the action's own
 * effort, `nearest` from another measured effort of the same model, and
 * `unknown` when the model has no measured cost per task.
 */
export type DemandScaleCode = 'measured' | 'nearest' | 'unknown';

/** Output-demand multiplier: a central value and the bounds of its envelope. */
export interface DemandScale {
  scale: number;
  low: number;
  high: number;
  code: DemandScaleCode;
}

export const UNKNOWN_DEMAND: DemandScale = {
  scale: 1,
  low: DEMAND_SCALE_UNKNOWN_MIN,
  high: DEMAND_SCALE_UNKNOWN_MAX,
  code: 'unknown',
};

/**
 * Output-equivalent tokens of one AA task: the AA cost per task at the AA
 * output price of the same row. The cost includes input tokens, so this
 * overstates output for input-heavy models; it is one common proxy for all
 * candidates.
 */
function tokensPerTask(row: BenchModel): number | undefined {
  if (!usable(row.costPerTask) || row.costPerTask === 0) return undefined;
  if (!usable(row.priceOutputPer1M) || row.priceOutputPer1M === 0) return undefined;
  return row.costPerTask / perToken(row.priceOutputPer1M);
}

/**
 * Output-demand multiplier of one action on one scale for all models:
 * output-equivalent tokens per AA task divided by `REFERENCE_TOKENS_PER_TASK`.
 * A model that spends more tokens at every effort gets a larger scale at
 * every effort. An unmeasured effort takes the scale of the nearest measured
 * effort above it, so it never looks cheaper than a measured higher effort.
 * With no measured effort above, it takes the largest measured scale. A model
 * with no measured cost per task gets the wide unknown envelope.
 */
export function effortDemandScale(rows: readonly BenchModel[], action: EffectiveAction): DemandScale {
  const measured = rows
    .filter((row) => row.active && row.registryId === action.registryId && tokensPerTask(row) !== undefined)
    .sort((a, b) => effortRank(a.effort) - effortRank(b.effort));
  const exact = (row: BenchModel, code: DemandScaleCode): DemandScale => {
    const scale = tokensPerTask(row)! / REFERENCE_TOKENS_PER_TASK;
    return { scale, low: scale, high: scale, code };
  };
  if (action.effort === undefined) {
    const own = measured.find((row) => row.effort === undefined || row.effort === 'off');
    return own ? exact(own, 'measured') : UNKNOWN_DEMAND;
  }
  if (measured.length === 0) return UNKNOWN_DEMAND;
  const own = measured.find((row) => row.effort === action.effort);
  if (own) return exact(own, 'measured');
  const above = measured.find((row) => effortRank(row.effort) > effortRank(action.effort));
  if (above) return exact(above, 'nearest');
  const largest = measured.reduce((a, b) => (tokensPerTask(b)! > tokensPerTask(a)! ? b : a));
  return exact(largest, 'nearest');
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

/** Billed prompt tokens per estimated token for the action's model. */
export const promptTokenScale = (state: DecisionStateV1, registryId: string): number =>
  state.promptTokenScales?.get(registryId) ?? 1;

/** Prompt tokens the action's model bills for the estimated context. */
const billedPromptTokens = (state: DecisionStateV1, action: EffectiveAction): number =>
  Math.max(0, state.estimatedContextTokens) * promptTokenScale(state, action.registryId);

/**
 * Warm prefix tokens the action may reuse, in the tokens its model bills.
 * The incumbent action keeps the whole prefix; so does another effort of the
 * incumbent model when effort changes keep its cache. Other actions keep only
 * their own warm entry. Warm entries are estimates, so they take the same
 * scale as the prompt.
 */
export function usableWarmPrefix(
  state: DecisionStateV1,
  action: EffectiveAction,
  effortSharesCache: boolean,
): number {
  const cache = state.cache;
  const input = billedPromptTokens(state, action);
  if (state.isSubagentSpawn || !cache || cache.source === 'none') return 0;
  if (state.promptIdentity === undefined || cache.promptIdentity !== state.promptIdentity) return 0;
  if (state.nowMs - cache.observedAtMs > cache.ttlMs) return 0;
  const incumbent = cache.incumbentKey === undefined ? undefined : parseCandidateKey(cache.incumbentKey);
  const incumbentRegistryId = incumbent && `${incumbent.provider}/${incumbent.id}`;
  if (action.key === cache.incumbentKey) return input;
  if (effortSharesCache && incumbentRegistryId === action.registryId) return input;
  const warm = Math.max(0, cache.warmPrefixTokens.get(action.key) ?? 0) * promptTokenScale(state, action.registryId);
  return Math.min(input, warm);
}

const perToken = (pricePer1M: number): number => pricePer1M / 1_000_000;

export function predictSpend(
  state: DecisionStateV1,
  action: EffectiveAction,
  pricing: Pricing | undefined,
  effortSharesCache: boolean,
  demand: DemandScale = UNKNOWN_DEMAND,
): PredictedSpendV1 {
  const outputCentral = OUTPUT_TOKENS_CENTRAL * demand.scale;
  const input = billedPromptTokens(state, action);
  const warm = usableWarmPrefix(state, action, effortSharesCache);
  const writeBilled = usable(pricing?.cacheWrite) && pricing!.cacheWrite! > 0;
  const tokens: SpendBuckets = {
    cacheRead: warm,
    cacheWrite: writeBilled ? input - warm : 0,
    uncachedInput: writeBilled ? 0 : input - warm,
    output: outputCentral,
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
  const centralUSD = warm * readCentral + (input - warm) * missPrice + outputCentral * outputPrice;
  const minUSD = warm * readLow + (input - warm) * missPrice + OUTPUT_TOKENS_MIN * demand.low * outputPrice;
  const maxUSD = input * missPrice + OUTPUT_TOKENS_MAX * demand.high * outputPrice;
  return { priceKnown: true, centralUSD, minUSD, maxUSD, cacheHitEstimate, tokens };
}

export function costFeature(spend: PredictedSpendV1, demand: DemandScale = UNKNOWN_DEMAND): { interval: Interval; evidence: FeatureEvidence } {
  if (!spend.priceKnown) {
    return {
      interval: { center: PRICE_UNKNOWN_VALUE, lower: 0, upper: 1 },
      evidence: { feature: 'costDesirability', code: 'price-unknown', mapping: FEATURE_MAPPING_VERSION },
    };
  }
  return {
    // Desirability falls with cost, so the bounds swap.
    interval: { center: costDesirability(spend.centralUSD!), lower: costDesirability(spend.maxUSD!), upper: costDesirability(spend.minUSD!) },
    evidence: { feature: 'costDesirability', code: 'price-known', mapping: FEATURE_MAPPING_VERSION, details: [`cache:${spend.cacheHitEstimate}`, `demand:${demand.code}`] },
  };
}

export function timeFeature(
  row: BenchModel | undefined,
  demand: DemandScale = UNKNOWN_DEMAND,
): { interval: Interval; evidence: FeatureEvidence } {
  const tps = row?.outputSpeedTps;
  if (!usable(tps) || tps === 0) {
    return {
      interval: { center: SPEED_UNKNOWN_VALUE, lower: 0, upper: 1 },
      evidence: { feature: 'timeDesirability', code: 'speed-unknown', mapping: FEATURE_MAPPING_VERSION },
    };
  }
  return {
    interval: {
      center: timeDesirability(latencyProxySeconds(OUTPUT_TOKENS_CENTRAL * demand.scale, tps)),
      lower: timeDesirability(latencyProxySeconds(OUTPUT_TOKENS_MAX * demand.high, tps)),
      upper: timeDesirability(latencyProxySeconds(OUTPUT_TOKENS_MIN * demand.low, tps)),
    },
    evidence: { feature: 'timeDesirability', code: 'speed-known', mapping: FEATURE_MAPPING_VERSION, details: [`demand:${demand.code}`] },
  };
}
