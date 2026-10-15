/**
 * Attributed recovery features of one action: friction avoidance from
 * attributed failures, and the recovery options at a rework boundary.
 *
 * Failure evidence applies only to the exact model, served effort and work
 * item it was attributed to; it never moves to another effort or work item.
 * The recovery fits describe recovery options, not observed success.
 */
import type { EffectiveAction } from './actions.js';
import { raisesFailedEffort } from './continuity.js';
import { FRICTION } from './mapping.js';
import { FEATURE_MAPPING_VERSION, type FeatureEvidence } from './schema.js';
import type { SessionSnapshot } from './state.js';

export interface RecoveryFeatures {
  frictionAvoidance: number;
  effortRecoveryFit: number;
  modelSwitchRecoveryFit: number;
  /** Evidence in feature order: friction avoidance, effort recovery, model-switch recovery. */
  evidence: FeatureEvidence[];
}

export function recoveryFeatures(state: Pick<SessionSnapshot, 'boundary' | 'rework' | 'friction' | 'workItemId'>, action: EffectiveAction): RecoveryFeatures {
  let effortRecoveryFit = 0;
  let modelSwitchRecoveryFit = 0;
  if (state.boundary === 'rework' && state.rework) {
    const failed = state.rework.failed;
    if (failed.registryId === action.registryId) effortRecoveryFit = raisesFailedEffort(failed, action) ? 1 : 0;
    else modelSwitchRecoveryFit = 1;
  }

  let frictionAvoidance: number = FRICTION.none;
  let attributed = false;
  let unattributed = false;
  for (const event of state.friction) {
    if (event.registryId !== action.registryId || event.effort !== action.effort) continue;
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
  const evidence: FeatureEvidence[] = [
    { feature: 'frictionAvoidance', code: attributed ? 'attributed' : unattributed ? 'unattributed' : 'boundary-rule', mapping: FEATURE_MAPPING_VERSION },
    { feature: 'effortRecoveryFit', code: 'boundary-rule', mapping: FEATURE_MAPPING_VERSION },
    { feature: 'modelSwitchRecoveryFit', code: 'boundary-rule', mapping: FEATURE_MAPPING_VERSION },
  ];
  return { frictionAvoidance, effortRecoveryFit, modelSwitchRecoveryFit, evidence };
}
