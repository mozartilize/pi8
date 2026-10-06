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
  strongFinalStep,
  terminalMinimum,
  terminalRequirement,
  withStrongerTerminal,
} from './work-phase.js';
import { defaultRequirement } from '../score/scorer.js';
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

describe('final step under the candidate policy', () => {
  const none = (): WorkPhaseState => ({ intentKey: 'i', providerInvocation: 1, observedMutationTools: 0 });
  const kinds = ['lightweight', 'gather', 'implement', 'review', 'plan'] as const;
  const complexities = ['trivial', 'routine', 'moderate', 'hard', 'frontier'] as const;
  const scopes = ['bounded', 'open-ended'] as const;
  const allSteps = kinds.flatMap((kind) => complexities.flatMap((complexity) => scopes.map((scope) => terminal({ kind, complexity, scope }))));

  it('keeps the requirement of the step and no band, and never takes a step that asks for less', () => {
    const first = withStrongerTerminal(none(), terminal({ complexity: 'moderate' }), 'cheapest-sufficient');
    expect(first.terminalRequirement).toBeCloseTo(terminalRequirement(terminal({ complexity: 'moderate' })));
    expect(first.terminalBand).toBeUndefined();
    expect(withStrongerTerminal(first, terminal({ complexity: 'trivial', scope: 'bounded' }), 'cheapest-sufficient')).toBe(first);
    expect(withStrongerTerminal(none(), terminal(), 'legacy').terminalRequirement).toBeUndefined();
  });

  it('keeps the requirement across a branch change', () => {
    const state = withStrongerTerminal(none(), terminal(), 'cheapest-sufficient');
    expect(carryAcrossBranch(state, 'plan').terminalRequirement).toBe(state.terminalRequirement);
  });

  it('adds a minimum only when the step asks for more than the default of the task type', () => {
    const at = (step: TerminalAssessment, target: 'plan' | 'review') => terminalMinimum(withStrongerTerminal(none(), step, 'cheapest-sufficient'), target, 'cheapest-sufficient');
    expect(at(terminal({ kind: 'plan', complexity: 'trivial', scope: 'bounded' }), 'plan')).toBeUndefined();
    const hard = terminal({ kind: 'plan', complexity: 'hard', scope: 'open-ended' });
    expect(at(hard, 'plan')).toBeCloseTo(terminalRequirement(hard));
    expect(terminalRequirement(hard)).toBeGreaterThan(defaultRequirement('plan'));
    expect(terminalMinimum(none(), 'plan', 'cheapest-sufficient')).toBeUndefined();
  });

  it('never gives a step below the default requirement a minimum that lowers the default', () => {
    for (const step of allSteps) {
      const minimum = terminalMinimum(withStrongerTerminal(none(), step, 'cheapest-sufficient'), step.kind, 'cheapest-sufficient');
      if (minimum != null) expect(minimum).toBeGreaterThan(defaultRequirement(step.kind));
    }
  });

  it('keeps the band mapping of the legacy policy', () => {
    const strong = withStrongerTerminal(none(), terminal({ kind: 'plan', complexity: 'moderate', scope: 'open-ended' }), 'legacy');
    expect(terminalMinimum(strong, 'plan', 'legacy')).toBe(0.70);
  });

  it('reminds a gather entry at the same final steps as the legacy bands', () => {
    for (const step of allSteps) {
      expect(strongFinalStep(withStrongerTerminal(none(), step, 'cheapest-sufficient'), 'cheapest-sufficient'))
        .toBe(strongFinalStep(withStrongerTerminal(none(), step, 'legacy'), 'legacy'));
    }
    expect(strongFinalStep(none(), 'cheapest-sufficient')).toBe(false);
  });
});
