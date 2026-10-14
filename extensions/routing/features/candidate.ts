/**
 * Feature vector of one effective action: the single feature entry point of
 * the unified selector. Every value is in [0, 1] and every interval contains
 * its central representative.
 */
import type { BenchModel, ProvenanceAxis } from '../../types.js';
import type { RegistryModelInfo } from '../score/scorer.js';
import type { EffectiveAction } from './actions.js';
import { costFeature, effortDemandScale, predictSpend, timeFeature, type PredictedSpendV1 } from './economics.js';
import { clamp01 } from './mapping.js';
import { capabilityFeatures, evidenceGaps, rowAtServedEffort, type Interval } from './model.js';
import { FEATURE_INDEX, FEATURE_MAPPING_VERSION, FEATURE_NAMES, type ActionFeatureVector, type FeatureEvidence, type FeatureName } from './schema.js';
import { sessionFeatures } from './session.js';
import type { DecisionStateV1 } from './state.js';

export interface ActionFeatures {
  action: EffectiveAction;
  features: ActionFeatureVector;
  spend: PredictedSpendV1;
  /** Diagnostic: required quality axes without evidence. Never filters or orders actions. */
  evidenceGaps: ProvenanceAxis[];
  /**
   * Diagnostic: largest relevant-axis shortfall. Zero means the evidence
   * establishes no deficit. Never filters, groups or orders actions.
   */
  capabilityShortfall: number;
}

/** pi-ai keeps the cached prefix across efforts only for per-message effort. */
export const effortSharesCache = (model: RegistryModelInfo): boolean =>
  model.api === 'anthropic-messages'
  && (model.compat as { supportsMidConvoEffort?: unknown } | undefined)?.supportsMidConvoEffort === true;

export function candidateFeatures(
  state: DecisionStateV1,
  model: RegistryModelInfo,
  action: EffectiveAction,
  rows: readonly BenchModel[],
): ActionFeatures {
  const row = rowAtServedEffort(rows, action);
  const intervals = new Map<FeatureName, Interval>();
  const evidence: FeatureEvidence[] = [];
  let capabilityShortfall = 0;
  for (const capability of capabilityFeatures(row, state)) {
    capabilityShortfall = Math.max(capabilityShortfall, capability.shortfall ?? 0);
    intervals.set(capability.name, capability.interval);
    evidence.push(capability.evidence);
  }
  const demand = effortDemandScale(rows, action);
  const spend = predictSpend(state, action, model.cost, effortSharesCache(model), demand);
  const cost = costFeature(spend, demand);
  intervals.set('costDesirability', cost.interval);
  evidence.push(cost.evidence);
  const time = timeFeature(row, demand);
  intervals.set('timeDesirability', time.interval);
  evidence.push(time.evidence);
  const session = sessionFeatures(state, action);
  const exact = (value: number): Interval => ({ center: value, lower: value, upper: value });
  intervals.set('continuity', exact(session.continuity));
  intervals.set('frictionAvoidance', exact(session.frictionAvoidance));
  intervals.set('effortRecoveryFit', exact(session.effortRecoveryFit));
  intervals.set('modelSwitchRecoveryFit', exact(session.modelSwitchRecoveryFit));
  evidence.push(...session.evidence);
  for (const name of ['effortRecoveryFit', 'modelSwitchRecoveryFit'] as const) {
    evidence.push({ feature: name, code: 'boundary-rule', mapping: FEATURE_MAPPING_VERSION });
  }

  const values = new Array<number>(FEATURE_NAMES.length);
  const lower = new Array<number>(FEATURE_NAMES.length);
  const upper = new Array<number>(FEATURE_NAMES.length);
  for (const name of FEATURE_NAMES) {
    const interval = intervals.get(name)!;
    const j = FEATURE_INDEX[name];
    lower[j] = clamp01(interval.lower);
    upper[j] = clamp01(interval.upper);
    values[j] = Math.min(upper[j]!, Math.max(lower[j]!, clamp01(interval.center)));
  }
  return { action, features: { key: action.key, values, lower, upper, evidence }, spend, evidenceGaps: evidenceGaps(row, state), capabilityShortfall };
}
