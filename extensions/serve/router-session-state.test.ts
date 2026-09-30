import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDebugPath } from '../host/debuglog.js';
import { terminalAssessment, routingDecision } from '../test-support/router-fixtures.js';
import { defaultRouterSession, RouterSession } from './router-session-state.js';
import { defaultBlacklistState } from './blacklist.js';
import { activateEvent, createEvent, workItem } from '../test-support/context-fixtures.js';
import { SessionTree } from '../test-support/session-tree.js';

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

describe('session generation and reset', () => {
  beforeEach(() => defaultRouterSession.reset());

  it('advances the session generation on every reset', () => {
    const before = defaultRouterSession.getSessionGeneration();
    defaultRouterSession.reset();
    expect(defaultRouterSession.getSessionGeneration()).toBe(before + 1);
  });

  it('clears skill names on session reset', () => {
    defaultRouterSession.setActiveSkillNames(['systematic-debugging', 'writing-plans']);
    defaultRouterSession.reset();
    expect(defaultRouterSession.getActiveSkillNames()).toEqual([]);
  });

  it('clears the entry state on reset', () => {
    defaultRouterSession.intent.commitWorkPhaseState({
      intentKey: 'intent-a',
      terminal: terminalAssessment(),
      terminalBand: 'frontier',
      providerInvocation: 2,
      observedMutationTools: 1,
    });
    expect(defaultRouterSession.intent.getWorkPhaseState()?.providerInvocation).toBe(2);

    defaultRouterSession.reset();

    expect(defaultRouterSession.intent.getWorkPhaseState()).toBeUndefined();
  });
});

describe('RouterSession independent instances', () => {
  it('maintains independent state between multiple instances', () => {
    const s1 = new RouterSession();
    const s2 = new RouterSession();

    s1.blacklistModel('model-1');

    expect(s1.getBlacklistedModels().has('model-1')).toBe(true);

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
    session.noteRequest(40_000, 'head-a');
    session.setLastServed({ registryId: 'codex/luna', thinkingLevel: 'high', viaFallback: false, accumulatedCost: 0 });
    session.noteRequest(55_000, 'head-a');
    session.setLastServed({ registryId: 'codex/luna', thinkingLevel: 'xhigh', viaFallback: false, accumulatedCost: 0 });
    const now = Date.now();
    expect(session.warmPrefixTokens(now, 60_000, 300_000))
      .toEqual(new Map([['codex/luna:high', 40_000], ['codex/luna:xhigh', 55_000]]));
    // Expired caches and requests larger than the current context hold nothing.
    expect(session.warmPrefixTokens(now + 300_000, 60_000, 300_000)).toEqual(new Map());
    expect(session.warmPrefixTokens(now, 50_000, 300_000)).toEqual(new Map([['codex/luna:high', 40_000]]));
  });

  it('forgets every cache when the prompt head changes', () => {
    const session = new RouterSession();
    session.noteRequest(40_000, 'head-a');
    session.setLastServed({ registryId: 'codex/luna', thinkingLevel: 'high', viaFallback: false, accumulatedCost: 0 });
    session.noteRequest(45_000, 'head-a');
    expect(session.warmPrefixTokens(Date.now(), 45_000, 300_000).size).toBe(1);
    session.noteRequest(45_000, 'head-b');
    expect(session.warmPrefixTokens(Date.now(), 45_000, 300_000)).toEqual(new Map());
  });

  it('forgets every cache when the history is rewritten or the session resets', () => {
    const session = new RouterSession();
    session.noteRequest(40_000, 'head-a');
    session.setLastServed({ registryId: 'codex/luna', thinkingLevel: 'high', viaFallback: false, accumulatedCost: 0 });
    session.clearWarmCaches();
    expect(session.warmPrefixTokens(Date.now(), 60_000, 300_000)).toEqual(new Map());
    session.setLastServed({ registryId: 'codex/luna', thinkingLevel: 'high', viaFallback: false, accumulatedCost: 0 });
    session.reset();
    expect(session.warmPrefixTokens(Date.now(), 60_000, 300_000)).toEqual(new Map());
  });
});

describe('routing context state', () => {
  it('applies no event the branch did not record', () => {
    const session = new RouterSession();
    session.context.bindPersistence(() => { throw new Error('session closed'); });
    expect(session.context.append(createEvent(workItem('w_1')))).toBe(false);
    expect(session.context.getLedger().items.has('w_1')).toBe(false);
    expect(session.context.getLedger().events).toBe(0);
    expect(session.context.getBranchState()).toBe('native-empty');

    session.context.bindPersistence(() => {});
    expect(session.context.append(createEvent(workItem('w_1')))).toBe(true);
    expect(session.context.getLedger().items.has('w_1')).toBe(true);
  });

  it('writes a failed branch write to the debug log', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi8-persist-'));
    const path = join(dir, 'debug.log');
    setDebugPath(path);
    try {
      const session = new RouterSession();
      session.context.bindPersistence(() => { throw new Error('session closed'); });
      session.context.append(createEvent(workItem('w_1')));
      expect(readFileSync(path, 'utf8')).toMatch(/context\.persist-error .*"op":"work-create".*session closed/);
    } finally {
      setDebugPath(undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the fast path closed across a branch restore and opens it on reset', () => {
    const session = new RouterSession();
    session.context.setFastPathBlocked(true);
    session.context.restore([]);
    expect(session.context.isFastPathBlocked()).toBe(true);
    session.reset();
    expect(session.context.isFastPathBlocked()).toBe(false);
  });

  it('forgets the ledger on reset but keeps writing to the bound branch', () => {
    const tree = new SessionTree();
    const session = new RouterSession();
    session.context.bindPersistence((event) => tree.appendEntry('pi8-routing-context-v1', event));
    session.context.append(createEvent(workItem('w_1')));
    session.reset();
    expect(session.context.getLedger().items.size).toBe(0);
    expect(session.context.getBranchState()).toBe('native-empty');

    session.context.append(createEvent(workItem('w_2')));
    session.context.append(activateEvent('w_2'));
    session.context.restore(tree.getBranch());
    expect([...session.context.getLedger().items.keys()]).toEqual(['w_1', 'w_2']);
    expect(session.context.getLedger().activeWorkItemId).toBe('w_2');
  });
});
