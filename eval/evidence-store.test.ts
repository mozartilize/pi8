import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileEvidenceStore, getOrExecute } from './evidence-store.ts';
import { hashRecipe, slotKey, wholeTaskRecipe } from './recipe.ts';
import type { CompletedExecutionV1, EvaluationArm, EvidenceSelectionPolicy, ExecutionRecipeV1 } from './schema.ts';

const frozen = {
  task: { id: 'queue', baseRevision: 'r1', publicFixtureDigest: 'f', environmentDigest: 'e' },
  runtime: {
    piRevision: 'p', pi8Commit: 'c', configDigest: 'cfg', benchmarkStoreDigest: 'b', candidateRegistryDigest: 'r',
    providerEndpointDigest: 'ep', systemPromptDigest: 's', toolsetDigest: 't', generationParametersDigest: 'g',
  },
};
const arm: EvaluationArm = { id: 'a', policy: { kind: 'current-auto' }, continuation: 'normal-policy' };
const recipe: ExecutionRecipeV1 = wholeTaskRecipe(arm, frozen);

const policy: EvidenceSelectionPolicy = { reuse: { mode: 'historical-analysis' }, choose: 'exact-compatible', cutoffAt: '2999-01-01T00:00:00Z' };

function completed(endedAt: string, revision?: string): CompletedExecutionV1 {
  return {
    status: 'completed',
    provenance: { producedByRunId: 'run', startedAt: endedAt, endedAt },
    deployment: [{ provider: 'p', modelId: 'm', observedAt: endedAt, ...(revision ? { reportedRevision: revision } : {}) }],
    finalArtifact: { digest: 'd', path: '', regradeable: true, stateKinds: ['git-worktree'] },
    decisionLogDigest: 'l', realizedTrajectoryDigest: 't', realizedWorkspaceDigest: 'w',
    rawUsage: { attempts: [], spendIncomplete: false },
    wallTimeMs: 1, providerFailures: 0, fallbackCount: 0, capabilityEscalations: 0,
  };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pi8-evidence-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('execution evidence store', () => {
  it('reuses one execution from another session and keeps the arm out of the slot', async () => {
    let runs = 0;
    const run = async () => { runs++; return { result: completed('2026-01-01T00:00:00Z') }; };
    const first = await getOrExecute(new FileEvidenceStore(dir), { recipe, replicate: 1 }, policy, run);
    const other = wholeTaskRecipe({ ...arm, id: 'other-arm' }, frozen);
    const second = await getOrExecute(new FileEvidenceStore(dir), { recipe: other, replicate: 1 }, policy, run);
    expect(runs).toBe(1);
    expect(first.reused).toBe(false);
    expect(second).toMatchObject({ reused: true, evidence: { executionId: first.evidence.executionId } });
  });

  it('runs only the missing replicate slots', async () => {
    const store = new FileEvidenceStore(dir);
    let runs = 0;
    const run = async () => { runs++; return { result: completed('2026-01-01T00:00:00Z') }; };
    for (const replicate of [1, 2, 3]) await getOrExecute(store, { recipe, replicate }, policy, run);
    runs = 0;
    for (const replicate of [1, 2, 3, 4, 5]) await getOrExecute(store, { recipe, replicate }, policy, run);
    expect(runs).toBe(2);
  });

  it('leases a slot so that two sessions pay once', async () => {
    let runs = 0;
    const run = async () => { runs++; await new Promise((r) => setTimeout(r, 50)); return { result: completed('2026-01-01T00:00:00Z') }; };
    const options = { pollMs: 10 };
    const [a, b] = await Promise.all([
      getOrExecute(new FileEvidenceStore(dir, options), { recipe, replicate: 1 }, policy, run),
      getOrExecute(new FileEvidenceStore(dir, options), { recipe, replicate: 1 }, policy, run),
    ]);
    expect(runs).toBe(1);
    expect(a.evidence.executionId).toBe(b.evidence.executionId);
  });

  it('adds a new generation for an expired opaque model and never overwrites history', async () => {
    let now = Date.parse('2026-01-10T00:00:00Z');
    const store = new FileEvidenceStore(dir, { now: () => now });
    const maxAge: EvidenceSelectionPolicy = { reuse: { mode: 'opaque-model-max-age', maxAgeMs: 24 * 3600_000 }, choose: 'freshest-compatible', cutoffAt: '2999-01-01T00:00:00Z' };
    const slot = slotKey(recipe, 1);
    const old = await store.appendExecution(slot, recipe, completed('2026-01-10T00:00:00Z'));
    expect((await store.selectOne(slot, recipe, maxAge))?.executionId).toBe(old.executionId);
    now += 3 * 24 * 3600_000;
    expect(await store.selectOne(slot, recipe, maxAge)).toBeUndefined();
    const fresh = await store.appendExecution(slot, recipe, completed('2026-01-13T00:00:00Z'));
    expect((await store.selectOne(slot, recipe, maxAge))?.executionId).toBe(fresh.executionId);
    expect(readdirSync(join(dir, 'executions', slot.recipeHash, '1'))).toHaveLength(2);
  });

  it('stores an operational failure apart from the slot', async () => {
    const store = new FileEvidenceStore(dir);
    const slot = slotKey(recipe, 1);
    await expect(store.appendExecution(slot, recipe, { ...completed('2026-01-01T00:00:00Z'), status: 'provider-error' })).rejects.toThrow(/operational/);
    expect(await store.selectOne(slot, recipe, policy)).toBeUndefined();
    expect(readdirSync(join(dir, 'operational', hashRecipe(recipe), '1'))).toHaveLength(1);
  });

  it('removes an expired lease without touching stored evidence', async () => {
    let now = 1_000_000;
    const store = new FileEvidenceStore(dir, { now: () => now, leaseExpiryMs: 1000, pollMs: 1 });
    const slot = slotKey(recipe, 1);
    const stored = await store.appendExecution(slot, recipe, completed('2026-01-01T00:00:00Z'));
    mkdirSync(join(dir, 'locks'), { recursive: true });
    writeFileSync(join(dir, 'locks', `${slot.recipeHash}-1.lock`), JSON.stringify({ pid: 999999, host: 'other-host', startedAt: now, token: 'x' }), { flag: 'w' });
    now += 5000;
    const lease = await store.acquireLease(slot);
    await lease.release();
    expect((await store.selectOne(slot, recipe, policy))?.executionId).toBe(stored.executionId);
  });
});
