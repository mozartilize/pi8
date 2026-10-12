import { describe, expect, it } from 'vitest';

import type { ExecutionRubric, MeasuredFeatures, ReasoningEvidence, ReasoningRubric } from '../../types.js';
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

  it('adds what the router measures, and a failed measurement counts as harder', () => {
    const wide: MeasuredFeatures = { ...small, files: 8, directories: 5, existingLines: 6000, fixCommits: 6 };
    const failed: MeasuredFeatures = { ...small, existingLines: undefined, fixCommits: undefined };
    const easy = executionDifficulty(execution(1), small).value;
    expect(executionDifficulty(execution(1), wide).value).toBeGreaterThan(easy);
    expect(executionDifficulty(execution(1), failed).value).toBeGreaterThan(easy);
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
    expect(phaseDifficulty(planned, 'plan')).toEqual({ value: 1, source: 'reasoning-rubric' });
    expect(phaseDifficulty(planned, 'implement')).toBeUndefined();
    const implementation = state({ reasoningHandoff: handoff('implement', execution(1)) });
    expect(phaseDifficulty(implementation, 'implement')).toEqual({ value: 0, source: 'execution-rubric' });
  });

  it('uses an active plan rubric and its measurements for implementation', () => {
    const contract = { status: 'active', rubric: execution(5), measured: small } as unknown as WorkPhaseState['contract'];
    const planned = state({ reasoningHandoff: handoff('plan', reasoning(1)), contract });
    expect(phaseDifficulty(planned, 'implement')).toMatchObject({ value: 1, source: 'execution-rubric' });
  });
});
