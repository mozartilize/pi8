/**
 * Foreground subagent spend accounting.
 *
 * Pins the invariants that keep child spend comparable with parent turns:
 * children are priced from registry rates on observed tokens (never the
 * provider-billed `cost`), a child with no terminal usage produces no record,
 * and explicit non-router children are recorded but marked.
 */
import { describe, it, expect } from 'vitest';

import { computeSubagentSpend } from './subagent-spend.js';
import type { SubagentResultRow } from './subagent-results.js';
import type { Candidate } from '../types.js';

const candidates: Candidate[] = [
  {
    registryId: 'alpha/strong',
    provider: 'alpha',
    id: 'strong',
    bench: {
      registryId: 'alpha/strong',
      benchSlug: 'strong',
      active: true,
      quality: { intelligence: 95, coding: 95, agenticCoding: 95 },
      source: 'test',
    },
    cost: { input: 10, output: 50 },
    available: true,
  },
  {
    registryId: 'beta/cheap',
    provider: 'beta',
    id: 'cheap',
    bench: {
      registryId: 'beta/cheap',
      benchSlug: 'cheap',
      active: true,
      quality: { intelligence: 60, coding: 60, agenticCoding: 60 },
      source: 'test',
    },
    cost: { input: 1, output: 5 },
    available: true,
  },
];

function row(overrides: Partial<SubagentResultRow> = {}): SubagentResultRow {
  return {
    index: 0,
    model: 'beta/cheap',
    modelAttempts: [],
    usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0 },
    ...overrides,
  };
}

describe('computeSubagentSpend', () => {
  it('prices a child from registry rates and its baseline from the same tokens', () => {
    const [record] = computeSubagentSpend([row()], {
      candidates,
      role: 'worker',
      routerOwnedModels: ['beta/cheap'],
    });
    expect(record?.model).toBe('beta/cheap');
    // Registry rates are USD per 1M tokens, so priced spend divides by 1e6.
    expect(record?.routedCost).toBe((1 * 100 + 5 * 20) / 1_000_000);
    expect(record?.baselineModel).toBe('alpha/strong');
    expect(record?.baselineCost).toBe((10 * 100 + 50 * 20) / 1_000_000);
    expect(record?.routerOwned).toBe(true);
  });

  it('ignores the provider-billed cost when pricing, carrying it only as a cross-check', () => {
    // A subscription provider reports cost 0 for real token spend; the record
    // must still price those tokens rather than inherit the zero.
    const [record] = computeSubagentSpend(
      [row({ usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0 } })],
      { candidates, role: 'worker', routerOwnedModels: ['beta/cheap'] },
    );
    expect(record?.routedCost).toBeGreaterThan(0);
    expect(record?.reportedCost).toBe(0);
  });

  it('strips a thinking suffix so an effort-tagged child still matches its registry price', () => {
    const [record] = computeSubagentSpend([row({ model: 'beta/cheap:high' })], {
      candidates,
      role: 'worker',
      routerOwnedModels: ['beta/cheap:high'],
    });
    expect(record?.model).toBe('beta/cheap');
    expect(record?.routedCost).toBe((1 * 100 + 5 * 20) / 1_000_000);
    expect(record?.routerOwned).toBe(true);
  });

  it('marks a child the router did not own', () => {
    const [record] = computeSubagentSpend([row()], {
      candidates,
      role: 'worker',
      routerOwnedModels: ['alpha/strong'],
    });
    expect(record?.routerOwned).toBe(false);
  });

  it('records nothing for a child with no terminal usage (async spawn)', () => {
    expect(
      computeSubagentSpend([row({ usage: undefined })], {
        candidates,
        routerOwnedModels: [],
      }),
    ).toEqual([]);
  });

  it('records nothing for a child whose usage is all zeros', () => {
    expect(
      computeSubagentSpend(
        [row({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } })],
        { candidates, routerOwnedModels: [] },
      ),
    ).toEqual([]);
  });

  it('leaves routedCost undefined for a child with no published price', () => {
    const [record] = computeSubagentSpend([row({ model: 'gamma/unknown' })], {
      candidates,
      role: 'worker',
      routerOwnedModels: [],
    });
    expect(record?.routedCost).toBeUndefined();
    expect(record?.baselineCost).toBe((10 * 100 + 50 * 20) / 1_000_000);
  });

  it('honours a config baseline pin that is in the candidate pool', () => {
    const [record] = computeSubagentSpend([row()], {
      candidates,
      configBaselineModel: 'beta/cheap',
      role: 'worker',
      routerOwnedModels: ['beta/cheap'],
    });
    expect(record?.baselineModel).toBe('beta/cheap');
    expect(record?.baselineSource).toBe('config');
  });
});
