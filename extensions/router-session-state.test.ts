import { describe, expect, it, beforeEach } from 'vitest';
import { terminalAssessment } from './test-support/router-fixtures.js';
import {
  addAccumulatedCost,
  addAssessmentCost,
  bumpLatchGeneration,
  commitWorkPhaseState,
  consumePendingUserEscalation,
  getAccumulatedCost,
  getActiveSkillNames,
  getAssessmentCost,
  getAssessorTokenEstimate,
  getCachedRoutingIntent,
  getLastChosenRegistryId,
  getLastResolvedThinkingLevel,
  getLatchGeneration,
  getSessionGeneration,
  getWorkPhaseState,
  peekPendingUserEscalation,
  recordSuccessfulAssessorUsage,
  resetRouterSession,
  setActiveSkillNames,
  setCachedRoutingIntent,
  setLastDecision,
  setLastResolvedThinkingLevel,
  setPendingUserEscalation,
} from './router-session-state.js';

describe('router session state', () => {
  it('clears per-session routing state', () => {
    setLastDecision({
      dimension: 'implement',
      chosen: 'provider/model',
      reason: 'test',
      confidence: 1,
      routedUp: false,
      routedDown: false,
      cause: 'heuristic',
      fallbackChain: ['provider/model'],
    });
    addAccumulatedCost(1.23);
    setLastResolvedThinkingLevel('high');
    setCachedRoutingIntent({
      key: '2:3:abc',
      classifyResult: {
        dimension: 'plan',
        confidence: 0.8,
        signals: ['plan (1)'],
        terminal: terminalAssessment(),
      hasCategoricalEvidence: true,
      },
      dimension: 'plan',
      cause: 'continuation-context',
      thin: true,
      contextChars: 120,
    });
    expect(getCachedRoutingIntent()?.dimension).toBe('plan');

    resetRouterSession();

    expect(getLastChosenRegistryId()).toBeUndefined();
    expect(getAccumulatedCost()).toBe(0);
    expect(getLastResolvedThinkingLevel()).toBeUndefined();
    expect(getCachedRoutingIntent()).toBeUndefined();
  });
});

describe('pending user escalation', () => {
  it('is consumed exactly once', () => {
    resetRouterSession();
    setPendingUserEscalation({ target: 'plan', fromModel: 'test/current' });

    // Peeking must not consume: routing reads it before a decision exists.
    expect(peekPendingUserEscalation()).toEqual({ target: 'plan', fromModel: 'test/current' });
    expect(consumePendingUserEscalation()).toEqual({ target: 'plan', fromModel: 'test/current' });
    expect(consumePendingUserEscalation()).toBeUndefined();
    expect(peekPendingUserEscalation()).toBeUndefined();
  });

  it('does not survive a session reset', () => {
    setPendingUserEscalation({ target: 'review' });
    resetRouterSession();
    expect(peekPendingUserEscalation()).toBeUndefined();
  });
});

describe('assessment session state', () => {
  beforeEach(() => resetRouterSession());

  it('starts at latch generation 0', () => {
    expect(getLatchGeneration()).toBe(0);
  });

  it('advances the session generation on every reset', () => {
    const before = getSessionGeneration();
    resetRouterSession();
    expect(getSessionGeneration()).toBe(before + 1);
  });

  it('bumps the latch generation exactly once per call', () => {
    bumpLatchGeneration();
    expect(getLatchGeneration()).toBe(1);
    bumpLatchGeneration();
    expect(getLatchGeneration()).toBe(2);
  });

  it('accumulates assessment cost separately from routed cost', () => {
    addAssessmentCost(0.0004);
    addAssessmentCost(0.0006);
    expect(getAssessmentCost()).toBeCloseTo(0.001, 6);
    expect(getAccumulatedCost()).toBe(0);
  });

  it('updates the assessor usage estimate and ignores missing usage', () => {
    // With no recorded usage the caller's own estimate passes through.
    expect(getAssessorTokenEstimate({ input: 1_000, output: 80 })).toEqual({
      input: 1_000,
      output: 80,
    });
    // The first recorded usage replaces the estimate outright.
    recordSuccessfulAssessorUsage({ input: 500, output: 100 });
    expect(getAssessorTokenEstimate({ input: 1_000, output: 80 })).toEqual({
      input: 500,
      output: 100,
    });
    // A later record blends the estimate toward the new observation. The
    // exact blend weight is internal economics, so pin the property: the
    // smoothed value stays strictly between the previous estimate and the
    // new usage on both axes.
    recordSuccessfulAssessorUsage({ input: 1_000, output: 50 });
    const blended = getAssessorTokenEstimate({ input: 1_000, output: 80 });
    expect(blended!.input).toBeGreaterThan(500);
    expect(blended!.input).toBeLessThan(1_000);
    expect(blended!.output).toBeGreaterThan(50);
    expect(blended!.output).toBeLessThan(100);
    // A zero/missing record is ignored: the estimate does not collapse.
    recordSuccessfulAssessorUsage({ input: 0, output: 0 });
    expect(getAssessorTokenEstimate({ input: 1_000, output: 80 })).toEqual(blended);
  });

  it('clears latch generation, assessment cost, and assessor EMA on session reset', () => {
    bumpLatchGeneration();
    addAssessmentCost(0.01);
    recordSuccessfulAssessorUsage({ input: 500, output: 100 });
    setActiveSkillNames(['systematic-debugging', 'writing-plans']);
    resetRouterSession();
    expect(getLatchGeneration()).toBe(0);
    expect(getAssessmentCost()).toBe(0);
    expect(getAssessorTokenEstimate({ input: 1_000, output: 80 })).toEqual({
      input: 1_000,
      output: 80,
    });
    expect(getActiveSkillNames()).toEqual([]);
  });

  it('clears phase, invocation, and pending mutation state on reset', () => {
    commitWorkPhaseState({
      intentKey: 'intent-a',
      terminal: terminalAssessment(),
      terminalRequirement: 0.775,
      terminalBand: 'frontier',
      phase: 'inspect',
      phaseReason: 'explicit-compound-inspect',
      multiWorkEngaged: true,
      providerInvocation: 2,
      gateBlockedInvocation: 1,
      mutationGateBlocks: 1,
      mutationGateTriggered: true,
      mutationCompleted: false,
      pendingMutationToolCallIds: new Set(['call-1']),
      observedReadTools: 1,
      observedMutationTools: 1,
    });
    expect(getWorkPhaseState()?.phase).toBe('inspect');

    resetRouterSession();

    expect(getWorkPhaseState()).toBeUndefined();
  });
});
