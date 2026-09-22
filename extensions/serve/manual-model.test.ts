import { describe, expect, it } from 'vitest';
import { registryModel } from '../test-support/router-fixtures.js';
import { resolveManualModel } from './manual-model.js';

const models = [
  registryModel('alpha/first', { reasoning: true, thinkingLevelMap: { high: 'high' } }),
  registryModel('openrouter/deepseek-r1:free', { reasoning: true, thinkingLevelMap: { high: 'high' } }),
  registryModel('router/auto'),
];

describe('resolveManualModel', () => {
  it('accepts an exact registry id', () => {
    expect(resolveManualModel('alpha/first', models)).toEqual({ registryId: 'alpha/first' });
  });

  it('accepts provider/id:thinking when the model supports that level', () => {
    expect(resolveManualModel('alpha/first:high', models)).toEqual({
      registryId: 'alpha/first',
      thinking: 'high',
    });
  });

  it('prefers an exact colon-containing id over thinking-suffix parse', () => {
    expect(resolveManualModel('openrouter/deepseek-r1:free', models)).toEqual({
      registryId: 'openrouter/deepseek-r1:free',
    });
  });

  it('rejects the synthetic router provider and unknown models', () => {
    expect(resolveManualModel('router/auto', models)).toBeUndefined();
    expect(resolveManualModel('missing/model', models)).toBeUndefined();
    expect(resolveManualModel('alpha/first:xhigh', models)).toBeUndefined();
  });
});
