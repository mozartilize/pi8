/**
 * Nonfinancial continuity of one action: whether it keeps the incumbent model
 * at an ordinary boundary, or how it relates to the failed attempt at a
 * rework boundary. Cache savings are not part of it; spend prices them once.
 *
 * Model identity is the exact `provider/modelId`, effort excluded. Different
 * providers are different models even with equal model names.
 */
import { effortRank, type EffectiveAction } from './actions.js';
import { CONTINUITY } from './mapping.js';
import { FEATURE_MAPPING_VERSION, type FeatureEvidence } from './schema.js';
import type { ServedIdentity, SessionSnapshot } from './state.js';

/**
 * True when the action keeps the failed model at a higher effort. A failed
 * attempt without a known effort cannot show that this effort is higher.
 */
export function raisesFailedEffort(failed: ServedIdentity, action: EffectiveAction): boolean {
  return failed.registryId === action.registryId
    && failed.effort !== undefined && action.effort !== undefined
    && effortRank(action.effort) > effortRank(failed.effort);
}

export function continuityFeature(state: Pick<SessionSnapshot, 'boundary' | 'incumbent' | 'rework'>, action: EffectiveAction): { value: number; evidence: FeatureEvidence } {
  if (state.boundary === 'rework' && state.rework) {
    const failed = state.rework.failed;
    const value = failed.registryId !== action.registryId
      ? CONTINUITY.reworkDifferentModel
      : raisesFailedEffort(failed, action) ? CONTINUITY.reworkSameModelHigherEffort : CONTINUITY.reworkSameModelEqualOrLowerEffort;
    return { value, evidence: { feature: 'continuity', code: 'boundary-rule', mapping: FEATURE_MAPPING_VERSION, details: ['boundary:rework'] } };
  }
  if (state.boundary === 'ordinary' && state.incumbent) {
    const value = state.incumbent.registryId === action.registryId ? CONTINUITY.ordinarySameModel : CONTINUITY.ordinaryDifferentModel;
    return { value, evidence: { feature: 'continuity', code: 'boundary-rule', mapping: FEATURE_MAPPING_VERSION, details: ['boundary:ordinary'] } };
  }
  return { value: CONTINUITY.unknown, evidence: { feature: 'continuity', code: 'identity-unknown', mapping: FEATURE_MAPPING_VERSION } };
}
