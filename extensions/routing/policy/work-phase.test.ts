import { describe, expect, it } from 'vitest';
import {
  carryAcrossBranch,
  penaltiesOf,
  withContinuedPenalties,
  nextProviderInvocation,
} from './work-phase.js';
import type { WorkPhaseState } from './work-phase.js';

const entryState = (over: Partial<WorkPhaseState> = {}): WorkPhaseState => ({
  intentKey: 'intent-a',
  providerInvocation: 1,
  observedMutationTools: 0,
  ...over,
});

describe('nextProviderInvocation', () => {
  it('increments the invocation without mutating the prior state', () => {
    const prior = entryState();
    const next = nextProviderInvocation(prior);
    expect(next.providerInvocation).toBe(2);
    expect(prior.providerInvocation).toBe(1);
  });
});

describe('penaltiesOf / withContinuedPenalties', () => {
  const strikes = { contractStrikes: { 'beta/strong': 2 }, excludedExecutors: ['beta/strong'] };

  it('applies a work item\'s penalties only to an entry that continues or reopens that item', () => {
    const prior = penaltiesOf(entryState({ workItemId: 'w_1', ...strikes }));
    const next = entryState({ intentKey: 'intent-b', priorWork: prior! });
    expect(withContinuedPenalties(next, 'w_1', 'continue')).toMatchObject(strikes);
    expect(withContinuedPenalties(next, 'w_1', 'reopen')).toMatchObject(strikes);
    expect(withContinuedPenalties(next, 'w_2', 'reopen')).toBe(next);
    expect(withContinuedPenalties(next, 'w_2', 'continue')).toBe(next);
    expect(withContinuedPenalties(next, 'w_1', 'resume')).toBe(next);
    expect(withContinuedPenalties(next, undefined, 'unknown')).toBe(next);
  });

  it('passes penalties on through entries placed on no work item', () => {
    const received = penaltiesOf(entryState({ workItemId: 'w_1', ...strikes }));
    expect(penaltiesOf(entryState({ priorWork: received! }))).toEqual({ workItemId: 'w_1', ...strikes });
    expect(penaltiesOf(entryState({ workItemId: 'w_1' }))).toBeUndefined();
  });
});

describe('carryAcrossBranch', () => {
  it('keeps only the task type across branch navigation', () => {
    const prior = entryState({
      deliverable: 'gather',
      providerInvocation: 4,
      observedMutationTools: 2,
      contractStrikes: { 'beta/strong': 2 },
      excludedExecutors: ['beta/strong'],
      readPaths: ['/repo/a.ts'],
      contextStatus: 'acquiring',
      workItemId: 'w_a',
      contextReasons: ['carried-open-context'],
      contextSatisfied: false,
    });
    expect(carryAcrossBranch(prior, 'plan')).toEqual({
      intentKey: 'intent-a',
      deliverable: 'plan',
      providerInvocation: 4,
      observedMutationTools: 0,
    });
    expect(carryAcrossBranch(prior, undefined)).not.toHaveProperty('deliverable');
  });
});
