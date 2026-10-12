import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactMatches, compileDomainArtifact, domainIdentity, reviveDomainArtifact } from '../routing/optimization/domain.js';
import { WorkerLpAdapter } from '../routing/optimization/lp.js';
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
    expect(fresh.lookup(domainIdentity(profile))?.identity).toBe(domainIdentity(profile));
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

  it('rejects a stored artifact whose representative lies outside its polytope', async () => {
    const artifact = await compileDomainArtifact(profile, lp);
    const tampered = { ...artifact, representativePoint: artifact.representativePoint.map(() => 5) };
    fileDomainStore.write(tampered);
    expect(artifactMatches(fileDomainStore.read(artifact.identity), profile, preferenceProfileDigest(profile))).toBe(false);
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
