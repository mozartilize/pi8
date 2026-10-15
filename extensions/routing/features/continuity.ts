/**
 * Nonfinancial continuity of one action: whether it keeps the incumbent model
 * at an ordinary boundary, or how it relates to the failed attempt at a
 * rework boundary. Cache savings are not part of it; spend prices them once.
 *
 * Model identity is the exact `provider/modelId`, effort excluded. Different
 * providers are different models even with equal model names.
 */
import { raisesFailedEffort, type EffectiveAction } from './actions.js';
import { FEATURE_MAPPING_VERSION, type FeatureEvidence } from './schema.js';
import type { SessionSnapshot } from './state.js';

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

export const CONTINUITY = {
  /** Ordinary authorized boundary: same served model at any effort. */
  ordinarySameModel: 0.65,
  ordinaryDifferentModel: 0.45,
  /** Attributed rework boundary. */
  reworkSameModelHigherEffort: 0.78,
  reworkSameModelEqualOrLowerEffort: 0.65,
  reworkDifferentModel: 0.48,
  /** No incumbent or unknown identity: common to all actions. */
  unknown: 0.5,
} as const;
