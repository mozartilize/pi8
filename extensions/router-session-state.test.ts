import { describe, expect, it, beforeEach } from 'vitest';
import {
  addAccumulatedCost,
  addAssessmentCost,
  bumpLatchGeneration,
  consumePendingUserEscalation,
  getAccumulatedCost,
  getActiveSkillNames,
  getAssessmentCost,
  getCachedRoutingIntent,
  getLastChosenRegistryId,
  getLastResolvedThinkingLevel,
  getLatchGeneration,
  peekPendingUserEscalation,
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

  it('clears latch generation and assessment cost on session reset', () => {
    bumpLatchGeneration();
    addAssessmentCost(0.01);
    setActiveSkillNames(['systematic-debugging', 'writing-plans']);
    resetRouterSession();
    expect(getLatchGeneration()).toBe(0);
    expect(getAssessmentCost()).toBe(0);
    expect(getActiveSkillNames()).toEqual([]);
  });
});
