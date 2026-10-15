import { describe, expect, it } from 'vitest';

import type { RegistryModelInfo } from '../score/scorer.js';
import { enumerateEffectiveActions } from './actions.js';
import { usableWarmPrefix } from './cache.js';
import type { SpendSnapshot } from './state.js';

/**
 * Cache eligibility contract: a warm record counts only while its age is in
 * [0, lifetime), where the lifetime is the candidate model's own lifetime at
 * the retention tier of the request that wrote the record.
 */
const model: RegistryModelInfo = {
  provider: 'p', id: 'm', reasoning: true,
  thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: null },
  cost: { input: 1, output: 4, cacheRead: 0.1 },
  promptCache: { short: 300, long: 3600 },
};
const action = enumerateEffectiveActions(model).find((a) => a.effort === 'high')!;
const NOW = 10_000_000;

type PromptCache = RegistryModelInfo['promptCache'];
const snapshot = (ageMs: number, written: 'short' | 'long', requested: 'short' | 'long' = written, promptCache: PromptCache | 'none' = model.promptCache): [SpendSnapshot, RegistryModelInfo] => [{
  estimatedContextTokens: 100_000,
  nowMs: NOW,
  isSubagentSpawn: false,
  promptIdentity: 'head',
  cache: {
    promptIdentity: 'head',
    incumbentKey: action.key,
    retention: requested,
    warmPrefixes: new Map([[action.key, [{ tokens: 50_000, observedAtMs: NOW - ageMs, hitProbability: 1, retention: written }]]]),
  },
}, { ...model, promptCache: promptCache === 'none' ? undefined : promptCache }];

const eligibility = (...args: Parameters<typeof snapshot>) => {
  const [state, m] = snapshot(...args);
  return usableWarmPrefix(state, action, m).eligibility;
};

describe('cache eligibility lifetime', () => {
  it('a record is live from age 0 up to, not including, the lifetime of its tier', () => {
    expect(eligibility(0, 'short')).toBe('eligible');
    expect(eligibility(299_999, 'short')).toBe('eligible');
    expect(eligibility(300_000, 'short')).toBe('expired');
    expect(eligibility(3_599_999, 'long')).toBe('eligible');
    expect(eligibility(3_600_000, 'long')).toBe('expired');
  });

  it('a record from the future is not live', () => {
    expect(eligibility(-1, 'short')).toBe('expired');
  });

  it('the lifetime is the tier that wrote the record, not the tier of the current request', () => {
    expect(eligibility(1_000_000, 'short', 'long')).toBe('expired');
    expect(eligibility(1_000_000, 'long', 'short')).toBe('eligible');
  });

  it('the lifetime is the candidate model\'s own; an undeclared tier gives no credit', () => {
    expect(eligibility(1_000_000, 'short', 'short', { short: 3600 })).toBe('eligible');
    expect(eligibility(100_000, 'long', 'long', { short: 300 })).toBe('ttl-unknown');
    expect(eligibility(100_000, 'short', 'short', 'none')).toBe('ttl-unknown');
  });
});
