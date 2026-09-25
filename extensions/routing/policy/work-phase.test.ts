import { describe, expect, it } from 'vitest';
import {
  capabilityBandFor,
  floorForBand,
  inheritThinContinuation,
  nextProviderInvocation,
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
  ...over,
});

const entryState = (over: Partial<WorkPhaseState> = {}): WorkPhaseState => ({
  intentKey: 'intent-a',
  terminal: terminal(),
  terminalBand: 'frontier',
  providerInvocation: 1,
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
});

describe('nextProviderInvocation', () => {
  it('increments the invocation without mutating the prior state', () => {
    const prior = entryState();
    const next = nextProviderInvocation(prior);
    expect(next.providerInvocation).toBe(2);
    expect(prior.providerInvocation).toBe(1);
  });
});

describe('inheritThinContinuation', () => {
  it('retains terminal and band while resetting per-entry counters and handoffs', () => {
    const handoff = {
      id: 'intent-a', requester: 'a/cheap', target: 'plan' as const, minimum: 0.5, requirement: 0.5,
      rubric: { alternatives: 2, stakes: 1, spread: 1, knowledge: 1, uncertainty: 1 },
      evidence: { applicable: false, files: 0, directories: 0 }, pending: false,
    };
    const prior = entryState({
      providerInvocation: 3,
      observedMutationTools: 1,
      contractNudged: true,
      readPaths: ['/repo/a.ts'],
      reasoningHandoff: handoff,
      investigationNudged: true,
      investigated: true,
      investigationClosed: true,
      contractStrikes: { 'beta/strong': 1 },
    });
    const next = inheritThinContinuation('intent-b', prior, 'implement');
    expect(next).toMatchObject({
      intentKey: 'intent-b',
      deliverable: 'implement',
      previousHandoffId: 'intent-a',
      terminal: prior.terminal,
      terminalBand: prior.terminalBand,
      providerInvocation: 1,
      observedMutationTools: 0,
      contractStrikes: { 'beta/strong': 1 },
    });
    expect(next.contract).toBeUndefined();
    expect(next.contractNudged).toBeUndefined();
    expect(next.readPaths).toBeUndefined();
    expect(next.reasoningHandoff).toBeUndefined();
    expect(next.investigationNudged).toBeUndefined();
    expect(next.investigated).toBeUndefined();
    expect(next.investigationClosed).toBeUndefined();
  });
});
