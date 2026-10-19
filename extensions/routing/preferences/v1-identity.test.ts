/**
 * A stored `preferences.version: 1` profile keeps its identity: the profile
 * digest, the identity of its compiled domain, and the compiled domain
 * itself. A change to one of them makes stored profiles and compiled domain
 * artifacts mean something else, so it needs a preference version change.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { FEATURE_MAPPING_VERSION, FEATURE_NAMES, FEATURE_SCHEMA_DIGEST } from '../features/schema.js';
import { compileDomainArtifact, domainIdentity } from '../optimization/domain.js';
import { WorkerLpAdapter } from '../optimization/lp.js';
import { CORE_SCENARIOS_V1_DIGEST } from './scenarios.js';
import { PREFERENCES_VERSION, preferenceProfileDigest, type UserRoutingPreferencesV1 } from './schema.js';

const OPERATOR: UserRoutingPreferencesV1 = {
  version: 1, settledImplementation: 'lower_cost', openDesignDecisions: 'higher_reasoning_capability',
  handoffWarmCache: 'switch_for_capability', researchTasks: 'higher_research_capability', afterRework: 'switch_model',
};

const lp = new WorkerLpAdapter();
afterAll(() => lp.close());

describe('v1 preference profile identity', () => {
  it('keeps the feature space, the scenario digest, and the profile digests', () => {
    expect(PREFERENCES_VERSION).toBe(1);
    expect(FEATURE_NAMES).toHaveLength(10);
    expect(FEATURE_NAMES).toContain('frictionAvoidance');
    expect(FEATURE_MAPPING_VERSION).toBe('feature-v11');
    expect(FEATURE_SCHEMA_DIGEST).toBe('689acf560953d906437ce4748e19504c2092fe5a19601633550079f3d4cff326');
    expect(CORE_SCENARIOS_V1_DIGEST).toBe('1b0dc4917432636b6231685d6ef5fe2108c03d8b441715acc8d60d23a52ea958');
    expect(preferenceProfileDigest(OPERATOR)).toBe('27e9bc7334ffe891f4b5662bde897b47e707610cc7a4b5739e4b85356f35d945');
    expect(domainIdentity(OPERATOR)).toBe('778567e56ccebbb5b3206af2ece61c5cfcc2f687d1b7a9800f0ac13a9e32354f');
  });

  it('compiles the same domain for the stored profile', async () => {
    const artifact = await compileDomainArtifact(OPERATOR, lp);
    expect(artifact.identity).toBe(domainIdentity(OPERATOR));
    expect(artifact.profileDigest).toBe(preferenceProfileDigest(OPERATOR));
    expect(artifact.domain.mode).toBe('hard');
    const expected = [0.236813, 0.041304, 0.086224, 0.05, 0.353658, 0.05, 0.09, 0.04, 0.01, 0.042];
    artifact.thetaRepresentative.forEach((value, index) => expect(value).toBeCloseTo(expected[index]!, 5));
  });
});
