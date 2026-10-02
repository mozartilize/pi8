import { describe, expect, it } from 'vitest';
import {
  capabilityBandFor,
  carryAcrossBranch,
  bandRequirement,
  penaltiesOf,
  withContinuedPenalties,
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
    expect(bandRequirement('standard')).toBe(0.45);
    expect(bandRequirement('strong')).toBe(0.70);
    expect(bandRequirement('frontier')).toBe(0.85);
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
  it('keeps only the task type and final step across branch navigation', () => {
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
  it('keeps only the first-tier chain candidates', () => {
    expect(boundaryQualifiers({
      fallbackChain: ['a/x:high', 'b/y:max', 'c/z', 'd/w:low'],
      candidateDiagnostics: [
        { candidateKey: 'b/y:max', excludedReason: 'below-intelligence-minimum' },
        { candidateKey: 'c/z', excludedReason: 'unknown-quality' },
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
