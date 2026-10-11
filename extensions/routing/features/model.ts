/**
 * Capability features from benchmark rows at the exact served effort.
 * `measured` gives an exact value. `source-estimated` gives the central value
 * but keeps the full missing interval. Every other provenance gives the
 * missing representative and interval. A row from another effort is never
 * used.
 */
import type { BenchModel, ProvenanceAxis } from '../../types.js';
import { compareMergeRows } from '../../bench/store.js';
import type { EffectiveAction } from './actions.js';
import {
  INPUT_NOT_RELEVANT_VALUE,
  KNOWLEDGE_SHARE,
  LONG_CONTEXT_RELEVANCE_TOKENS,
  MISSING_REPRESENTATIVE,
  OPEN_DECISIONS_REASONING,
  PHASE_RELEVANCE,
  RESEARCH_SHARE,
  normalizeFraction,
  normalizeIntelligence,
  normalizeKnowledge,
  normalizeResearch,
  normalizeTerminalBench,
  type TaskRelevance,
} from './mapping-v1.js';
import { FEATURE_MAPPING_VERSION, type AxisProvenance, type FeatureEvidence, type FeatureName } from './schema.js';
import type { DecisionStateV1 } from './state.js';

/** Intelligence Index versions whose scale `feature-v1` normalizes. Others give no evidence. */
export const INTELLIGENCE_INDEX_VERSIONS: readonly string[] = ['4.3'];

const majorMinor = (version: string | undefined): string | undefined =>
  version?.trim().replace(/^v/i, '').split('.').slice(0, 2).join('.') || undefined;

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
  return [...matching].sort(compareMergeRows)[0];
}

export function observeAxis(row: BenchModel | undefined, axis: ProvenanceAxis, state: Pick<DecisionStateV1, 'benchmarkIndexVersion'>): AxisObservation {
  const value = row?.quality[axis];
  const provenance = row?.axisProvenance?.[axis] ?? 'missing';
  if (value === undefined || !Number.isFinite(value)) return { axis, provenance: 'missing' };
  if (provenance !== 'measured' && provenance !== 'source-estimated') return { axis, provenance };
  if (axis === 'intelligence' && !INTELLIGENCE_INDEX_VERSIONS.includes(majorMinor(state.benchmarkIndexVersion) ?? '')) {
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

/** Task relevances from the phase and explicitly observed open decisions. */
export function taskRelevance(state: Pick<DecisionStateV1, 'phase' | 'openDecisions'>): TaskRelevance {
  const base = PHASE_RELEVANCE[state.phase];
  const openDecisions = state.openDecisions !== undefined && state.openDecisions > 0;
  return { ...base, reasoning: openDecisions ? Math.max(base.reasoning, OPEN_DECISIONS_REASONING) : base.reasoning };
}

export interface CapabilityFeature {
  name: FeatureName;
  interval: Interval;
  evidence: FeatureEvidence;
}

export function capabilityFeatures(row: BenchModel | undefined, state: DecisionStateV1): CapabilityFeature[] {
  const relevance = taskRelevance(state);
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

  return [
    feature('reasoningFit', scale(componentInterval(intelligence), relevance.reasoning), [intelligence],
      state.openDecisions === undefined ? ['openDecisions:unknown'] : [`openDecisions:${state.openDecisions}`]),
    feature('agenticFit', scale(componentInterval(terminalBench), relevance.agentic), [terminalBench]),
    feature('researchFit', scale(combine([
      [componentInterval(research), RESEARCH_SHARE],
      [componentInterval(knowledge), KNOWLEDGE_SHARE],
    ]), relevance.research), [research, knowledge]),
    input,
  ];
}
