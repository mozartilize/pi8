import { afterAll, describe, expect, it, vi } from 'vitest';
import { registryModel } from '../test-support/router-fixtures.js';
import { buildCandidate } from '../routing/score/scorer.js';
import { WorkerLpAdapter } from '../routing/optimization/lp.js';
import type { AssignmentRevisions } from '../routing/policy/assignment-transaction.js';
import type { BenchModel } from '../types.js';
import { readPreferences, type UnifiedTurnInput, type UnifiedTurnOutcome } from './unified-decision.js';
import { createUnifiedRecovery } from './unified-recovery.js';

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
    workItemId: 'work', branchId: 'branch', session: 1, profile: 0,
    profileDigest: readPreferences().digest, authorization: 1, context: 1,
  };
  let assignmentId = 'assignment';
  const input: UnifiedTurnInput = {
    state: { phase: 'implement', workItemId: 'work', estimatedContextTokens: 1000,
      needsVision: false, boundary: 'ordinary', friction: [], nowMs: 0,
      isSubagentSpawn: false, benchmarkIndexVersion: '4.3' },
    authorizationScope: { boundaryId: 'entry', workItemId: 'work', phase: 'implement', assignmentId, revision: 1 },
    cause: 'incumbent', candidates, registryModels: models, rows,
    isExcluded: () => false, isCurrent: () => true,
    ports: { lp, domains: { lookup: () => undefined } },
  };
  const commit = vi.fn((outcome: Extract<UnifiedTurnOutcome, { kind: 'decision' }>) => {
    revisions.authorization = outcome.authorization.revision;
    assignmentId = outcome.authorization.assignmentId;
    return true;
  });
  const adapter = createUnifiedRecovery({ input, candidates: () => candidates, models: () => models,
    revisions: () => ({ ...revisions }), assignmentId: () => assignmentId, commit });
  const signal = new AbortController();
  const select = () => adapter.select('test/source', adapter.reachable('test/source'), () => true, signal.signal);
  return { adapter, select, signal, revisions, commit, candidates, input };
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
