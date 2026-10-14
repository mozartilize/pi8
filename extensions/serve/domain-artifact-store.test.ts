import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactMatches, compileDomainArtifact, domainIdentity, reviveDomainArtifact } from '../routing/optimization/domain.js';
import { WorkerLpAdapter, type LPAdapter } from '../routing/optimization/lp.js';
import { DomainCache } from '../routing/optimization/select.js';
import { preferenceProfileDigest, validatePreferences } from '../routing/preferences/schema.js';
import { fileDomainStore } from './domain-artifact-store.js';

const lp = new WorkerLpAdapter();
afterAll(() => lp.close());

const profile = validatePreferences({
  version: 1, settledImplementation: 'lower_cost', openDesignDecisions: 'higher_reasoning_capability',
  handoffWarmCache: 'switch_for_capability', researchTasks: 'higher_research_capability', afterRework: 'switch_model',
}).profile!;

describe('file domain store', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pi8-domain-store-'));
    vi.stubEnv('PI8_DIR', dir);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns an artifact that the selector accepts for the same profile', async () => {
    const artifact = await compileDomainArtifact(profile, lp);
    fileDomainStore.write(artifact);
    const stored = fileDomainStore.read(artifact.identity);
    expect(artifactMatches(stored, profile, preferenceProfileDigest(profile))).toBe(true);
    // JSON writes -0 as 0; every other number round-trips exactly.
    expect(JSON.stringify(stored)).toBe(JSON.stringify(artifact));
  });

  it('serves a new cache from the file without a compile', async () => {
    await new DomainCache(lp, fileDomainStore).compile(profile);
    const fresh = new DomainCache(lp, fileDomainStore);
    const stored = fresh.lookup(domainIdentity(profile));
    expect(stored?.identity).toBe(domainIdentity(profile));
    expect(await fresh.compile(profile)).toBe(stored);
  });

  it('reads a null column bound as an unbounded column', async () => {
    const artifact = await compileDomainArtifact(profile, lp);
    const parsed = JSON.parse(JSON.stringify(artifact));
    parsed.domain.polytope.colUpper[0] = null;
    parsed.domain.polytope.colLower[0] = null;
    const revived = reviveDomainArtifact(parsed)!;
    expect(revived.domain.polytope.colUpper[0]).toBeUndefined();
    expect(revived.domain.polytope.colLower[0]).toBeUndefined();
    expect(reviveDomainArtifact({ status: 'ready' })).toBeUndefined();
  });

  it.each(['representative', 'profile-digest'] as const)('rebuilds a cached artifact with an invalid %s', async (invalid) => {
    const artifact = await compileDomainArtifact(profile, lp);
    const tampered = invalid === 'representative'
      ? { ...artifact, representativePoint: artifact.representativePoint.map(() => 5) }
      : { ...artifact, profileDigest: 'wrong-profile' };
    fileDomainStore.write(tampered);
    const cache = new DomainCache(lp, fileDomainStore);
    const digest = preferenceProfileDigest(profile);
    expect(artifactMatches(cache.lookup(artifact.identity), profile, digest)).toBe(false);

    // Rejection requests a background compile. Concurrent requests share it.
    cache.request(profile);
    const pending = cache.compile(profile);
    const concurrent = cache.compile(profile);
    const duringCompile = cache.lookup(artifact.identity);
    const repaired = await pending;
    expect(artifactMatches(repaired, profile, digest)).toBe(true);
    expect(duringCompile).toBeUndefined();
    expect(concurrent).toBe(pending);
    expect(cache.lookup(artifact.identity)).toBe(repaired);
    expect(cache.failed(artifact.identity)).toBe(false);
    expect(artifactMatches(fileDomainStore.read(artifact.identity), profile, digest)).toBe(true);
  });

  it('does not reload a rejected artifact after compilation fails, and permits an explicit retry', async () => {
    const artifact = await compileDomainArtifact(profile, lp);
    fileDomainStore.write({ ...artifact, profileDigest: 'wrong-profile' });
    const read = vi.fn(fileDomainStore.read);
    const solve = vi.fn<LPAdapter['solve']>((...args) => lp.solve(...args))
      .mockRejectedValueOnce(new Error('solver unavailable'));
    const cache = new DomainCache({ solve, close: async () => {} }, { ...fileDomainStore, read });
    cache.lookup(artifact.identity);
    expect(await cache.compile(profile)).toBeUndefined();
    expect(solve).toHaveBeenCalledTimes(1);
    expect(cache.failed(artifact.identity)).toBe(true);
    expect(cache.lookup(artifact.identity)).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(1);

    expect(artifactMatches(await cache.compile(profile), profile, preferenceProfileDigest(profile))).toBe(true);
    expect(cache.failed(artifact.identity)).toBe(false);
  });

  it('treats an unreadable file as a miss and keeps at most eight profiles', async () => {
    writeFileSync(join(dir, 'domain-artifacts.json'), '{not json');
    expect(fileDomainStore.read('anything')).toBeUndefined();
    const artifact = await compileDomainArtifact(profile, lp);
    for (let i = 0; i < 10; i++) fileDomainStore.write({ ...artifact, identity: `identity-${i}` });
    expect(fileDomainStore.read('identity-0')).toBeUndefined();
    expect(fileDomainStore.read('identity-2')).toBeDefined();
    expect(fileDomainStore.read('identity-9')).toBeDefined();
  });
});
