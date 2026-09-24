import { describe, expect, it, beforeEach } from 'vitest';
import { terminalAssessment, routingDecision } from '../test-support/router-fixtures.js';
import { defaultRouterSession, RouterSession } from './router-session-state.js';
import { defaultBlacklistState } from './blacklist.js';

describe('router session state', () => {
  it('clears a session-scoped manual model pin', () => {
    const session = new RouterSession();
    session.setManualModel('provider/model');
    expect(session.getManualModel()).toBe('provider/model');

    session.reset();

    expect(session.getManualModel()).toBeUndefined();
  });

  it('drops pinned-model trajectory escalation when resuming to auto', () => {
    const session = new RouterSession();
    session.setManualModel('provider/model');
    session.armTrajectoryEscalation(
      { escalate: true, tfi: 1, signals: [] },
      'provider/model',
      'implement',
      false,
    );
    expect(session.peekPendingTrajectoryEscalation()).toBeDefined();

    expect(session.resumeManual()).toBe(true);

    expect(session.peekPendingTrajectoryEscalation()).toBeUndefined();

    // Without an active pin there is nothing to resume, so unrelated auto-mode
    // trajectory evidence is preserved.
    const automatic = new RouterSession();
    automatic.armTrajectoryEscalation(
      { escalate: true, tfi: 1, signals: [] },
      'provider/model',
      'implement',
      false,
    );
    const pending = automatic.peekPendingTrajectoryEscalation();
    expect(automatic.resumeManual()).toBe(false);
    expect(automatic.peekPendingTrajectoryEscalation()).toBe(pending);
  });

  it('resumes the pre-pin route for one user entry, then expires', () => {
    const session = new RouterSession();
    const priorAuto = routingDecision(['beta/strong', 'gamma/mid']);
    session.setLastDecision(priorAuto);

    // Pinning snapshots the pre-pin auto decision; a manual turn overwrites the
    // live decision but the snapshot is untouched.
    session.setManualModel('alpha/pin');
    session.setLastDecision(routingDecision(['alpha/pin']));

    expect(session.resumeManual()).toBe(true);

    // Same entry (including tool-loop continuations) reuses the snapshot.
    expect(session.resolveResumeDecision('entry-1')).toBe(priorAuto);
    expect(session.resolveResumeDecision('entry-1')).toBe(priorAuto);
    // A new user entry expires the one-shot.
    expect(session.resolveResumeDecision('entry-2')).toBeUndefined();
    expect(session.resolveResumeDecision('entry-1')).toBeUndefined();
  });

  it('preserves the last served model across the per-turn reset', () => {
    const session = new RouterSession();
    session.setLastServed({ registryId: 'alpha/first', viaFallback: false, accumulatedCost: 0 });
    session.rotateServedForNewTurn();
    expect(session.getLastServed()).toBeUndefined();
    expect(session.getPreviousServed()?.registryId).toBe('alpha/first');
    session.reset();
    expect(session.getPreviousServed()).toBeUndefined();
  });

  it('scopes a semi hold to one user entry', () => {
    const session = new RouterSession();
    session.setSemiHold('entry-1', 'beta/second');
    expect(session.getSemiHold('entry-1')).toBe('beta/second');
    expect(session.getSemiHold('entry-2')).toBeUndefined();
    expect(session.getSemiHold('entry-1')).toBeUndefined();
  });

  it('does not resume while a pin is still active', () => {
    const session = new RouterSession();
    session.setLastDecision(routingDecision(['beta/strong']));
    session.setManualModel('alpha/pin');
    expect(session.resolveResumeDecision('entry-1')).toBeUndefined();
  });

  it('clears per-session routing state', () => {
    defaultRouterSession.setLastDecision({
      dimension: 'implement',
      chosen: 'provider/model',
      reason: 'test',
      confidence: 1,
      routedUp: false,
      routedDown: false,
      cause: 'heuristic',
      fallbackChain: ['provider/model'],
    });
    defaultRouterSession.addAccumulatedCost(1.23);
    defaultRouterSession.setLastResolvedThinkingLevel('high');
    defaultRouterSession.intent.setCachedIntent({
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
    expect(defaultRouterSession.intent.getCachedIntent()?.dimension).toBe('plan');

    defaultRouterSession.reset();

    expect(defaultRouterSession.getLastChosenRegistryId()).toBeUndefined();
    expect(defaultRouterSession.getAccumulatedCost()).toBe(0);
    expect(defaultRouterSession.getLastResolvedThinkingLevel()).toBeUndefined();
    expect(defaultRouterSession.intent.getCachedIntent()).toBeUndefined();
  });
});

describe('candidate expansion memo', () => {
  beforeEach(() => defaultRouterSession.reset());

  it('round-trips the cached expansion by reference', () => {
    const candidates = [{ registryId: 'p/m' }] as never;
    defaultRouterSession.setCandidateExpansion({ key: 'sig-1', candidates });
    const hit = defaultRouterSession.getCandidateExpansion();
    expect(hit?.key).toBe('sig-1');
    // Same array reference: the memo hands back the built list without copying.
    expect(hit?.candidates).toBe(candidates);
  });

  it('does not survive a session reset', () => {
    defaultRouterSession.setCandidateExpansion({ key: 'sig-1', candidates: [] });
    defaultRouterSession.reset();
    expect(defaultRouterSession.getCandidateExpansion()).toBeUndefined();
  });
});

describe('assessment session state', () => {
  beforeEach(() => defaultRouterSession.reset());

  it('starts at latch generation 0', () => {
    expect(defaultRouterSession.intent.getLatchGeneration()).toBe(0);
  });

  it('advances the session generation on every reset', () => {
    const before = defaultRouterSession.getSessionGeneration();
    defaultRouterSession.reset();
    expect(defaultRouterSession.getSessionGeneration()).toBe(before + 1);
  });

  it('bumps the latch generation exactly once per call', () => {
    defaultRouterSession.intent.bumpLatchGeneration();
    expect(defaultRouterSession.intent.getLatchGeneration()).toBe(1);
    defaultRouterSession.intent.bumpLatchGeneration();
    expect(defaultRouterSession.intent.getLatchGeneration()).toBe(2);
  });

  it('accumulates assessment cost separately from routed cost', () => {
    defaultRouterSession.assessment.addCost(0.0004);
    defaultRouterSession.assessment.addCost(0.0006);
    expect(defaultRouterSession.assessment.getCost()).toBeCloseTo(0.001, 6);
    expect(defaultRouterSession.getAccumulatedCost()).toBe(0);
  });

  it('updates the assessor usage estimate and ignores missing usage', () => {
    // With no recorded usage the caller's own estimate passes through.
    expect(defaultRouterSession.assessment.getTokenEstimate({ input: 1_000, output: 80 })).toEqual({
      input: 1_000,
      output: 80,
    });
    // The first recorded usage replaces the estimate outright.
    defaultRouterSession.assessment.recordSuccessfulUsage({ input: 500, output: 100 });
    expect(defaultRouterSession.assessment.getTokenEstimate({ input: 1_000, output: 80 })).toEqual({
      input: 500,
      output: 100,
    });
    // A later record blends the estimate toward the new observation. The
    // exact blend weight is internal economics, so pin the property: the
    // smoothed value stays strictly between the previous estimate and the
    // new usage on both axes.
    defaultRouterSession.assessment.recordSuccessfulUsage({ input: 1_000, output: 50 });
    const blended = defaultRouterSession.assessment.getTokenEstimate({ input: 1_000, output: 80 });
    expect(blended!.input).toBeGreaterThan(500);
    expect(blended!.input).toBeLessThan(1_000);
    expect(blended!.output).toBeGreaterThan(50);
    expect(blended!.output).toBeLessThan(100);
    // A zero/missing record is ignored: the estimate does not collapse.
    defaultRouterSession.assessment.recordSuccessfulUsage({ input: 0, output: 0 });
    expect(defaultRouterSession.assessment.getTokenEstimate({ input: 1_000, output: 80 })).toEqual(blended);
  });

  it('clears latch generation, assessment cost, and assessor EMA on session reset', () => {
    defaultRouterSession.intent.bumpLatchGeneration();
    defaultRouterSession.assessment.addCost(0.01);
    defaultRouterSession.assessment.recordSuccessfulUsage({ input: 500, output: 100 });
    defaultRouterSession.setActiveSkillNames(['systematic-debugging', 'writing-plans']);
    defaultRouterSession.reset();
    expect(defaultRouterSession.intent.getLatchGeneration()).toBe(0);
    expect(defaultRouterSession.assessment.getCost()).toBe(0);
    expect(defaultRouterSession.assessment.getTokenEstimate({ input: 1_000, output: 80 })).toEqual({
      input: 1_000,
      output: 80,
    });
    expect(defaultRouterSession.getActiveSkillNames()).toEqual([]);
  });

  it('clears phase, invocation, and pending mutation state on reset', () => {
    defaultRouterSession.intent.commitWorkPhaseState({
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
    expect(defaultRouterSession.intent.getWorkPhaseState()?.phase).toBe('inspect');

    defaultRouterSession.reset();

    expect(defaultRouterSession.intent.getWorkPhaseState()).toBeUndefined();
  });

  it('folds latchVetoIntentKey into session state and clears it on reset (regression fix)', () => {
    defaultRouterSession.intent.setLatchVetoIntentKey('vetoed-intent-123');
    expect(defaultRouterSession.intent.getLatchVetoIntentKey()).toBe('vetoed-intent-123');

    defaultRouterSession.reset();

    expect(defaultRouterSession.intent.getLatchVetoIntentKey()).toBeUndefined();
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

  // The serving path resolves blacklists and the incumbent from the session
  // it was handed. An injected session that wrote through to the default one
  // would let a second session inherit the first's exclusions and incumbent,
  // and would survive a reset of the instance that owns them.
  it('keeps an injected session out of the default session', () => {
    defaultRouterSession.reset();
    const isolated = new RouterSession();

    isolated.blacklistModel('alpha/failed');
    isolated.blacklistProvider('alpha');
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

    expect(defaultBlacklistState.getBlacklistedModels().has('alpha/failed')).toBe(false);
    expect(defaultBlacklistState.getBlacklistedProviders().has('alpha')).toBe(false);
    expect(defaultRouterSession.getLastChosenRegistryId()).toBeUndefined();
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

describe('trajectory evidence ownership', () => {
  const sameRead = (id: string) => ({
    toolName: 'read',
    toolCallId: id,
    input: { path: 'a.ts' },
    content: [{ type: 'text', text: 'v1' }],
  });

  const serve = (session: RouterSession, registryId: string, thinkingLevel?: string): void => {
    session.setLastServed({ registryId, thinkingLevel, viaFallback: false, accumulatedCost: 0 });
  };

  it('keeps evidence owned by the model that produced it across one serve', () => {
    const session = new RouterSession();
    session.setLastDecision(routingDecision(['test/weak:low']));
    session.bindTrajectoryIntent('intent-a');
    serve(session, 'test/weak', 'low');
    session.observeTrajectory(sameRead('r1'), 1);
    session.observeTrajectory(sameRead('r2'), 2);
    session.observeTrajectory(sameRead('r3'), 3);
    const decision = session.observeTrajectory(sameRead('r4'), 4);
    session.armTrajectoryEscalation(decision!, session.servedTrajectoryKey(), 'implement', false);
    expect(session.peekPendingTrajectoryEscalation()?.fromModel).toBe('test/weak:low');
  });

  it('drops the prior model\'s claim once a different capability serves', () => {
    const session = new RouterSession();
    session.setLastDecision(routingDecision(['test/weak:low']));
    session.bindTrajectoryIntent('intent-a');
    serve(session, 'test/weak', 'low');
    for (const id of ['r1', 'r2', 'r3', 'r4']) session.observeTrajectory(sameRead(id), 1);
    session.armTrajectoryEscalation(
      session.observeTrajectory(sameRead('r5'), 5)!,
      session.servedTrajectoryKey(),
      'implement',
      false,
    );
    expect(session.peekPendingTrajectoryEscalation()).toBeDefined();

    // The handoff served: evidence from here on describes the new capability.
    serve(session, 'test/strong', 'high');
    const decision = session.observeTrajectory(sameRead('r6'), 6);
    session.armTrajectoryEscalation(decision!, session.servedTrajectoryKey(), 'implement', false);
    expect(session.peekPendingTrajectoryEscalation()).toBeUndefined();
  });

  it('treats the same model at a higher effort as a different owner', () => {
    const session = new RouterSession();
    session.setLastDecision(routingDecision(['test/weak:low']));
    session.bindTrajectoryIntent('intent-a');
    serve(session, 'test/weak', 'low');
    for (const id of ['r1', 'r2', 'r3']) session.observeTrajectory(sameRead(id), 1);
    serve(session, 'test/weak', 'high');
    const decision = session.observeTrajectory(sameRead('r4'), 4);
    expect(decision?.signals.find((s) => s.kind === 'aor')?.severity).toBe('none');
  });
});

describe('warm prompt caches', () => {
  it('reports each served key with the context it sent while its cache lives', () => {
    const session = new RouterSession();
    session.noteRequestTokens(40_000);
    session.setLastServed({ registryId: 'codex/luna', thinkingLevel: 'high', viaFallback: false, accumulatedCost: 0 });
    session.noteRequestTokens(55_000);
    session.setLastServed({ registryId: 'codex/luna', thinkingLevel: 'xhigh', viaFallback: false, accumulatedCost: 0 });
    const now = Date.now();
    expect(session.warmPrefixTokens(now, 60_000, 300_000))
      .toEqual(new Map([['codex/luna:high', 40_000], ['codex/luna:xhigh', 55_000]]));
    // Expired caches and requests larger than the current context hold nothing.
    expect(session.warmPrefixTokens(now + 300_000, 60_000, 300_000)).toEqual(new Map());
    expect(session.warmPrefixTokens(now, 50_000, 300_000)).toEqual(new Map([['codex/luna:high', 40_000]]));
  });

  it('forgets every cache when the history is rewritten or the session resets', () => {
    const session = new RouterSession();
    session.noteRequestTokens(40_000);
    session.setLastServed({ registryId: 'codex/luna', thinkingLevel: 'high', viaFallback: false, accumulatedCost: 0 });
    session.clearWarmCaches();
    expect(session.warmPrefixTokens(Date.now(), 60_000, 300_000)).toEqual(new Map());
    session.setLastServed({ registryId: 'codex/luna', thinkingLevel: 'high', viaFallback: false, accumulatedCost: 0 });
    session.reset();
    expect(session.warmPrefixTokens(Date.now(), 60_000, 300_000)).toEqual(new Map());
  });
});
