import { afterAll, describe, expect, it, vi } from 'vitest';
import { registryModel } from '../test-support/router-fixtures.js';
import { buildCandidate } from '../routing/score/scorer.js';
import { WorkerLpAdapter } from '../routing/optimization/lp.js';
import type { AssignmentRevisions } from '../routing/policy/assignment-transaction.js';
import type { BenchModel } from '../types.js';
import { readPreferences, type UnifiedTurnInput, type UnifiedTurnOutcome } from './unified-decision.js';
import { createUnifiedDispatch } from './unified-dispatch.js';
import { createBoundaryAuthorization, type BoundaryAuthorizationV1 } from '../routing/policy/boundary-authorization.js';

const lp = new WorkerLpAdapter();
afterAll(() => lp.close());

function fixture(withThird = false) {
  const models = (withThird ? ['source', 'alternate', 'third'] : ['source', 'alternate']).map((id) => registryModel(`test/${id}`, { reasoning: false }));
  const rows: BenchModel[] = models.map((model) => ({
    registryId: `test/${model.id}`, benchSlug: model.id, active: true, source: 'aa',
    quality: { intelligence: 50, coding: 50, agenticCoding: 50, research: 0.8 },
    axisProvenance: { intelligence: 'measured', coding: 'measured', agenticCoding: 'measured', research: 'measured' },
  }));
  const candidates = models.map((model, i) => buildCandidate(model, rows[i]));
  const revisions: AssignmentRevisions = {
    workItemId: 'work', branchId: 'branch', session: 1,
    profileDigest: readPreferences().digest, authorization: 1, context: 1,
  };
  let assignmentId = 'assignment';
  const boundaryOf = (actors: readonly string[], excluded: readonly string[] = []) => createBoundaryAuthorization(
    { boundaryId: 'entry', workItemId: 'work', phase: 'implement', assignmentId, revision: revisions.authorization },
    actors, excluded.map((model) => ({ workItemId: 'work', phase: 'implement' as const, model })));
  let boundary: BoundaryAuthorizationV1 | undefined = boundaryOf(models.map((model) => `test/${model.id}`));
  const input: UnifiedTurnInput = {
    state: { phase: 'implement', workItemId: 'work', estimatedContextTokens: 1000,
      needsVision: false, boundary: 'ordinary', friction: [], nowMs: 0,
      benchmarkIndexVersion: '4.3' },
    authorizationScope: { boundaryId: 'entry', workItemId: 'work', phase: 'implement', assignmentId, revision: 1 },
    cause: 'incumbent', candidates, registryModels: models, rows,
    isExcluded: () => false, isCurrent: () => true,
    ports: { lp, domains: { lookup: () => undefined } },
  };
  const commit = vi.fn((outcome: Extract<UnifiedTurnOutcome, { kind: 'decision' }>) => {
    revisions.authorization = outcome.authorization.revision;
    assignmentId = outcome.authorization.assignmentId;
    boundary = outcome.authorization;
    return true;
  });
  const host = { revisions: () => ({ ...revisions }), assignmentId: () => assignmentId, authorization: () => boundary };
  const adapter = createUnifiedDispatch(host, { input, candidates: () => candidates, models: () => models, commit });
  const signal = new AbortController();
  const select = () => adapter.select('test/source', adapter.reachable('test/source'), () => true, signal.signal);
  const replace = (next: BoundaryAuthorizationV1 | undefined, id = assignmentId) => { boundary = next; assignmentId = id; };
  return { adapter, select, signal, revisions, commit, candidates, input, host, boundaryOf, replace };
}

describe('production unified recovery', () => {
  it('compares equal-quality actors with scoped loop friction and writes only on reservation', async () => {
    const f = fixture();
    const selected = await f.select();
    expect(selected).toMatchObject({ kind: 'decision', chosen: 'test/alternate', constraintsEnforced: true });
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.adapter.reserve('test/alternate')).toBeDefined();
    expect(f.commit).toHaveBeenCalledOnce();
    expect(f.adapter.reserve('test/alternate')).toBeUndefined();
    expect(f.adapter.dispatch('test/alternate', f.signal.signal)).toBe(true);
  });

  it('never reserves a different actor from the selector choice', async () => {
    const f = fixture();
    await f.select();
    expect(f.adapter.reserve('test/source')).toBeUndefined();
    expect(f.commit).not.toHaveBeenCalled();
  });

  it.each(['profileDigest', 'branchId', 'workItemId'] as const)('rejects a changed %s before reservation', async (field) => {
    const f = fixture();
    await f.select();
    f.revisions[field] = 'changed';
    expect(f.adapter.reserve('test/alternate')).toBeUndefined();
    expect(f.commit).not.toHaveBeenCalled();
  });

  it.each(['profileDigest', 'branchId', 'workItemId'] as const)('rejects a changed %s after reservation, before provider dispatch', async (field) => {
    const f = fixture();
    await f.select();
    expect(f.adapter.reserve('test/alternate')).toBeDefined();
    f.revisions[field] = 'changed';
    expect(f.adapter.dispatch('test/alternate', f.signal.signal)).toBe(false);
  });

  it('rejects a removed target and a cancelled dispatch', async () => {
    const f = fixture();
    await f.select();
    expect(f.adapter.reserve('test/alternate')).toBeDefined();
    f.candidates.splice(1, 1);
    expect(f.adapter.dispatch('test/alternate', f.signal.signal)).toBe(false);
    f.adapter.release();
    const cancelled = fixture();
    await cancelled.select();
    expect(cancelled.adapter.reserve('test/alternate')).toBeDefined();
    cancelled.signal.abort();
    expect(cancelled.adapter.dispatch('test/alternate', cancelled.signal.signal)).toBe(false);
  });

  it('allows a remaining authorized actor after the selected target fails before dispatch', async () => {
    const f = fixture(true);
    await f.select();
    expect(f.adapter.reserve('test/alternate')).toBeDefined();
    f.adapter.release('test/alternate');
    expect(f.adapter.dispatch('test/third', f.signal.signal)).toBe(true);
    f.revisions.profileDigest = 'changed';
    expect(f.adapter.dispatch('test/third', f.signal.signal)).toBe(false);
  });

  it('keeps executor exclusions in the same implementation phase', async () => {
    const f = fixture();
    f.input.workState = { intentKey: 'entry', workItemId: 'work', providerInvocation: 1,
      observedMutationTools: 0, excludedExecutors: ['test/alternate'] };
    expect(await f.select()).toMatchObject({ kind: 'decision', chosen: 'test/source' });
    expect(f.adapter.reserve('test/alternate')).toBeUndefined();
    expect(f.commit).not.toHaveBeenCalled();
  });
});

describe('reservation of an ordinary provider request', () => {
  it('starts a request of an authorized action, each request with its own reservation', () => {
    const f = fixture();
    const signal = new AbortController().signal;
    expect(f.adapter.dispatch('test/source', signal)).toBe(true);
    expect(f.adapter.dispatch('test/source', signal)).toBe(true);
    expect(f.adapter.dispatch('test/alternate', signal)).toBe(true);
  });

  it('refuses an action the authorization does not name, and a model it excludes', () => {
    const f = fixture();
    const signal = new AbortController().signal;
    expect(f.adapter.dispatch('test/stranger', signal)).toBe(false);
    const excluded = fixture();
    excluded.replace(excluded.boundaryOf(['test/source', 'test/alternate'], ['test/alternate']));
    const adapter = createUnifiedDispatch(excluded.host);
    expect(adapter.dispatch('test/alternate', signal)).toBe(false);
    expect(adapter.dispatch('test/source', signal)).toBe(true);
  });

  it('covers each effort by an authorization without an effort, and no other effort by an exact one', () => {
    const signal = new AbortController().signal;
    const pinned = fixture();
    pinned.replace(pinned.boundaryOf(['test/source']));
    expect(createUnifiedDispatch(pinned.host).dispatch('test/source:high', signal)).toBe(true);
    const exact = fixture();
    exact.replace(exact.boundaryOf(['test/source:low']));
    const adapter = createUnifiedDispatch(exact.host);
    expect(adapter.dispatch('test/source:low', signal)).toBe(true);
    expect(adapter.dispatch('test/source:high', signal)).toBe(false);
  });

  it.each(['profileDigest', 'branchId', 'workItemId', 'session', 'authorization', 'context'] as const)(
    'refuses the next request after %s changed since scoring', (field) => {
      const f = fixture();
      const signal = new AbortController().signal;
      expect(f.adapter.dispatch('test/source', signal)).toBe(true);
      const current = f.revisions[field];
      (f.revisions as unknown as Record<string, unknown>)[field] = typeof current === 'number' ? current + 1 : 'changed';
      expect(f.adapter.dispatch('test/alternate', signal)).toBe(false);
    });

  it('refuses a request of an assignment that another one replaced, until the live one is taken over', () => {
    const f = fixture();
    const signal = new AbortController().signal;
    f.replace(f.boundaryOf(['test/source', 'test/alternate']), 'newer');
    expect(f.adapter.dispatch('test/source', signal)).toBe(false);
    f.adapter.rebase();
    expect(f.adapter.dispatch('test/source', signal)).toBe(true);
    expect(f.adapter.recovery).toBe(false);
  });

  it('refuses a cancelled request, and any request once the boundary expired', () => {
    const f = fixture();
    const cancelled = new AbortController();
    cancelled.abort();
    expect(f.adapter.dispatch('test/source', cancelled.signal)).toBe(false);
    f.replace({ ...f.host.authorization()!, state: 'expired' });
    expect(createUnifiedDispatch(f.host).dispatch('test/source', new AbortController().signal)).toBe(false);
  });

  it('keeps a request without any boundary allowed, as a host without a boundary does', () => {
    const f = fixture();
    f.replace(undefined);
    expect(createUnifiedDispatch(f.host).dispatch('test/source', new AbortController().signal)).toBe(true);
  });
});
