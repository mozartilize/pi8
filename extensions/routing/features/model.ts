/**
 * Capability features from benchmark rows at the exact served effort.
 * `measured` gives an exact value. `source-estimated` gives the central value
 * but keeps the full missing interval. Every other provenance gives the
 * missing representative and interval. A row from another effort is never
 * used.
 */
import type { BenchModel, ProvenanceAxis } from '../../types.js';
import { selectMergeRow } from '../../bench/store.js';
import type { EffectiveAction } from './actions.js';
import {
  INPUT_NOT_RELEVANT_VALUE,
  KNOWLEDGE_SHARE,
  LONG_CONTEXT_RELEVANCE_TOKENS,
  MISSING_REPRESENTATIVE,
  OPEN_DECISIONS_REASONING,
  PHASE_RELEVANCE,
  REQUIRED_EVIDENCE_AXES,
  RESEARCH_SHARE,
  normalizeFraction,
  normalizeIntelligence,
  normalizeKnowledge,
  normalizeResearch,
  normalizeTerminalBench,
  capabilityFit,
  capabilityTarget,
  demandInterval,
  CAPABILITY_SHORTFALL,
  ACQUISITION_REASONING_TARGET,
  ACQUISITION_RESEARCH_VALUE,
  type TaskRelevance,
} from './mapping.js';
import { FEATURE_MAPPING_VERSION, type AxisProvenance, type FeatureEvidence, type FeatureName } from './schema.js';
import type { DecisionStateV1 } from './state.js';

/** Intelligence Index versions whose scale the feature mapping normalizes. Others give no evidence. */
export const INTELLIGENCE_INDEX_VERSIONS: readonly string[] = ['4.3'];

const majorMinor = (version: string | undefined): string | undefined =>
  version?.trim().replace(/^v/i, '').split('.').slice(0, 2).join('.') || undefined;

/** True when the feature mapping normalizes this Intelligence Index version. */
export const isCompatibleIndexVersion = (version: string | undefined): boolean =>
  INTELLIGENCE_INDEX_VERSIONS.includes(majorMinor(version) ?? '');

export interface Interval {
  center: number;
  lower: number;
  upper: number;
}

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

export function observeAxis(row: BenchModel | undefined, axis: ProvenanceAxis, state: Pick<DecisionStateV1, 'benchmarkIndexVersion'>): AxisObservation {
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

/** Phase relevance stays independent of capability demand and price. */
export function taskRelevance(state: Pick<DecisionStateV1, 'phase' | 'openDecisions' | 'difficulty'>): TaskRelevance {
  const base = PHASE_RELEVANCE[state.phase];
  const openDecisions = state.openDecisions !== undefined && state.openDecisions > 0;
  const reasoning = openDecisions ? Math.max(base.reasoning, OPEN_DECISIONS_REASONING) : base.reasoning;
  return { reasoning, agentic: base.agentic, research: base.research };
}

/** Evidence detail of the task difficulty. */
export const difficultyDetail = (state: Pick<DecisionStateV1, 'difficulty'>): string =>
  state.difficulty ? `difficulty:${state.difficulty.source}:${state.difficulty.value.toFixed(3)}` : 'difficulty:unknown';

/**
 * Axes this decision requires evidence for that the row lacks: the phase's
 * axes, vision when the input has an image, and long-context quality when the
 * estimated context reaches the long-context relevance size. The result is a
 * diagnostic. Missing quality is already an uncertainty interval in the
 * features, so a gap does not remove an action from the comparison.
 */
export function evidenceGaps(row: BenchModel | undefined, state: DecisionStateV1): ProvenanceAxis[] {
  const collecting = state.phase === 'gather' && state.contextAcquisition === true;
  const required = new Set<ProvenanceAxis>(collecting ? ['intelligence'] : REQUIRED_EVIDENCE_AXES[state.phase]);
  if (state.needsVision) required.add('visionReasoning');
  if (state.estimatedContextTokens >= LONG_CONTEXT_RELEVANCE_TOKENS) required.add('longContext');
  return [...required].filter((axis) => observeAxis(row, axis, state).normalized === undefined);
}

export interface CapabilityFeature {
  /** Diagnostic: optimistic shortfall on the axis scale. Missing quality cannot prove a deficit. */
  shortfall?: number;
  name: FeatureName;
  interval: Interval;
  evidence: FeatureEvidence;
}

export function capabilityFeatures(row: BenchModel | undefined, state: DecisionStateV1): CapabilityFeature[] {
  const relevance = taskRelevance(state);
  const collecting = state.phase === 'gather' && state.contextAcquisition === true;
  const observe = (axis: ProvenanceAxis) => observeAxis(row, axis, state);
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

  const longRelevant = state.estimatedContextTokens >= LONG_CONTEXT_RELEVANCE_TOKENS;
  const relevantInputs = [...(longRelevant ? [longContext] : []), ...(state.needsVision ? [vision] : [])];
  const input: CapabilityFeature = relevantInputs.length === 0
    ? {
      name: 'inputFit',
      interval: { center: INPUT_NOT_RELEVANT_VALUE, lower: INPUT_NOT_RELEVANT_VALUE, upper: INPUT_NOT_RELEVANT_VALUE },
      evidence: { feature: 'inputFit', code: 'not-relevant', mapping: FEATURE_MAPPING_VERSION },
    }
    : feature('inputFit', combine(relevantInputs.map((o) => [componentInterval(o), 1 / relevantInputs.length])), relevantInputs);

  const difficulty = difficultyDetail(state);
  const target = (axis: keyof TaskRelevance): Interval => {
    if (collecting && axis === 'reasoning') return {
      center: ACQUISITION_REASONING_TARGET, lower: ACQUISITION_REASONING_TARGET, upper: ACQUISITION_REASONING_TARGET,
    };
    const demand = demandInterval(state.difficulty, axis);
    return { center: capabilityTarget(axis, demand.center), lower: capabilityTarget(axis, demand.lower), upper: capabilityTarget(axis, demand.upper) };
  };
  const targets = { reasoning: target('reasoning'), agentic: target('agentic'), research: target('research') };
  // Fit increases with quality and decreases with demand. Cross the bounds accordingly.
  const fit = (interval: Interval, axis: keyof TaskRelevance): Interval => scale({
    center: capabilityFit(interval.center, targets[axis].center, axis),
    lower: capabilityFit(interval.lower, targets[axis].upper, axis),
    upper: capabilityFit(interval.upper, targets[axis].lower, axis),
  }, relevance[axis]);
  const demandFeature = (axis: keyof TaskRelevance, interval: Interval, observations: AxisObservation[], extra: string[] = []): CapabilityFeature => ({
    ...feature(`${axis}Fit`, fit(interval, axis), observations,
      [...extra, difficulty, `target:${axis}:${targets[axis].center.toFixed(3)}`,
        `target-bounds:${axis}:${targets[axis].lower.toFixed(3)}:${targets[axis].upper.toFixed(3)}`]),
    // The optimistic diagnostic uses the easiest supported target and is not clipped.
    shortfall: relevance[axis] === 0 ? 0 : Math.max(0, (targets[axis].lower - interval.upper) / CAPABILITY_SHORTFALL[axis]),
  });
  return [
    demandFeature('reasoning', componentInterval(intelligence), [intelligence],
      [state.openDecisions === undefined ? 'openDecisions:unknown' : `openDecisions:${state.openDecisions}`]),
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
