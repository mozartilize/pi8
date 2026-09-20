import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  BENCHLM_FETCH_TIMEOUT_MS,
  extractNextData,
  fetchRaw,
  normalize,
  unwrap,
} from './benchlm.js';
import { resolveRows } from '../bench/matcher.js';
import { DEFAULT_BENCHMARK_ALIASES } from '../bench/store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(__dirname, '../__fixtures__/benchlm-aaomniscience.html'), 'utf8');

const fixtureRows = () => normalize(unwrap(JSON.parse(extractNextData(fixture))).rows);

describe('benchlm adapter', () => {
  it('attaches a finite timeout to page requests', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(fixture, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const rows = await fetchRaw({ endpoint: 'https://example.test/benchmarks/aaomniscienceindex' });
      expect(rows).toHaveLength(15);
      expect(BENCHLM_FETCH_TIMEOUT_MS).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('throws when the page has no __NEXT_DATA__ block', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html><body>challenge page</body></html>', { status: 200 })),
    );
    try {
      await expect(fetchRaw({})).rejects.toThrow(/no __NEXT_DATA__/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('throws on a changed response shape', () => {
    expect(() => unwrap({ props: {} })).toThrow(/expected props\.pageProps\.leaderboard/);
  });

  it('publishes the omniscience score as quality.knowledge, not intelligence', () => {
    const rows = fixtureRows();
    const claudeFable = rows.find((r) => r.benchSlug === 'claude-fable');
    expect(claudeFable?.quality).toEqual({ knowledge: 40.2 });
    expect(claudeFable?.quality.intelligence).toBeUndefined();
    expect(claudeFable?.source).toBe('benchlm');
    // Negative index values are real measurements, not missing data.
    expect(rows.find((r) => r.benchSlug === 'granite-4-0-h-350m')?.quality).toEqual({
      knowledge: -87.2,
    });
  });

  it('parses reasoning-effort labels from the display name', () => {
    const rows = fixtureRows();
    expect(rows.find((r) => r.benchSlug === 'deepseek-v4-pro-max')?.effort).toBe('max');
    expect(rows.find((r) => r.benchSlug === 'deepseek-v4-pro-high')?.effort).toBe('high');
    expect(rows.find((r) => r.benchSlug === 'gpt-5-high')?.effort).toBe('high');
    // (Adaptive)/(Reasoning) are not effort levels — unknown, never promoted.
    expect(rows.find((r) => r.benchSlug === 'claude-opus-4-7-adaptive')?.effort).toBeUndefined();
    expect(rows.find((r) => r.benchSlug === 'kimi-k2-5-reasoning')?.effort).toBeUndefined();
    expect(rows.find((r) => r.benchSlug === 'claude-fable')?.effort).toBeUndefined();
  });

  it('resolves through the bundled aliases and run variants', () => {
    const registry = [
      { provider: 'claude-bridge', id: 'claude-fable-5' },
      { provider: 'github-copilot', id: 'claude-fable-5' },
      { provider: 'opencode', id: 'claude-fable-5' },
      { provider: 'github-copilot', id: 'kimi-k3' },
      { provider: 'opencode-go', id: 'kimi-k3' },
      { provider: 'opencode', id: 'kimi-k3' },
      { provider: 'opencode-go', id: 'kimi-k2.6' },
      { provider: 'opencode', id: 'kimi-k2.6' },
      { provider: 'opencode', id: 'claude-sonnet-4' },
      { provider: 'deepseek', id: 'deepseek-v4-pro' },
      { provider: 'opencode-go', id: 'deepseek-v4-pro' },
      { provider: 'opencode', id: 'deepseek-v4-pro' },
      { provider: 'deepseek', id: 'deepseek-v4-flash' },
      { provider: 'opencode-go', id: 'deepseek-v4-flash' },
      { provider: 'opencode', id: 'deepseek-v4-flash' },
      { provider: 'opencode', id: 'gpt-5' },
    ];
    const resolved = resolveRows(fixtureRows(), registry, DEFAULT_BENCHMARK_ALIASES);

    // claude-fable binds every provider copy of Claude Fable 5.
    const fable = resolved.filter((r) => r.benchSlug === 'claude-fable' && r.active);
    expect(fable.map((r) => r.registryId).sort()).toEqual([
      'claude-bridge/claude-fable-5',
      'github-copilot/claude-fable-5',
      'opencode/claude-fable-5',
    ]);
    expect(fable.every((r) => r.quality.knowledge === 40.2)).toBe(true);

    // Max-effort run variants bind the base model with the effort carried.
    const proMax = resolved.filter((r) => r.benchSlug === 'deepseek-v4-pro-max' && r.active);
    expect(proMax).toHaveLength(3);
    expect(proMax.every((r) => r.effort === 'max' && r.quality.knowledge === -10)).toBe(true);

    const flashMax = resolved.filter((r) => r.benchSlug === 'deepseek-v4-flash-max' && r.active);
    expect(flashMax).toHaveLength(3);
    expect(flashMax.every((r) => r.effort === 'max')).toBe(true);

    // A row with no registry entry stays inactive (surfaced by /router-status).
    expect(resolved.find((r) => r.benchSlug === 'granite-4-0-h-350m')?.active).toBe(false);
  });
});
