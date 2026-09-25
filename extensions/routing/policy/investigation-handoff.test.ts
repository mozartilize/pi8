import { describe, expect, it } from 'vitest';
import { acceptInvestigationHandoff, investigationDimension } from './investigation-handoff.js';
import type { WorkPhaseState } from './work-phase.js';

const state = (over: Partial<WorkPhaseState> = {}): WorkPhaseState => ({
  intentKey: 'intent-a',
  terminal: {
    kind: 'gather', complexity: 'routine', scope: 'bounded', compound: false, confidence: 'high',
  },
  terminalBand: 'standard',
  providerInvocation: 2,
  observedMutationTools: 0,
  ...over,
});

describe('investigation handoff', () => {
  it('plans the rest of a gather entry once requested', () => {
    const requested = acceptInvestigationHandoff(state());
    expect(requested.planningRequested).toBe(true);
    expect(acceptInvestigationHandoff(requested)).toBe(requested);
    expect(investigationDimension(requested, 'gather')).toBe('plan');
  });

  it('changes nothing without a request, or for a task type other than gather', () => {
    expect(investigationDimension(state(), 'gather')).toBe('gather');
    expect(investigationDimension(undefined, 'gather')).toBe('gather');
    expect(investigationDimension(state({ planningRequested: true }), 'implement')).toBe('implement');
  });
});
