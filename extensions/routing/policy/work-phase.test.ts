import { describe, expect, it } from 'vitest';
import {
  advanceForRoutingOwner,
  capabilityBandFor,
  deriveInitialPhase,
  floorForBand,
  inheritThinContinuation,
  nextProviderInvocation,
  scoringPolicyForState,
  terminalRequirement,
} from './work-phase.js';
import type { TerminalAssessment } from '../../types.js';
import type { WorkPhaseState } from './work-phase.js';

const terminal = (over: Partial<TerminalAssessment> = {}): TerminalAssessment => ({
  kind: 'implement',
  complexity: 'hard',
  scope: 'open-ended',
  compound: true,
  confidence: 'high',
  discountEligible: true,
  ...over,
});

const engagedState = (over: Partial<WorkPhaseState> = {}): WorkPhaseState => ({
  intentKey: 'intent-a',
  terminal: terminal(),
  terminalRequirement: 0.775,
  terminalBand: 'frontier',
  phase: 'inspect',
  phaseReason: 'explicit-compound-inspect',
  multiWorkEngaged: true,
  providerInvocation: 1,
  mutationGateBlocks: 0,
  mutationGateTriggered: false,
  mutationCompleted: false,
  pendingMutationToolCallIds: new Set(),
  observedReadTools: 0,
  observedMutationTools: 0,
  ...over,
});

describe('terminal capability math', () => {
  it('implements the pinned requirement formula and bands', () => {
    expect(terminalRequirement(terminal())).toBeCloseTo(0.775);
    expect(capabilityBandFor(terminalRequirement(terminal()))).toBe('frontier');
    expect(capabilityBandFor(terminalRequirement(terminal({ complexity: 'moderate' })))).toBe('strong');
    expect(floorForBand('standard')).toBe(0.45);
    expect(floorForBand('strong')).toBe(0.70);
    expect(floorForBand('frontier')).toBe(0.85);
  });

  it('engages inspect only with explicit non-defaulted evidence', () => {
    expect(deriveInitialPhase(terminal(), 'frontier', {
      resolvedDimension: 'implement',
    })).toEqual({ phase: 'inspect', phaseReason: 'explicit-compound-inspect', multiWorkEngaged: true });

    expect(deriveInitialPhase(terminal({ discountEligible: false }), 'frontier', {
      resolvedDimension: 'implement',
    }).multiWorkEngaged).toBe(false);
  });
});

describe('scoring policy', () => {
  it('lowers only the inspect floor by one band while inspecting', () => {
    expect(scoringPolicyForState(engagedState(), 'implement')).toMatchObject({
      terminalFloor: 0.85,
      inspectFloor: 0.70,
      phase: 'inspect',
    });
  });

  it('holds the inspect floor at the terminal floor once mutating', () => {
    expect(scoringPolicyForState(
      engagedState({ phase: 'mutate', phaseReason: 'stronger-routing-owner' }),
      'implement',
    )).toMatchObject({ terminalFloor: 0.85, inspectFloor: 0.85 });
  });

  it('supplies no policy without engagement or on another dimension', () => {
    expect(scoringPolicyForState(engagedState({ multiWorkEngaged: false }), 'implement')).toBeUndefined();
    expect(scoringPolicyForState(engagedState(), 'review')).toBeUndefined();
  });
});

describe('nextProviderInvocation', () => {
  it('increments invocation and copies pending ids into a fresh set', () => {
    const prior = engagedState({ pendingMutationToolCallIds: new Set(['call-1']) });
    const next = nextProviderInvocation(prior);
    expect(next.providerInvocation).toBe(2);
    expect(next.pendingMutationToolCallIds).toEqual(new Set(['call-1']));
    expect(next.pendingMutationToolCallIds).not.toBe(prior.pendingMutationToolCallIds);
  });
});

describe('advanceForRoutingOwner', () => {
  it('forces mutate when a stronger owner claims an inspecting intent', () => {
    const next = advanceForRoutingOwner(engagedState({ phase: 'inspect' }), 'review');
    expect(next.phase).toBe('mutate');
    expect(next.phaseReason).toBe('stronger-routing-owner');
  });

  it('leaves an already-mutating or unengaged state untouched', () => {
    const mutating = engagedState({ phase: 'mutate', phaseReason: 'terminal-implement' });
    expect(advanceForRoutingOwner(mutating, 'review')).toMatchObject({
      phase: 'mutate',
      phaseReason: 'terminal-implement',
    });
    const unengaged = engagedState({ multiWorkEngaged: false, phase: 'inspect' });
    expect(advanceForRoutingOwner(unengaged, 'review')).toMatchObject({ phase: 'inspect' });
  });
});

describe('inheritThinContinuation', () => {
  it('retains terminal, band, and engagement while resetting per-invocation counters', () => {
    const prior = engagedState({
      providerInvocation: 3,
      gateBlockedInvocation: 2,
      mutationGateBlocks: 2,
      mutationGateTriggered: true,
      mutationCompleted: true,
      pendingMutationToolCallIds: new Set(['call-9']),
      observedReadTools: 4,
      observedMutationTools: 1,
    });
    const next = inheritThinContinuation('intent-b', prior);
    expect(next).toMatchObject({
      intentKey: 'intent-b',
      terminal: prior.terminal,
      terminalRequirement: prior.terminalRequirement,
      terminalBand: prior.terminalBand,
      multiWorkEngaged: prior.multiWorkEngaged,
      phase: prior.phase,
      providerInvocation: 1,
      gateBlockedInvocation: undefined,
      mutationGateBlocks: 0,
      mutationGateTriggered: false,
      mutationCompleted: false,
      observedReadTools: 0,
      observedMutationTools: 0,
    });
    expect(next.pendingMutationToolCallIds).toEqual(new Set());
  });

  it('never lowers an already-mutating phase back to inspect', () => {
    const priorMutating = engagedState({ phase: 'mutate', phaseReason: 'terminal-implement' });
    const next = inheritThinContinuation('intent-c', priorMutating);
    expect(next.phase).toBe('mutate');
  });
});
