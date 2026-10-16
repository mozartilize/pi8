/**
 * Feature vector of one effective action: the single feature entry point of
 * the unified selector. Every value is in [0, 1] and every interval contains
 * its central representative.
 */
import type { BenchModel, ProvenanceAxis } from '../../types.js';
import type { RegistryModelInfo } from '../score/scorer.js';
import type { EffectiveAction } from './actions.js';
import { benchmarkOutputEvidence } from './benchmark-output.js';
import { continuityFeature } from './continuity.js';
import { timeFeature } from './latency.js';
import { clamp01 } from './mapping.js';
import { capabilityFeatures, evidenceGaps, rowAtServedEffort } from './model.js';
import { recoveryFeatures } from './recovery.js';
import { FEATURE_INDEX, FEATURE_NAMES, type ActionFeatureVector, type FeatureEvidence, type FeatureName, type Interval } from './schema.js';
import { costFeature, predictCostProxy, type CostProxyV1 } from './spend.js';
import type { BenchmarkSnapshot, DecisionStateV1, PriceSnapshot, SessionSnapshot, SpendSnapshot, TaskSnapshot } from './state.js';
import { composeTaskDemand } from './task-demand.js';

export interface ActionFeatures {
  action: EffectiveAction;
  features: ActionFeatureVector;
  costProxy: CostProxyV1;
  /** Diagnostic: required quality axes without evidence. Never filters or orders actions. */
  evidenceGaps: ProvenanceAxis[];
  /**
   * Diagnostic: largest relevant-axis shortfall. Zero means the evidence
   * establishes no deficit. Never filters, groups or orders actions.
   */
  capabilityShortfall: number;
}

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
  const taskSnapshot: TaskSnapshot = {
    phase: state.phase, contextAcquisition: state.contextAcquisition,
    openDecisions: state.openDecisions, difficulty: state.difficulty,
    estimatedContextTokens: state.estimatedContextTokens, needsVision: state.needsVision,
  };
  const benchmark: BenchmarkSnapshot = { benchmarkIndexVersion: state.benchmarkIndexVersion };
  const spendSnapshot: SpendSnapshot = {
    estimatedContextTokens: state.estimatedContextTokens, promptTokenScales: state.promptTokenScales,
    cache: state.cache, promptIdentity: state.promptIdentity, nowMs: state.nowMs,
    isSubagentSpawn: state.isSubagentSpawn,
  };
  const price: PriceSnapshot = { cost: model.cost, promptCache: model.promptCache, api: model.api, compat: model.compat };
  const continuitySnapshot: Pick<SessionSnapshot, 'boundary' | 'incumbent' | 'rework'> = {
    boundary: state.boundary, incumbent: state.incumbent, rework: state.rework,
  };
  const recoverySnapshot: Pick<SessionSnapshot, 'boundary' | 'rework' | 'friction' | 'workItemId'> = {
    boundary: state.boundary, rework: state.rework, friction: state.friction, workItemId: state.workItemId,
  };
  const task = composeTaskDemand(taskSnapshot);
  for (const capability of capabilityFeatures(row, task, benchmark)) {
    capabilityShortfall = Math.max(capabilityShortfall, capability.shortfall ?? 0);
    intervals.set(capability.name, capability.interval);
    evidence.push(capability.evidence);
  }
  const output = benchmarkOutputEvidence(row, benchmark.benchmarkIndexVersion);
  const costProxy = predictCostProxy(spendSnapshot, action, price, output);
  const cost = costFeature(costProxy, output);
  intervals.set('costDesirability', cost.interval);
  evidence.push(cost.evidence);
  const time = timeFeature(row, output);
  intervals.set('timeDesirability', time.interval);
  evidence.push(time.evidence);
  const exact = (value: number): Interval => ({ center: value, lower: value, upper: value });
  const continuity = continuityFeature(continuitySnapshot, action);
  intervals.set('continuity', exact(continuity.value));
  evidence.push(continuity.evidence);
  const recovery = recoveryFeatures(recoverySnapshot, action);
  intervals.set('frictionAvoidance', exact(recovery.frictionAvoidance));
  intervals.set('effortRecoveryFit', exact(recovery.effortRecoveryFit));
  intervals.set('modelSwitchRecoveryFit', exact(recovery.modelSwitchRecoveryFit));
  evidence.push(...recovery.evidence);

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
  return { action, features: { key: action.key, values, lower, upper, evidence }, costProxy, evidenceGaps: evidenceGaps(row, task, benchmark), capabilityShortfall };
}
