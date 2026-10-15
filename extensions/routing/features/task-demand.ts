/**
 * Task demand: the one owner that composes accepted declarations (phase,
 * open decisions, difficulty, context acquisition) with the measured
 * workload (estimated context size, image input). Capability features and
 * decision traces read the result; they do not compose demand again.
 */
import type { Dimension, ProvenanceAxis } from '../../types.js';
import { clamp01 } from './mapping.js';
import type { DemandInterval, TaskDifficulty, TaskSnapshot } from './state.js';

export type DemandAxis = keyof TaskRelevance;
const DEMAND_AXES: readonly DemandAxis[] = ['reasoning', 'agentic', 'research'];

export interface TaskDemand {
  /** Collecting context in the gather phase: the deliverable's demand is not yet known. */
  collecting: boolean;
  /** Phase relevance of each capability axis. */
  relevance: TaskRelevance;
  /** Declared difficulty on each axis, as an interval in [0, 1]. Unknown difficulty keeps the whole range. */
  demand: Readonly<Record<DemandAxis, DemandInterval>>;
  /** Capability target of each axis on the normalized benchmark scale. */
  targets: Readonly<Record<DemandAxis, DemandInterval>>;
  /** Long-context quality is relevant: the estimated context reaches the relevance size. */
  longContext: boolean;
  /** Vision quality is relevant: the input has an image. */
  vision: boolean;
  /** Axes that need benchmark evidence. A missing axis is a diagnostic only. */
  requiredEvidence: readonly ProvenanceAxis[];
  /** Evidence details of the declarations. */
  details: { difficulty: string; openDecisions: string };
}

const point = (value: number): DemandInterval => ({ center: value, lower: value, upper: value });

/** Phase relevance stays independent of capability demand and price. */
function taskRelevance(task: Pick<TaskSnapshot, 'phase' | 'openDecisions'>): TaskRelevance {
  const base = PHASE_RELEVANCE[task.phase];
  const openDecisions = task.openDecisions !== undefined && task.openDecisions > 0;
  const reasoning = openDecisions ? Math.max(base.reasoning, OPEN_DECISIONS_REASONING) : base.reasoning;
  return { reasoning, agentic: base.agentic, research: base.research };
}

export function composeTaskDemand(task: TaskSnapshot): TaskDemand {
  const collecting = task.phase === 'gather' && task.contextAcquisition === true;
  const longContext = task.estimatedContextTokens >= LONG_CONTEXT_RELEVANCE_TOKENS;
  const vision = task.needsVision;
  const demand = Object.fromEntries(DEMAND_AXES.map((axis) => [axis, demandInterval(task.difficulty, axis)])) as Record<DemandAxis, DemandInterval>;
  const target = (axis: DemandAxis): DemandInterval => {
    // Collecting context has a fixed reasoning target, independent of the deliverable's unknown demand.
    if (collecting && axis === 'reasoning') return point(ACQUISITION_REASONING_TARGET);
    const { center, lower, upper } = demand[axis];
    return { center: capabilityTarget(axis, center), lower: capabilityTarget(axis, lower), upper: capabilityTarget(axis, upper) };
  };
  const required = new Set<ProvenanceAxis>(collecting ? ['intelligence'] : REQUIRED_EVIDENCE_AXES[task.phase]);
  if (vision) required.add('visionReasoning');
  if (longContext) required.add('longContext');
  return {
    collecting,
    relevance: taskRelevance(task),
    demand,
    targets: { reasoning: target('reasoning'), agentic: target('agentic'), research: target('research') },
    longContext,
    vision,
    requiredEvidence: [...required],
    details: {
      difficulty: task.difficulty ? `difficulty:${task.difficulty.source}:${task.difficulty.value.toFixed(3)}` : 'difficulty:unknown',
      openDecisions: task.openDecisions === undefined ? 'openDecisions:unknown' : `openDecisions:${task.openDecisions}`,
    },
  };
}

/**
 * Estimated context size from which long-context quality is relevant. This is
 * an input-shape relevance rule, not a model capability minimum.
 */
export const LONG_CONTEXT_RELEVANCE_TOKENS = 64_000;
export interface TaskRelevance {
  /** Reasoning relevance R. */
  reasoning: number;
  /** Agentic coding relevance D. */
  agentic: number;
  /** Research relevance H. */
  research: number;
}

export const PHASE_RELEVANCE: Readonly<Record<Dimension, TaskRelevance>> = {
  lightweight: { reasoning: 0.15, agentic: 0, research: 0.1 },
  gather: { reasoning: 0.4, agentic: 0, research: 1 },
  plan: { reasoning: 1, agentic: 0.25, research: 0.5 },
  implement: { reasoning: 0.6, agentic: 1, research: 0.15 },
  review: { reasoning: 1, agentic: 0.5, research: 0.8 },
};

/** Reasoning relevance when open decisions are explicitly observed (> 0). */
export const OPEN_DECISIONS_REASONING = 0.9;
/** Capability targets use absolute normalized benchmark scales, not pool ranks. */
export const CAPABILITY_TARGETS: Readonly<Record<keyof TaskRelevance, readonly [number, number]>> = {
  reasoning: [0.2, 0.55],
  agentic: [0.01, 0.6],
  research: [0.25, 0.65],
};

/** Collecting context has a fixed reasoning target, independent of the deliverable's unknown demand. */
export const ACQUISITION_REASONING_TARGET = 0.20;
/** Unknown demand retains the whole range. A valid declaration supplies an axis-specific bound. */
export function demandInterval(difficulty: TaskDifficulty | undefined, axis: keyof TaskRelevance): DemandInterval {
  const value = difficulty?.axes?.[axis] ?? difficulty?.value;
  const bounds = difficulty?.bounds?.[axis];
  if (value === undefined || !Number.isFinite(value)
    || (bounds && (!Number.isFinite(bounds.lower) || !Number.isFinite(bounds.upper)
      || bounds.lower > value || bounds.upper < value))) return { center: 0.5, lower: 0, upper: 1 };
  return { center: clamp01(value), lower: clamp01(bounds?.lower ?? value), upper: clamp01(bounds?.upper ?? value) };
}

/** Target of one known demand value. Unknown demand is represented by `demandInterval`. */
export function capabilityTarget(axis: keyof TaskRelevance, difficulty: number): number {
  const [easy, hard] = CAPABILITY_TARGETS[axis];
  return easy + (hard - easy) * clamp01(difficulty);
}
/**
 * Quality axes whose evidence a decision reports for each model: the axes
 * this phase relies on most. Evidence means a measured value or a
 * same-metric, same-model, same-effort source estimate. A model without it
 * is reported in the decision's evidence gaps and still competes in the same
 * pool, with the full uncertainty interval for the missing quality.
 * `lightweight` relies on no single axis. Collecting context requires
 * Intelligence instead of the gather deliverable's Research evidence.
 */
export const REQUIRED_EVIDENCE_AXES: Readonly<Record<Dimension, readonly ProvenanceAxis[]>> = {
  lightweight: [],
  gather: ['research'],
  plan: ['intelligence'],
  implement: ['intelligence', 'agenticCoding'],
  review: ['intelligence'],
};
