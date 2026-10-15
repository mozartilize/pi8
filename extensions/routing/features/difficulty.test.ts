import { describe, expect, it } from 'vitest';

import type { ComplexityBand, ExecutionRubric, MeasuredFeatures, ReasoningEvidence, ReasoningRubric } from '../../types.js';
import { demandInterval } from './task-demand.js';
import type { WorkPhaseState } from '../policy/work-phase.js';
import { executionDifficulty, phaseDifficulty, reasoningDifficulty } from './difficulty.js';

const levels = <K extends string>(keys: readonly K[], level: number) =>
  Object.fromEntries(keys.map((key) => [key, level])) as Record<K, number>;
const execution = (level: number) => levels(['openDecisions', 'spread', 'verification', 'knowledge', 'coupling'] as const, level) as ExecutionRubric;
const reasoning = (level: number) => levels(['alternatives', 'stakes', 'spread', 'knowledge', 'uncertainty'] as const, level) as ReasoningRubric;
const noFiles: ReasoningEvidence = { applicable: false, files: 0, directories: 0 };
const small: MeasuredFeatures = { files: 1, directories: 1, steps: 1, testTargets: 0, existingLines: 100, fixCommits: 0 };

describe('task difficulty from a rubric and router measurements', () => {
  it('spans [0, 1] from the easiest to the hardest rubric', () => {
    expect(executionDifficulty(execution(1), noFiles).value).toBe(0);
    expect(executionDifficulty(execution(5), noFiles).value).toBe(1);
    expect(reasoningDifficulty(reasoning(1), noFiles).value).toBe(0);
    expect(reasoningDifficulty(reasoning(5), noFiles).value).toBe(1);
  });

  it('is continuous: each rubric level raises it', () => {
    const values = [1, 2, 3, 4, 5].map((level) => executionDifficulty(execution(level), noFiles).value);
    values.slice(1).forEach((value, i) => expect(value).toBeGreaterThan(values[i]!));
    expect(values.filter((value) => value > 0 && value < 1)).toHaveLength(3);
  });

  it('keeps distinct axis demands and does not average away an open requirement', () => {
    expect(executionDifficulty({ ...execution(1), knowledge: 5 }, noFiles).axes)
      .toEqual({ reasoning: 1, agentic: 0, research: 1 });
    expect(executionDifficulty({ ...execution(1), verification: 4 }, noFiles).axes)
      .toEqual({ reasoning: 0, agentic: 0.75, research: 0 });
    expect(executionDifficulty({ ...execution(1), openDecisions: 5 }, noFiles).axes)
      .toEqual({ reasoning: 1, agentic: 1, research: 1 });
    expect(reasoningDifficulty({ ...reasoning(1), uncertainty: 5 }, noFiles).axes)
      .toEqual({ reasoning: 1, agentic: 1, research: 1 });
    expect(reasoningDifficulty({ ...reasoning(1), alternatives: 4 }, noFiles).axes)
      .toEqual({ reasoning: 0.75, agentic: 0, research: 0 });
  });

  it('adds what the router measures, and a failed measurement counts as harder', () => {
    const wide: MeasuredFeatures = { ...small, files: 8, directories: 5, existingLines: 6000, fixCommits: 6 };
    const failed: MeasuredFeatures = { ...small, existingLines: undefined, fixCommits: undefined };
    const easy = executionDifficulty(execution(1), small).value;
    expect(executionDifficulty(execution(1), wide).value).toBeGreaterThan(easy);
    expect(executionDifficulty(execution(1), failed).value).toBeGreaterThan(easy);
    expect(executionDifficulty(execution(1), failed).axes).toEqual({ reasoning: 0, agentic: 0.1, research: 0 });
    expect(executionDifficulty(execution(1), wide).axes).toEqual({ reasoning: 0, agentic: 0.2, research: 0 });
  });
});

describe('difficulty of the routed phase', () => {
  const state = (patch: Partial<WorkPhaseState>): WorkPhaseState =>
    ({ intentKey: 'k', providerInvocation: 1, observedMutationTools: 0, ...patch });
  const handoff = (target: 'plan' | 'review' | 'implement', rubric: ExecutionRubric | ReasoningRubric | undefined) => ({
    id: 'h', requester: 'a/A', target, pending: true, evidence: noFiles, ...(rubric ? { rubric } : {}),
  });

  it('is unknown without a declared rubric', () => {
    expect(phaseDifficulty(undefined, 'plan')).toBeUndefined();
    expect(phaseDifficulty(state({}), 'implement')).toBeUndefined();
    expect(phaseDifficulty(state({ reasoningHandoff: handoff('plan', undefined) }), 'plan')).toBeUndefined();
  });

  it('applies a handoff rubric only to the phase it targets', () => {
    const planned = state({ reasoningHandoff: handoff('plan', reasoning(5)) });
    expect(phaseDifficulty(planned, 'plan')).toEqual({ value: 1, axes: { reasoning: 1, agentic: 1, research: 1 }, source: 'reasoning-rubric' });
    expect(phaseDifficulty(planned, 'implement')).toBeUndefined();
    const implementation = state({ reasoningHandoff: handoff('implement', execution(1)) });
    expect(phaseDifficulty(implementation, 'implement')).toEqual({ value: 0, axes: { reasoning: 0, agentic: 0, research: 0 }, source: 'execution-rubric' });
  });

  it.each([
    ['trivial', 0, 0, 0.125], ['routine', 0.25, 0.125, 0.375], ['moderate', 0.5, 0.375, 0.625],
    ['hard', 0.75, 0.625, 0.875], ['frontier', 1, 0.875, 1],
  ] as const)('bounds a rubric-free %s handoff by the declared complexity', (complexity, center, lower, upper) => {
    const planned = state({ reasoningHandoff: { ...handoff('plan', undefined), complexity, scope: 'bounded' } });
    const result = phaseDifficulty(planned, 'plan');
    expect(result?.source).toBe('declared-complexity');
    for (const axis of ['reasoning', 'agentic', 'research'] as const) {
      expect(demandInterval(result, axis)).toEqual({ center, lower, upper });
    }
    expect(phaseDifficulty(planned, 'review')).toBeUndefined();
  });

  it('does not let a low complexity label override a difficult rubric', () => {
    const planned = state({ reasoningHandoff: { ...handoff('plan', reasoning(5)), complexity: 'trivial' } });
    expect(demandInterval(phaseDifficulty(planned, 'plan'), 'reasoning')).toEqual({ center: 1, lower: 1, upper: 1 });
  });

  it('adds measured evidence to agentic bounds without reducing other demands', () => {
    const planned = state({ reasoningHandoff: { ...handoff('plan', undefined), complexity: 'routine',
      evidence: { applicable: true, files: 5, directories: 4, existingLines: 4000, fixCommits: 5 },
    } });
    const result = phaseDifficulty(planned, 'plan');
    expect(demandInterval(result, 'agentic')).toEqual({ center: 0.45, lower: 0.325, upper: 0.575 });
    expect(demandInterval(result, 'research')).toEqual({ center: 0.25, lower: 0.125, upper: 0.375 });
    const failed = phaseDifficulty(state({ reasoningHandoff: { ...planned.reasoningHandoff!,
      evidence: { applicable: true, files: 1, directories: 1 },
    } }), 'plan');
    expect(demandInterval(failed, 'agentic').upper).toBeCloseTo(0.475);
  });

  it('keeps open-ended tool work unbounded without a rubric, and saturates measured additions', () => {
    const declared = { ...handoff('plan', undefined), complexity: 'routine' as ComplexityBand, scope: 'open-ended' as const };
    expect(demandInterval(phaseDifficulty(state({ reasoningHandoff: declared }), 'plan'), 'agentic'))
      .toEqual({ center: 0.25, lower: 0.125, upper: 1 });
    const frontier = { ...declared, complexity: 'frontier' as const,
      evidence: { applicable: true, files: 10, directories: 10, existingLines: 10000, fixCommits: 10 } };
    expect(demandInterval(phaseDifficulty(state({ reasoningHandoff: frontier }), 'plan'), 'agentic'))
      .toEqual({ center: 1, lower: 1, upper: 1 });
  });

  it('uses an active plan rubric and its measurements for implementation', () => {
    const contract = { status: 'active', rubric: execution(5), measured: small } as unknown as WorkPhaseState['contract'];
    const planned = state({ reasoningHandoff: handoff('plan', reasoning(1)), contract });
    expect(phaseDifficulty(planned, 'implement')).toMatchObject({ value: 1, source: 'execution-rubric' });
  });

  it('a broken contract supplies no implementation demand', () => {
    const contract = { status: 'broken', rubric: execution(5), measured: small } as unknown as WorkPhaseState['contract'];
    expect(phaseDifficulty(state({ contract }), 'implement')).toBeUndefined();
  });

  it('direct-answer demand applies only to the gather phase of its entry', () => {
    const answer = state({ contextAnswer: 'gather', contextAnswerDemand: { complexity: 'hard', scope: 'bounded', evidence: noFiles } });
    expect(phaseDifficulty(answer, 'gather')).toMatchObject({ source: 'declared-complexity' });
    for (const phase of ['lightweight', 'plan', 'review', 'implement'] as const) expect(phaseDifficulty(answer, phase), phase).toBeUndefined();
    expect(phaseDifficulty(state({ contextAnswerDemand: answer.contextAnswerDemand! }), 'gather')).toBeUndefined();
  });

  it('a handoff in the entry replaces direct-answer demand, even for another phase', () => {
    const both = state({
      reasoningHandoff: handoff('plan', reasoning(1)),
      contextAnswer: 'gather', contextAnswerDemand: { complexity: 'hard', scope: 'bounded', evidence: noFiles },
    });
    expect(phaseDifficulty(both, 'gather')).toBeUndefined();
  });
});
