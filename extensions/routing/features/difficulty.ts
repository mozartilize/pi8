/**
 * Demand of the next phase, from its accepted rubric and measured targets.
 * Independent requirements use their maximum: easy criteria must not dilute
 * an unresolved design choice or missing evidence. File measurements add only
 * to agentic demand. No rubric means unknown, not easy.
 */
import type { Dimension, ExecutionRubric, HandoffRubric, MeasuredFeatures, ReasoningEvidence, ReasoningRubric } from '../../types.js';
import type { WorkPhaseState } from '../policy/work-phase.js';
import { clamp01 } from './mapping.js';
import type { TaskDifficulty } from './state.js';

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

/** Only an accepted rubric for this phase supplies its demand. */
export function phaseDifficulty(state: WorkPhaseState | undefined, phase: Dimension): TaskDifficulty | undefined {
  const contract = state?.contract;
  if (phase === 'implement' && contract?.rubric && (contract.status === 'active' || contract.status === 'executed')) {
    return executionDifficulty(contract.rubric, contract.measured);
  }
  const handoff = state?.reasoningHandoff;
  if (!handoff?.rubric || handoff.target !== phase) return undefined;
  return isExecutionRubric(handoff.rubric)
    ? executionDifficulty(handoff.rubric, handoff.evidence)
    : reasoningDifficulty(handoff.rubric, handoff.evidence);
}
