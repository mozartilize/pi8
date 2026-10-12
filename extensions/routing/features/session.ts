/**
 * Continuity, friction and recovery features.
 *
 * Model identity is the exact `provider/modelId`, effort excluded. Different
 * providers are different models even with equal model names. Failure
 * evidence applies only to the exact model, served effort and work item it
 * was attributed to; it never moves to another effort or work item. The
 * recovery features describe recovery options, not observed success.
 */
import { CONTINUITY, FRICTION } from './mapping.js';
import { effortRank, type EffectiveAction } from './actions.js';
import { FEATURE_MAPPING_VERSION, type FeatureEvidence } from './schema.js';
import type { DecisionStateV1, ServedIdentity } from './state.js';

export interface SessionFeatures {
  continuity: number;
  frictionAvoidance: number;
  effortRecoveryFit: number;
  modelSwitchRecoveryFit: number;
  evidence: FeatureEvidence[];
}

const sameEffort = (a: ServedIdentity, b: Pick<EffectiveAction, 'effort'>): boolean => a.effort === b.effort;

export function sessionFeatures(state: DecisionStateV1, action: EffectiveAction): SessionFeatures {
  const evidence: FeatureEvidence[] = [];
  let continuity: number = CONTINUITY.unknown;
  let effortRecoveryFit = 0;
  let modelSwitchRecoveryFit = 0;

  if (state.boundary === 'rework' && state.rework) {
    const failed = state.rework.failed;
    if (failed.registryId === action.registryId) {
      // A failed attempt without a known effort cannot show that this effort is higher.
      const higher = failed.effort !== undefined && action.effort !== undefined && effortRank(action.effort) > effortRank(failed.effort);
      continuity = higher ? CONTINUITY.reworkSameModelHigherEffort : CONTINUITY.reworkSameModelEqualOrLowerEffort;
      effortRecoveryFit = higher ? 1 : 0;
    } else {
      continuity = CONTINUITY.reworkDifferentModel;
      modelSwitchRecoveryFit = 1;
    }
    evidence.push({ feature: 'continuity', code: 'boundary-rule', mapping: FEATURE_MAPPING_VERSION, details: ['boundary:rework'] });
  } else if (state.boundary === 'ordinary' && state.incumbent) {
    continuity = state.incumbent.registryId === action.registryId ? CONTINUITY.ordinarySameModel : CONTINUITY.ordinaryDifferentModel;
    evidence.push({ feature: 'continuity', code: 'boundary-rule', mapping: FEATURE_MAPPING_VERSION, details: ['boundary:ordinary'] });
  } else {
    evidence.push({ feature: 'continuity', code: 'identity-unknown', mapping: FEATURE_MAPPING_VERSION });
  }

  let frictionAvoidance: number = FRICTION.none;
  let attributed = false;
  let unattributed = false;
  for (const event of state.friction) {
    if (event.registryId !== action.registryId || !sameEffort(event, action)) continue;
    if (state.workItemId === undefined || event.workItemId !== state.workItemId) continue;
    if (event.kind === 'attributed-rework') {
      frictionAvoidance = Math.min(frictionAvoidance, FRICTION.attributedRework);
      attributed = true;
    } else if (event.kind === 'severe-reasoning-loop') {
      frictionAvoidance = Math.min(frictionAvoidance, FRICTION.severeReasoningLoop);
      attributed = true;
    } else {
      unattributed = true;
    }
  }
  evidence.push({
    feature: 'frictionAvoidance',
    code: attributed ? 'attributed' : unattributed ? 'unattributed' : 'boundary-rule',
    mapping: FEATURE_MAPPING_VERSION,
  });
  return { continuity, frictionAvoidance, effortRecoveryFit, modelSwitchRecoveryFit, evidence };
}
