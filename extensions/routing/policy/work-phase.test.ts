import { describe, expect, it } from 'vitest';
import {
  carryAcrossBranch,
  handoffBoundaryId,
  nextProviderInvocation,
  triageBoundaryId,
} from './work-phase.js';
import { newExecutionFlow } from './execution-flow.js';
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

describe('routing boundary ids', () => {
  it('names the triage boundary from the entry and the routing epoch', () => {
    expect(triageBoundaryId('u1', 0)).toBe('triage:u1:0');
    expect(triageBoundaryId('u1', 1)).not.toBe(triageBoundaryId('u1', 0));
    expect(triageBoundaryId('u2', 0)).not.toBe(triageBoundaryId('u1', 0));
  });

  it('gives the same id to the same accepted payload and another id to another payload or epoch', () => {
    const id = handoffBoundaryId('u1', 0, '{"deliverable":"implement"}');
    expect(id).toBe(handoffBoundaryId('u1', 0, '{"deliverable":"implement"}'));
    expect(id).toMatch(/^handoff:u1:0:/);
    expect(handoffBoundaryId('u1', 0, '{"deliverable":"gather"}')).not.toBe(id);
    expect(handoffBoundaryId('u1', 1, '{"deliverable":"implement"}')).not.toBe(id);
  });
});

describe('carryAcrossBranch', () => {
  it('keeps only the task type across branch navigation', () => {
    const prior = entryState({
      deliverable: 'gather',
      providerInvocation: 4,
      observedMutationTools: 2,
      executionFlow: { ...newExecutionFlow('intent-a', 'b'), strikesByModel: { 'beta/strong': 2 }, excludedModels: ['beta/strong'] },
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
