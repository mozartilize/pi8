import { describe, expect, it } from 'vitest';
import {
  capabilityBandFor,
  deriveInitialPhase,
  floorForBand,
  scoringPolicyForState,
  terminalRequirement,
} from './work-phase.js';
import type { TerminalAssessment } from './types.js';
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
      capabilityRepickActive: false,
    })).toEqual({ phase: 'inspect', phaseReason: 'explicit-compound-inspect', multiWorkEngaged: true });

    expect(deriveInitialPhase(terminal({ discountEligible: false }), 'frontier', {
      resolvedDimension: 'implement',
      capabilityRepickActive: false,
    }).multiWorkEngaged).toBe(false);
  });
});

describe('scoring policy', () => {
  it('lowers only the inspect floor by one band while inspecting', () => {
    expect(scoringPolicyForState(engagedState(), 'implement', false)).toMatchObject({
      terminalFloor: 0.85,
      inspectFloor: 0.70,
      phase: 'inspect',
    });
  });

  it('holds the inspect floor at the terminal floor once mutating', () => {
    expect(scoringPolicyForState(
      engagedState({ phase: 'mutate', phaseReason: 'stronger-routing-owner' }),
      'implement',
      false,
    )).toMatchObject({ terminalFloor: 0.85, inspectFloor: 0.85 });
  });

  it('supplies no policy without engagement, on another dimension, or under a repick', () => {
    expect(scoringPolicyForState(engagedState({ multiWorkEngaged: false }), 'implement', false)).toBeUndefined();
    expect(scoringPolicyForState(engagedState(), 'review', false)).toBeUndefined();
    expect(scoringPolicyForState(engagedState(), 'implement', true)).toBeUndefined();
  });
});
