/**
 * Task demand: the one owner that composes accepted declarations (phase,
 * open decisions, difficulty, context acquisition) with the measured
 * workload (estimated context size, image input). Capability features and
 * decision traces read the result; they do not compose demand again.
 */
import type { ProvenanceAxis } from '../../types.js';
import {
  ACQUISITION_REASONING_TARGET,
  LONG_CONTEXT_RELEVANCE_TOKENS,
  OPEN_DECISIONS_REASONING,
  PHASE_RELEVANCE,
  REQUIRED_EVIDENCE_AXES,
  capabilityTarget,
  demandInterval,
  type TaskRelevance,
} from './mapping.js';
import type { DemandInterval, TaskSnapshot } from './state.js';

export type DemandAxis = keyof TaskRelevance;
export const DEMAND_AXES: readonly DemandAxis[] = ['reasoning', 'agentic', 'research'];

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
