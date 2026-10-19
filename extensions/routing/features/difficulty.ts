/**
 * Demand of the next phase, from its accepted rubric and measured targets.
 * Independent requirements use their maximum: easy criteria must not dilute
 * an unresolved design choice or missing evidence. File measurements add only
 * to agentic demand. Without a rubric, declared complexity supplies bounds.
 * Without either declaration the demand remains unknown, not easy.
 */
import type { ComplexityBand, Dimension, ExecutionRubric, HandoffRubric, MeasuredFeatures, ReasoningEvidence, ReasoningRubric, TaskScope } from '../../types.js';
import type { WorkPhaseState } from '../policy/work-phase.js';
import { clamp01 } from './mapping.js';
import type { DemandInterval, TaskDifficulty } from './state.js';

const isExecutionRubric = (rubric: HandoffRubric): rubric is ExecutionRubric => 'openDecisions' in rubric;
const level = (value: number): number => Number.isFinite(value) ? clamp01((value - 1) / 4) : 1;

/** File measurements supplement the rubric by at most 0.2. Failed measurements add their maximum. */
function measuredDemand(measured: MeasuredFeatures | ReasoningEvidence): number {
  if ('applicable' in measured && !measured.applicable) return 0;
  const known = (value: number | undefined, scale: (value: number) => number): number =>
    value === undefined || !Number.isFinite(value) ? 1 : clamp01(scale(value));
  return 0.05 * (
    known(measured.files, (value) => (value - 1) / 4)
    + known(measured.directories, (value) => (value - 1) / 3)
    + known(measured.existingLines, (value) => Math.log2(Math.max(value, 1) / 250) / 4)
    + known(measured.fixCommits, (value) => value / 5)
  );
}

function difficulty(axes: NonNullable<TaskDifficulty['axes']>, source: TaskDifficulty['source']): TaskDifficulty {
  return { value: Math.max(axes.reasoning, axes.agentic, axes.research), axes, source };
}

export function executionDifficulty(rubric: ExecutionRubric, measured: MeasuredFeatures | ReasoningEvidence): TaskDifficulty {
  const open = level(rubric.openDecisions);
  const knowledge = level(rubric.knowledge);
  const coupling = level(rubric.coupling);
  return difficulty({
    reasoning: Math.max(open, knowledge, coupling),
    agentic: clamp01(Math.max(open, level(rubric.spread), level(rubric.verification), coupling) + measuredDemand(measured)),
    research: Math.max(open, knowledge),
  }, 'execution-rubric');
}

export function reasoningDifficulty(rubric: ReasoningRubric, evidence: ReasoningEvidence): TaskDifficulty {
  const uncertainty = level(rubric.uncertainty);
  const stakes = level(rubric.stakes);
  return difficulty({
    reasoning: Math.max(level(rubric.alternatives), stakes, level(rubric.knowledge), uncertainty),
    agentic: clamp01(Math.max(level(rubric.spread), stakes, uncertainty) + measuredDemand(evidence)),
    research: Math.max(level(rubric.knowledge), uncertainty),
  }, 'reasoning-rubric');
}

/** A rubric takes precedence over coarse complexity. Measurements can only increase its agentic demand. */
function declaredDifficulty(declaration: {
  rubric?: HandoffRubric; complexity?: ComplexityBand; scope?: TaskScope; evidence: ReasoningEvidence;
}): TaskDifficulty | undefined {
  const { rubric, complexity, scope, evidence } = declaration;
  if (rubric) return isExecutionRubric(rubric) ? executionDifficulty(rubric, evidence) : reasoningDifficulty(rubric, evidence);
  const interval = complexity && COMPLEXITY_DEMAND[complexity];
  if (!interval) return undefined;
  const extra = measuredDemand(evidence);
  const agentic = {
    center: clamp01(interval.center + extra),
    lower: clamp01(interval.lower + extra),
    // Open-ended scope cannot bound the amount of tool work without a rubric.
    upper: scope === 'open-ended' ? 1 : clamp01(interval.upper + extra),
  };
  return {
    ...difficulty({ reasoning: interval.center, agentic: agentic.center, research: interval.center }, 'declared-complexity'),
    bounds: {
      reasoning: { lower: interval.lower, upper: interval.upper },
      agentic: { lower: agentic.lower, upper: agentic.upper },
      research: { lower: interval.lower, upper: interval.upper },
    },
  };
}

/** Only declarations accepted in this entry for the routed phase supply its demand. */
export function phaseDifficulty(state: WorkPhaseState | undefined, phase: Dimension): TaskDifficulty | undefined {
  const contract = state?.contract;
  if (phase === 'implement' && contract?.rubric && (contract.status === 'active' || contract.status === 'executed')) {
    return executionDifficulty(contract.rubric, contract.measured);
  }
  const handoff = state?.reasoningHandoff;
  if (handoff) return handoff.target === phase ? declaredDifficulty(handoff) : undefined;
  // A declared direct answer is served in the gather phase.
  if (state?.contextAnswer && state.contextAnswerDemand && phase === 'gather') {
    return declaredDifficulty(state.contextAnswerDemand);
  }
  return undefined;
}

/** Complexity bands span half a rubric step on each side, clipped to [0, 1]. These are policy bounds, not confidence intervals. */
export const COMPLEXITY_DEMAND: Readonly<Record<ComplexityBand, Readonly<DemandInterval>>> = {
  trivial: { center: 0, lower: 0, upper: 0.125 },
  routine: { center: 0.25, lower: 0.125, upper: 0.375 },
  moderate: { center: 0.5, lower: 0.375, upper: 0.625 },
  hard: { center: 0.75, lower: 0.625, upper: 0.875 },
  frontier: { center: 1, lower: 0.875, upper: 1 },
};
