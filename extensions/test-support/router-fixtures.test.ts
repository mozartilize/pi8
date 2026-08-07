import { describe, it, expect } from 'vitest';
import { benchRow, candidate, registryModel, subagentResultRow } from './router-fixtures.js';

describe('router fixtures', () => {
  it('returns independent override-friendly fixtures', () => {
    const first = benchRow('alpha/model', { quality: { coding: 90 } });
    const second = benchRow('alpha/model');
    first.quality.coding = 1;
    expect(second.quality.coding).not.toBe(1);
  });

  it('merges candidate cost metadata fresh without sharing', () => {
    const first = candidate('alpha/model', { cost: { input: 10, output: 30 } });
    const second = candidate('alpha/model');
    // A partial cost override merges onto the defaults rather than replacing.
    expect(first.cost).toEqual({ input: 10, output: 30, cacheRead: 0.0000003, cacheWrite: 0.00000375 });
    first.cost!.input = 1;
    expect(second.cost!.input).toBe(0.000003);
  });

  it('preserves an explicit absent cost for unknown-price tests', () => {
    const noCost = candidate('alpha/model', { cost: undefined });
    expect(noCost.cost).toBeUndefined();
  });

  it('derives provider/id from the registry id', () => {
    const model = registryModel('alpha/gpt-4o');
    expect(model.provider).toBe('alpha');
    expect(model.id).toBe('gpt-4o');
    expect(model.baseUrl).toBe('https://alpha.example.test');
  });

  it('builds fresh subagent result rows per call', () => {
    const first = subagentResultRow({ model: 'provider/strong' });
    const second = subagentResultRow();
    first.modelAttempts.push({ model: 'provider/strong', success: true });
    expect(second.modelAttempts).toEqual([]);
    expect(second.model).toBe('provider/fast:high');
  });
});
