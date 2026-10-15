/**
 * Capability features from benchmark rows at the exact served effort.
 * `measured` gives an exact value. `source-estimated` gives the central value
 * but keeps the full missing interval. Every other provenance gives the
 * missing representative and interval. A row from another effort is never
 * used.
 */
import type { BenchModel, ProvenanceAxis } from '../../types.js';
import { selectMergeRow } from '../../bench/store.js';
import { isCompatibleIndexVersion } from './benchmark.js';
import type { EffectiveAction } from './actions.js';
import { clamp01 } from './mapping.js';
import { FEATURE_MAPPING_VERSION, type AxisProvenance, type FeatureEvidence, type FeatureName, type Interval } from './schema.js';
import type { BenchmarkSnapshot } from './state.js';
import type { TaskDemand, TaskRelevance } from './task-demand.js';

/** AA Intelligence Index on a 0..100 scale. */
export const normalizeIntelligence = (index: number): number => clamp01(index / 100);
/** Terminal-Bench 4.0 Agentic Coding pass rate in percent. */
export const normalizeTerminalBench = (percent: number): number => clamp01(percent / 100);
/** AA-Briefcase rubric pass rate, already in [0, 1]. */
export const normalizeResearch = (rate: number): number => clamp01(rate);
/** AA-Omniscience Index on a -100..100 scale. */
export const normalizeKnowledge = (index: number): number => clamp01((index + 100) / 200);
/** LCR / MMMU-Pro correctness fraction, already in [0, 1]. */
export const normalizeFraction = (fraction: number): number => clamp01(fraction);

/** Research share of `researchFit`; Knowledge has the remainder. */
export const RESEARCH_SHARE = 0.75;
export const KNOWLEDGE_SHARE = 0.25;

/** Central representative of a missing [0, 1] metric. */
export const MISSING_REPRESENTATIVE = 0.5;
/** Common `inputFit` value when no input aspect is relevant; it cancels between candidates. */
export const INPUT_NOT_RELEVANT_VALUE = 0.5;
/** Research does not distinguish actions while collecting context. */
export const ACQUISITION_RESEARCH_VALUE = 0.5;
/** A fixed shortfall spans the fit scale; raising the target must not divide away capability differences. */
export const CAPABILITY_SHORTFALL: Readonly<Record<keyof TaskRelevance, number>> = {
  reasoning: 0.15,
  agentic: 0.2,
  research: 0.2,
};

/** Meeting the target earns full fit. Missing it by the axis shortfall earns zero. */
export const capabilityFit = (quality: number, target: number, axis: keyof TaskRelevance): number =>
  clamp01(1 - Math.max(0, target - quality) / CAPABILITY_SHORTFALL[axis]);

export interface AxisObservation {
  axis: ProvenanceAxis;
  provenance: AxisProvenance;
  /** Normalized to [0, 1]; present for `measured` and `source-estimated`. */
  normalized?: number;
  /** Why an observed value gives no evidence. */
  reason?: 'incompatible-version';
}

const NORMALIZE: Readonly<Record<ProvenanceAxis, (value: number) => number>> = {
  intelligence: normalizeIntelligence,
  agenticCoding: normalizeTerminalBench,
  research: normalizeResearch,
  knowledge: normalizeKnowledge,
  longContext: normalizeFraction,
  visionReasoning: normalizeFraction,
};

/** The row measured at exactly the action's served effort. */
export function rowAtServedEffort(rows: readonly BenchModel[], action: EffectiveAction): BenchModel | undefined {
  const matching = rows.filter((row) => row.active && row.registryId === action.registryId && (
    action.effort === undefined ? row.effort === undefined || row.effort === 'off' : row.effort === action.effort
  ));
  return selectMergeRow(matching);
}

export function observeAxis(row: BenchModel | undefined, axis: ProvenanceAxis, state: BenchmarkSnapshot): AxisObservation {
  const value = row?.quality[axis];
  const provenance = row?.axisProvenance?.[axis] ?? 'missing';
  if (value === undefined || !Number.isFinite(value)) return { axis, provenance: 'missing' };
  if (provenance !== 'measured' && provenance !== 'source-estimated') return { axis, provenance };
  if (axis === 'intelligence' && !isCompatibleIndexVersion(state.benchmarkIndexVersion)) {
    return { axis, provenance: 'missing', reason: 'incompatible-version' };
  }
  return { axis, provenance, normalized: NORMALIZE[axis](value) };
}

/** Interval of one normalized component in [0, 1]. */
export function componentInterval(observation: AxisObservation): Interval {
  if (observation.provenance === 'measured' && observation.normalized !== undefined) {
    return { center: observation.normalized, lower: observation.normalized, upper: observation.normalized };
  }
  if (observation.provenance === 'source-estimated' && observation.normalized !== undefined) {
    return { center: observation.normalized, lower: 0, upper: 1 };
  }
  return { center: MISSING_REPRESENTATIVE, lower: 0, upper: 1 };
}

const scale = (interval: Interval, factor: number): Interval =>
  ({ center: interval.center * factor, lower: interval.lower * factor, upper: interval.upper * factor });

const combine = (parts: ReadonlyArray<[Interval, number]>): Interval => ({
  center: parts.reduce((sum, [interval, share]) => sum + interval.center * share, 0),
  lower: parts.reduce((sum, [interval, share]) => sum + interval.lower * share, 0),
  upper: parts.reduce((sum, [interval, share]) => sum + interval.upper * share, 0),
});

const detail = (observation: AxisObservation): string =>
  `${observation.axis}:${observation.reason ?? observation.provenance}`;

const evidenceCode = (observations: readonly AxisObservation[]): FeatureEvidence['code'] =>
  observations.every((o) => o.provenance === 'measured' && o.normalized !== undefined) ? 'measured'
    : observations.some((o) => o.normalized !== undefined) ? 'source-estimated'
      : 'missing';

/**
 * Axes this decision requires evidence for that the row lacks: the phase's
 * axes, vision when the input has an image, and long-context quality when the
 * estimated context reaches the long-context relevance size. The result is a
 * diagnostic. Missing quality is already an uncertainty interval in the
 * features, so a gap does not remove an action from the comparison.
 */
export function evidenceGaps(row: BenchModel | undefined, demand: TaskDemand, benchmark: BenchmarkSnapshot): ProvenanceAxis[] {
  return demand.requiredEvidence.filter((axis) => observeAxis(row, axis, benchmark).normalized === undefined);
}

export interface CapabilityFeature {
  /** Diagnostic: optimistic shortfall on the axis scale. Missing quality cannot prove a deficit. */
  shortfall?: number;
  name: FeatureName;
  interval: Interval;
  evidence: FeatureEvidence;
}

export function capabilityFeatures(row: BenchModel | undefined, demand: TaskDemand, benchmark: BenchmarkSnapshot): CapabilityFeature[] {
  const { relevance, targets, collecting } = demand;
  const observe = (axis: ProvenanceAxis) => observeAxis(row, axis, benchmark);
  const intelligence = observe('intelligence');
  const terminalBench = observe('agenticCoding');
  const research = observe('research');
  const knowledge = observe('knowledge');
  const longContext = observe('longContext');
  const vision = observe('visionReasoning');

  const feature = (name: FeatureName, interval: Interval, observations: AxisObservation[], extra: string[] = []): CapabilityFeature => ({
    name,
    interval,
    evidence: { feature: name, code: evidenceCode(observations), mapping: FEATURE_MAPPING_VERSION, details: [...observations.map(detail), ...extra] },
  });

  const relevantInputs = [...(demand.longContext ? [longContext] : []), ...(demand.vision ? [vision] : [])];
  const input: CapabilityFeature = relevantInputs.length === 0
    ? {
      name: 'inputFit',
      interval: { center: INPUT_NOT_RELEVANT_VALUE, lower: INPUT_NOT_RELEVANT_VALUE, upper: INPUT_NOT_RELEVANT_VALUE },
      evidence: { feature: 'inputFit', code: 'not-relevant', mapping: FEATURE_MAPPING_VERSION },
    }
    : feature('inputFit', combine(relevantInputs.map((o) => [componentInterval(o), 1 / relevantInputs.length])), relevantInputs);

  // Fit increases with quality and decreases with demand. Cross the bounds accordingly.
  const fit = (interval: Interval, axis: keyof TaskRelevance): Interval => scale({
    center: capabilityFit(interval.center, targets[axis].center, axis),
    lower: capabilityFit(interval.lower, targets[axis].upper, axis),
    upper: capabilityFit(interval.upper, targets[axis].lower, axis),
  }, relevance[axis]);
  const demandFeature = (axis: keyof TaskRelevance, interval: Interval, observations: AxisObservation[], extra: string[] = []): CapabilityFeature => ({
    ...feature(`${axis}Fit`, fit(interval, axis), observations,
      [...extra, demand.details.difficulty, `target:${axis}:${targets[axis].center.toFixed(3)}`,
        `target-bounds:${axis}:${targets[axis].lower.toFixed(3)}:${targets[axis].upper.toFixed(3)}`]),
    // The optimistic diagnostic uses the easiest supported target and is not clipped.
    shortfall: relevance[axis] === 0 ? 0 : Math.max(0, (targets[axis].lower - interval.upper) / CAPABILITY_SHORTFALL[axis]),
  });
  return [
    demandFeature('reasoning', componentInterval(intelligence), [intelligence],
      [demand.details.openDecisions]),
    demandFeature('agentic', componentInterval(terminalBench), [terminalBench]),
    collecting ? {
      name: 'researchFit',
      interval: { center: ACQUISITION_RESEARCH_VALUE, lower: ACQUISITION_RESEARCH_VALUE, upper: ACQUISITION_RESEARCH_VALUE },
      shortfall: 0,
      evidence: { feature: 'researchFit', code: 'not-relevant', mapping: FEATURE_MAPPING_VERSION },
    } : demandFeature('research', combine([
      [componentInterval(research), RESEARCH_SHARE],
      [componentInterval(knowledge), KNOWLEDGE_SHARE],
    ]), [research, knowledge]),
    input,
  ];
}

