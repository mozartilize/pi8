import { describe, expect, it, beforeEach } from 'vitest';
import { terminalAssessment, routingDecision } from '../test-support/router-fixtures.js';
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
  getCandidateExpansion,
  setCandidateExpansion,
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
  getLatchVetoIntentKey,
  setLatchVetoIntentKey,
  RouterSession,
} from './router-session-state.js';
import { getBlacklistedModels, getBlacklistedProviders } from './blacklist.js';

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

describe('candidate expansion memo', () => {
  beforeEach(() => resetRouterSession());

  it('round-trips the cached expansion by reference', () => {
    const candidates = [{ registryId: 'p/m' }] as never;
    setCandidateExpansion({ key: 'sig-1', candidates });
    const hit = getCandidateExpansion();
    expect(hit?.key).toBe('sig-1');
    // Same array reference: the memo hands back the built list without copying.
    expect(hit?.candidates).toBe(candidates);
  });

  it('does not survive a session reset', () => {
    setCandidateExpansion({ key: 'sig-1', candidates: [] });
    resetRouterSession();
    expect(getCandidateExpansion()).toBeUndefined();
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

  it('folds latchVetoIntentKey into session state and clears it on reset (regression fix)', () => {
    setLatchVetoIntentKey('vetoed-intent-123');
    expect(getLatchVetoIntentKey()).toBe('vetoed-intent-123');

    resetRouterSession();

    expect(getLatchVetoIntentKey()).toBeUndefined();
  });
});

describe('RouterSession independent instances', () => {
  it('maintains independent state between multiple instances', () => {
    const s1 = new RouterSession();
    const s2 = new RouterSession();

    s1.bumpLatchGeneration();
    s1.addAssessmentCost(0.05);
    s1.blacklistModel('model-1');

    expect(s1.getLatchGeneration()).toBe(1);
    expect(s1.getAssessmentCost()).toBe(0.05);
    expect(s1.getBlacklistedModels().has('model-1')).toBe(true);

    expect(s2.getLatchGeneration()).toBe(0);
    expect(s2.getAssessmentCost()).toBe(0);
    expect(s2.getBlacklistedModels().has('model-1')).toBe(false);
  });

  // The serving path resolves blacklists, escalation, and the incumbent from
  // the session it was handed. An injected session that wrote through to the
  // default one would let a second session inherit the first's exclusions and
  // incumbent, and would survive a reset of the instance that owns them.
  it('keeps an injected session out of the default session', () => {
    resetRouterSession();
    const isolated = new RouterSession();

    isolated.blacklistModel('alpha/failed');
    isolated.blacklistProvider('alpha');
    isolated.setPendingUserEscalation({ target: 'plan', fromModel: 'alpha/failed' });
    isolated.setLastDecision({
      dimension: 'implement',
      chosen: 'beta/strong',
      reason: 'test',
      confidence: 1,
      routedUp: false,
      routedDown: false,
      cause: 'heuristic',
      fallbackChain: ['beta/strong'],
    });

    expect(getBlacklistedModels().has('alpha/failed')).toBe(false);
    expect(getBlacklistedProviders().has('alpha')).toBe(false);
    expect(peekPendingUserEscalation()).toBeUndefined();
    expect(getLastChosenRegistryId()).toBeUndefined();
  });

  // A pending request must be visible to, and consumable by, the same owner:
  // peeking one session and consuming another silently drops the request.
  it('peeks and consumes a pending escalation on the same session', () => {
    const isolated = new RouterSession();
    isolated.setPendingUserEscalation({ target: 'review', fromModel: 'beta/strong' });

    expect(isolated.peekPendingUserEscalation()).toEqual({
      target: 'review',
      fromModel: 'beta/strong',
    });
    expect(isolated.consumePendingUserEscalation()).toEqual({
      target: 'review',
      fromModel: 'beta/strong',
    });
    expect(isolated.peekPendingUserEscalation()).toBeUndefined();
  });
});

describe('trajectory flush-and-arm', () => {
  it('arms pending escalation from a blocked-sibling batch at the provider boundary', () => {
    const session = new RouterSession();
    session.setLastDecision(routingDecision(['test/weak:low']));
    session.setLastServed({
      registryId: 'test/weak',
      thinkingLevel: 'low',
      viaFallback: false,
      accumulatedCost: 0,
    });
    session.bindTrajectoryIntent('intent-a');
    const sameRead = (id: string) => ({
      toolName: 'read',
      toolCallId: id,
      input: { path: 'a.ts' },
      content: [{ type: 'text', text: 'v1' }],
    });
    session.observeTrajectory(sameRead('r1'), 1);
    session.observeTrajectory(sameRead('r2'), 2);
    session.observeTrajectory(sameRead('r3'), 3);
    session.noteTrajectoryToolCall('bash', 'blocked', { command: 'pytest' });
    session.noteTrajectoryToolCall('read', 'r4', { path: 'a.ts' });
    expect(session.observeTrajectory(sameRead('r4'), 4)).toBeUndefined();
    expect(session.peekPendingTrajectoryEscalation()).toBeUndefined();
    session.flushAndArmUnresolvedTrajectory();
    expect(session.peekPendingTrajectoryEscalation()?.fromModel).toBe('test/weak:low');
  });
});
