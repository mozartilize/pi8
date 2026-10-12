/**
 * Task difficulty D in [0, 1] of the next phase, from the accepted handoff or
 * plan. The requester declares a rubric. The router adds the facts it
 * measures itself: file and directory counts, existing lines and fix commits
 * of the targets. `execution-difficulty.ts` owns the weights of both; this
 * module only rescales its result from [base, 1] to [0, 1]. A measurement
 * that failed counts as harder, never easier.
 *
 * D is an input of the feature mapping, not a capability minimum. No rubric
 * means unknown difficulty, which is different from an easy task.
 */
import type { Dimension, ExecutionRubric, HandoffRubric, MeasuredFeatures, ReasoningEvidence, ReasoningRubric } from '../../types.js';
import {
  BASE_REQUIREMENT,
  REASONING_BASE_REQUIREMENT,
  executionRequirement,
  reasoningRequirement,
} from '../policy/execution-difficulty.js';
import type { WorkPhaseState } from '../policy/work-phase.js';
import { clamp01 } from './mapping.js';
import type { TaskDifficulty } from './state.js';

const rescale = (value: number, base: number): number => clamp01((value - base) / (1 - base));

const isExecutionRubric = (rubric: HandoffRubric): rubric is ExecutionRubric => 'openDecisions' in rubric;

export function executionDifficulty(rubric: ExecutionRubric, measured: MeasuredFeatures | ReasoningEvidence): TaskDifficulty {
  return { value: rescale(executionRequirement(rubric, measured), BASE_REQUIREMENT), source: 'execution-rubric' };
}

export function reasoningDifficulty(rubric: ReasoningRubric, evidence: ReasoningEvidence): TaskDifficulty {
  return { value: rescale(reasoningRequirement(rubric, evidence), REASONING_BASE_REQUIREMENT), source: 'reasoning-rubric' };
}

/**
 * Difficulty of `phase` in this entry. An active or executed plan describes
 * implementation. Otherwise an accepted handoff describes the phase it
 * targets. Any other phase has unknown difficulty.
 */
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
