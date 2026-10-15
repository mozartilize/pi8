/**
 * Cost and time features of one next provider invocation.
 *
 * The forecast prompt is split into disjoint buckets: cache read, cache write
 * (only where the registry bills writes), uncached input, and output. Each
 * token is priced once. Cache savings enter the cost once and nowhere else;
 * nonfinancial continuity is a separate feature. A missing price gives the
 * common feature interval, never invented dollars.
 *
 * Output demand depends on the model and its effort. AA measures the output
 * tokens (answer and reasoning) of one Intelligence Index task at each effort
 * of a model. This is a benchmark observation, not a forecast of the next
 * invocation, so it moves the forecast only by a bounded amount. Without it a
 * higher effort, or a model that writes more, would gain quality at no cost or
 * time.
 */
import type { CacheRetention, ModelPromptCache } from '@earendil-works/pi-ai';

import type { BenchModel } from '../../types.js';
import { parseCandidateKey, type RegistryModelInfo } from '../score/scorer.js';
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
} from './mapping.js';
import { isCompatibleIndexVersion, type Interval } from './model.js';
import { FEATURE_MAPPING_VERSION, type FeatureEvidence } from './schema.js';
import type { DecisionStateV1 } from './state.js';

export type Pricing = NonNullable<RegistryModelInfo['cost']>;

export interface SpendBuckets {
  uncachedInput: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

/**
 * Source of the output-demand prior: `aa-exact` from an AA observation at the
 * action's own effort, `neutral` when no usable observation exists.
 */
export type DemandScaleCode = 'aa-exact' | 'neutral';

/** Why an action has no usable AA output-token observation. */
export type NeutralDemandReason =
  | 'no-row'
  | 'absent'
  | 'invalid'
  | 'conflict'
  | 'unknown-effort'
  | 'source-estimated'
  | 'version-unknown'
  | 'version-incompatible';

/**
 * Dimensionless output-demand multiplier of one action: a central value and
 * the bounds of its envelope, with `low <= center <= high`.
 */
export interface OutputDemandPrior {
  center: number;
  low: number;
  high: number;
  code: DemandScaleCode;
  reason?: NeutralDemandReason;
}

/**
 * Output tokens of the next invocation. Spend and latency both consume this
 * one object, so they always use the same demand.
 */
export interface OutputTokenForecast {
  low: number;
  center: number;
  high: number;
}

export const outputTokenForecast = (prior: OutputDemandPrior): OutputTokenForecast => ({
  low: OUTPUT_TOKENS_MIN * prior.low,
  center: OUTPUT_TOKENS_CENTRAL * prior.center,
  high: OUTPUT_TOKENS_MAX * prior.high,
});

// Output-demand policy. Authored values, not fitted prediction parameters.
// The reference is a fixed rounded anchor near the median AA observation; a
// benchmark refresh does not recompute it. The center keeps the full measured
// ratio between actions: a compressed ratio makes the highest effort of every
// model look almost as cheap as its lower efforts, so it wins most tasks. The
// limits span the observed range (about 0.06 to 6.6) with margin. The
// envelope is the center divided and multiplied by one factor: a benchmark
// task is not the next invocation, and the uncertainty is a ratio with no
// direction. An envelope that always reaches the reference removes the
// worst-case advantage of a terse action only.
const REFERENCE_TOKENS_PER_TASK = 30_000;
const DEMAND_SCALE_MIN = 0.05;
const DEMAND_SCALE_MAX = 12;
const DEMAND_TRANSFER_FACTOR = 2;

/**
 * Prior of an action with no usable observation: a neutral center and an
 * envelope that contains every measured prior, so missing evidence widens the
 * cost and time intervals and gives no advantage.
 */
export const UNKNOWN_DEMAND: OutputDemandPrior = {
  center: 1,
  low: DEMAND_SCALE_MIN / DEMAND_TRANSFER_FACTOR,
  high: DEMAND_SCALE_MAX * DEMAND_TRANSFER_FACTOR,
  code: 'neutral',
};

const neutral = (reason: NeutralDemandReason): OutputDemandPrior => ({ ...UNKNOWN_DEMAND, reason });

/**
 * Output-demand prior of one action from the benchmark row at its served
 * effort (`rowAtServedEffort`). Only an exact-effort AA observation of a row
 * whose Intelligence Index AA did not estimate counts, and only when the page
 * and API index versions are compatible. Another effort or another model
 * never supplies the observation. The envelope of a measured prior is the
 * uncertainty of transferring benchmark-task behavior to the next invocation,
 * not an AA confidence interval.
 */
export function outputDemandPrior(row: BenchModel | undefined, apiIndexVersion: string | undefined): OutputDemandPrior {
  if (!row) return neutral('no-row');
  const provenance = row.outputTokensProvenance;
  if (!provenance) return neutral('absent');
  if (provenance.status !== 'measured') return neutral(provenance.status);
  const tokens = row.outputTokensPerTask;
  if (!usable(tokens)) return neutral('invalid');
  if (provenance.indexVersion === undefined || apiIndexVersion === undefined) return neutral('version-unknown');
  if (!isCompatibleIndexVersion(provenance.indexVersion) || !isCompatibleIndexVersion(apiIndexVersion)) {
    return neutral('version-incompatible');
  }
  const center = Math.min(DEMAND_SCALE_MAX, Math.max(DEMAND_SCALE_MIN, tokens / REFERENCE_TOKENS_PER_TASK));
  return { center, low: center / DEMAND_TRANSFER_FACTOR, high: center * DEMAND_TRANSFER_FACTOR, code: 'aa-exact' };
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

const usable = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value >= 0;

/** Billed prompt tokens per estimated token for the action's model. */
export const promptTokenScale = (state: DecisionStateV1, registryId: string): number =>
  state.promptTokenScales?.get(registryId) ?? 1;

/** Prompt tokens the action's model bills for the estimated context. */
const billedPromptTokens = (state: DecisionStateV1, action: EffectiveAction): number =>
  Math.max(0, state.estimatedContextTokens) * promptTokenScale(state, action.registryId);

/** pi-ai keeps the cached prefix across efforts only for per-message effort. */
export const effortSharesCache = (model: RegistryModelInfo): boolean =>
  model.api === 'anthropic-messages'
  && (model.compat as { supportsMidConvoEffort?: unknown } | undefined)?.supportsMidConvoEffort === true;

/**
 * Lifetime in milliseconds of the prompt cache that a request at `retention`
 * writes: 0 for retention `none`, undefined when the model declares no
 * lifetime for the tier. A cache price does not imply a lifetime.
 */
export function cacheTtlMs(promptCache: ModelPromptCache | undefined, retention: CacheRetention): number | undefined {
  if (retention === 'none') return 0;
  const seconds = promptCache?.[retention];
  return seconds !== undefined && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

/** Why an action has warm-prefix credit or has none. */
export type CacheEligibility =
  | 'eligible'
  | 'subagent'
  | 'no-recorded-prefix'
  | 'prompt-mismatch'
  | 'retention-none'
  | 'ttl-unknown'
  | 'expired';

/**
 * Warm prefix tokens the action may reuse, in the tokens its model bills.
 * A request at retention `none` reads no cache. Otherwise only a record
 * younger than the model's own cache lifetime at the tier that wrote the
 * record counts; an unknown lifetime gives no credit. Every action,
 * including the incumbent, reuses at most its recorded warm prefix; when
 * effort changes keep the model's cache, an action of that model may reuse
 * the largest live prefix recorded for any effort of the model. A record of
 * another session counts at its hit probability. Warm entries are estimates,
 * so they take the same scale as the prompt.
 */
export function usableWarmPrefix(
  state: DecisionStateV1,
  action: EffectiveAction,
  model: RegistryModelInfo,
): { tokens: number; eligibility: CacheEligibility } {
  const none = (eligibility: CacheEligibility) => ({ tokens: 0, eligibility });
  const cache = state.cache;
  if (state.isSubagentSpawn) return none('subagent');
  if (!cache || cache.warmPrefixes.size === 0) return none('no-recorded-prefix');
  if (state.promptIdentity === undefined || cache.promptIdentity !== state.promptIdentity) return none('prompt-mismatch');
  if (cache.retention === 'none') return none('retention-none');
  const shares = effortSharesCache(model);
  let recorded = false;
  let known = false;
  let live = false;
  let warmTokens = 0;
  for (const [key, records] of cache.warmPrefixes) {
    if (key !== action.key) {
      if (!shares) continue;
      const parsed = parseCandidateKey(key);
      if (`${parsed.provider}/${parsed.id}` !== action.registryId) continue;
    }
    for (const record of records) {
      recorded = true;
      const ttl = cacheTtlMs(model.promptCache, record.retention);
      if (!ttl) continue;
      known = true;
      const age = state.nowMs - record.observedAtMs;
      if (age < 0 || age >= ttl) continue;
      live = true;
      warmTokens = Math.max(warmTokens, Math.max(0, record.tokens) * record.hitProbability);
    }
  }
  if (!recorded) return none('no-recorded-prefix');
  if (!known) return none('ttl-unknown');
  if (!live) return none('expired');
  const warm = warmTokens * promptTokenScale(state, action.registryId);
  return { tokens: Math.min(billedPromptTokens(state, action), warm), eligibility: 'eligible' };
}

const perToken = (pricePer1M: number): number => pricePer1M / 1_000_000;

/**
 * Price per token of a prompt token that the cache does not hold. A request at
 * retention `none` writes no cache, so the token is input. A model without a
 * write charge bills the input price. Pi bills a 1h (`long`) cache write at
 * twice the input price; a model writes 1h entries only when it declares a
 * `long` lifetime, else the write is a short write at the write price.
 */
function missPricePerToken(pricing: Pricing, model: RegistryModelInfo, retention: CacheRetention): number {
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
  state: DecisionStateV1,
  action: EffectiveAction,
  model: RegistryModelInfo,
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

const demandDetail = (demand: OutputDemandPrior): string =>
  demand.reason ? `demand:${demand.code}:${demand.reason}` : `demand:${demand.code}`;

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

export function timeFeature(
  row: BenchModel | undefined,
  demand: OutputDemandPrior = UNKNOWN_DEMAND,
  output: OutputTokenForecast = outputTokenForecast(demand),
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
      center: timeDesirability(latencyProxySeconds(output.center, tps)),
      lower: timeDesirability(latencyProxySeconds(output.high, tps)),
      upper: timeDesirability(latencyProxySeconds(output.low, tps)),
    },
    evidence: { feature: 'timeDesirability', code: 'speed-known', mapping: FEATURE_MAPPING_VERSION, details: [demandDetail(demand)] },
  };
}
