import { describe, it, expect } from 'vitest';
import { POLICY_PASSIVE_CAUSES, scoredIncumbentKey } from './routing-policy.js';
import { candidate, benchRow } from '../../test-support/router-fixtures.js';

describe('POLICY_PASSIVE_CAUSES', () => {
  it('names only causes that carry no active routing intent', () => {
    expect(POLICY_PASSIVE_CAUSES.has('heuristic')).toBe(true);
    expect(POLICY_PASSIVE_CAUSES.has('continuation-context')).toBe(true);
    expect(POLICY_PASSIVE_CAUSES.has('no-data')).toBe(true);
    expect(POLICY_PASSIVE_CAUSES.has('router-consult')).toBe(false);
  });
});

describe('scoredIncumbentKey', () => {
  const low = candidate('p/strong', {
    effort: 'low', reasoning: true,
    thinkingLevelMap: { off: 'off', low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null },
    bench: { ...benchRow('strong'), effort: 'low' },
  });

  it('keeps a key that a row has', () => {
    expect(scoredIncumbentKey([low], 'p/strong:low')).toBe('p/strong:low');
  });

  it('keeps an effort above a labelled row of the model', () => {
    expect(scoredIncumbentKey([low], 'p/strong:high')).toBe('p/strong:high');
  });

  it('rejects an effort the model has no lower labelled row for', () => {
    expect(scoredIncumbentKey([low], 'p/strong:off')).toBeUndefined();
    expect(scoredIncumbentKey([{ ...low, effort: 'high' }], 'p/strong:low')).toBeUndefined();
    expect(scoredIncumbentKey([{ ...low, effort: undefined }], 'p/strong:high')).toBeUndefined();
    expect(scoredIncumbentKey([low], 'p/other:high')).toBeUndefined();
  });
});
