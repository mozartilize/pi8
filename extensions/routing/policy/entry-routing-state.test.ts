import { describe, expect, it } from 'vitest';
import {
  handoffBoundaryId,
  nextProviderInvocation,
  triageBoundaryId,
} from './entry-routing-state.js';
import type { EntryRoutingState } from './entry-routing-state.js';

const entryState = (over: Partial<EntryRoutingState> = {}): EntryRoutingState => ({
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

