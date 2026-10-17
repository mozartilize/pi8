/**
 * Prompt-cache eligibility of one action: the warm prefix it may reuse and the
 * reason when it may reuse none. The spend forecast prices these tokens once;
 * this module states only which tokens are warm.
 */
import type { CacheRetention, ModelPromptCache } from '@earendil-works/pi-ai';

import { parseCandidateKey } from '../score/scorer.js';
import type { EffectiveAction } from './actions.js';
import { clamp01 } from './mapping.js';
import type { PriceSnapshot, SpendSnapshot } from './state.js';

/** Billed prompt tokens per estimated token for the action's model. */
export const promptTokenScale = (state: Pick<SpendSnapshot, 'promptTokenScales'>, registryId: string): number =>
  state.promptTokenScales?.get(registryId) ?? 1;

/** Prompt tokens the action's model bills for the estimated context. */
export const billedPromptTokens = (state: SpendSnapshot, action: EffectiveAction): number =>
  Math.max(0, state.estimatedContextTokens) * promptTokenScale(state, action.registryId);

/** pi-ai keeps the cached prefix across efforts only for per-message effort. */
export const effortSharesCache = (model: Pick<PriceSnapshot, 'api' | 'compat'>): boolean =>
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
 * the largest live prefix recorded for any effort of the model.
 *
 * `hitProbability` is an authored weight, not a measured hit rate. A value
 * in (0, 1] means a hit is possible; 0 or a non-finite value means the record
 * gives no hit. `tokens` is the largest weighted prefix: the central estimate
 * only. `hitTokens` is the largest prefix that can hit. It sets the spend
 * bounds, which are a possibility envelope, not a confidence interval.
 * Records can overlap, so neither value adds the tokens of two records.
 * Both values use the prompt's token scale and cannot exceed the prompt.
 */
export function usableWarmPrefix(
  state: SpendSnapshot,
  action: EffectiveAction,
  model: PriceSnapshot,
): { tokens: number; hitTokens: number; eligibility: CacheEligibility } {
  const none = (eligibility: CacheEligibility) => ({ tokens: 0, hitTokens: 0, eligibility });
  const cache = state.cache;
  if (!cache || cache.warmPrefixes.size === 0) return none('no-recorded-prefix');
  if (state.promptIdentity === undefined || cache.promptIdentity !== state.promptIdentity) return none('prompt-mismatch');
  if (cache.retention === 'none') return none('retention-none');
  const shares = effortSharesCache(model);
  let recorded = false;
  let known = false;
  let live = false;
  let warmTokens = 0;
  let hitTokens = 0;
  const input = billedPromptTokens(state, action);
  const scale = promptTokenScale(state, action.registryId);
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
      const probability = Number.isFinite(record.hitProbability) ? clamp01(record.hitProbability) : 0;
      if (probability === 0) continue;
      const prefix = Math.min(input, Math.max(0, record.tokens) * scale);
      warmTokens = Math.max(warmTokens, prefix * probability);
      hitTokens = Math.max(hitTokens, prefix);
    }
  }
  if (!recorded) return none('no-recorded-prefix');
  if (!known) return none('ttl-unknown');
  if (!live) return none('expired');
  return { tokens: warmTokens, hitTokens, eligibility: 'eligible' };
}

