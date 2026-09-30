import { describe, expect, it } from 'vitest';
import {
  capabilityBandFor,
  carryAcrossBranch,
  floorForBand,
  inheritWorkContinuation,
  boundaryQualifiers,
  nextProviderInvocation,
  servesBoundary,
  terminalRequirement,
  withStrongerTerminal,
} from './work-phase.js';
import type { TerminalAssessment } from '../../types.js';
import type { WorkPhaseState } from './work-phase.js';

const terminal = (over: Partial<TerminalAssessment> = {}): TerminalAssessment => ({
  kind: 'implement',
  complexity: 'hard',
  scope: 'open-ended',
  compound: false,
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

describe('withStrongerTerminal', () => {
  it('takes the final step that asks for more, and never one that asks for less', () => {
    const prior = entryState({ terminal: terminal({ complexity: 'trivial', scope: 'bounded' }), terminalBand: 'economy' });
    const raised = withStrongerTerminal(prior, terminal({ complexity: 'moderate' }));
    expect(raised).toMatchObject({ terminal: { complexity: 'moderate' }, terminalBand: 'strong' });
    expect(withStrongerTerminal(raised, terminal({ complexity: 'trivial', scope: 'bounded' }))).toBe(raised);
  });
});

describe('inheritWorkContinuation', () => {
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
      contextStatus: 'served',
      contextRequests: 4,
      contextDenials: 1,
      deniedAtInvocation: 2,
      clarificationDispatched: true,
      handoffKey: 'k',
      contextNudged: true,
      contextWaived: true,
      recoveryMinimum: true,
      contextClosed: true,
      contractStrikes: { 'beta/strong': 1 },
    });
    const next = inheritWorkContinuation('intent-b', prior, 'implement');
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
    for (const field of [
      'contextStatus', 'contextRequests', 'contextDenials', 'deniedAtInvocation', 'clarificationDispatched',
      'handoffKey', 'contextNudged', 'contextWaived', 'recoveryMinimum', 'contextClosed',
    ] as const) {
      expect(next[field]).toBeUndefined();
    }
  });
});

describe('carryAcrossBranch', () => {
  it('keeps only the task type and final step a thin continuation inherits', () => {
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
      terminal: prior.terminal,
      terminalBand: prior.terminalBand,
      providerInvocation: 4,
      observedMutationTools: 0,
    });
    expect(carryAcrossBranch(prior, undefined)).not.toHaveProperty('deliverable');
  });
});

describe('phase boundary qualifiers', () => {
  it('keeps the first-tier chain candidates, promoted ones included', () => {
    expect(boundaryQualifiers({
      fallbackChain: ['a/x:high', 'b/y:max', 'c/z', 'd/w:low'],
      candidateDiagnostics: [
        { candidateKey: 'b/y:max', excludedReason: 'below-task-floor' },
        { candidateKey: 'c/z', excludedReason: 'unknown-quality' },
        { candidateKey: 'd/w:low', excludedReason: 'promoted' },
      ],
    })).toEqual(['a/x:high', 'd/w:low']);
  });

  it('matches the served model at the qualifying effort or higher', () => {
    expect(servesBoundary('a/x:high', ['a/x:high'])).toBe(true);
    expect(servesBoundary('a/x:max', ['a/x:high'])).toBe(true);
    expect(servesBoundary('a/x:medium', ['a/x:high'])).toBe(false);
    expect(servesBoundary('a/x:low', ['a/x'])).toBe(true);
    expect(servesBoundary('a/x', ['a/x:high'])).toBe(false);
    expect(servesBoundary('b/x:high', ['a/x:high'])).toBe(false);
  });
});
