import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  loadStore,
  saveStore,
  emptyStore,
  isStale,
  isValidStore,
  mergeBenchRows,
  checkBenchmarkStore,
  addAlias,
  resolveStoragePath,
  DEFAULT_BENCHMARK_ALIASES,
} from './store.js';
import { STALE_MS } from '../constants.js';
import { writeJsonAtomic } from '../json-file.js';
import type { BenchmarkStore } from '../types.js';

describe('store', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pi8-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads persisted aliases alongside bundled defaults', () => {
    const store: BenchmarkStore = {
      version: 2,
      syncedAt: Date.now(),
      models: [],
      aliases: { 'claude-opus-4-6': 'anthropic/claude-opus-4-6-20260115' },
    };
    saveStore(store, tmpDir);
    const loaded = loadStore(tmpDir);
    expect(loaded).toEqual({
      ...store,
      aliases: { ...DEFAULT_BENCHMARK_ALIASES, ...store.aliases },
    });
  });

  it('seeds residual provider-specific benchmark aliases', () => {
    expect(emptyStore().aliases).toEqual({
      'gpt-5-1-codex': 'opencode/gpt-5.1-codex-max',
      'mimo-v2-5-pro': 'opencode-go/mimo-v2.5',
      'gpt-5-3-codex': 'openai-codex/gpt-5.3-codex-spark',
      'claude-4-sonnet': 'opencode/claude-sonnet-4',
    });
  });

  it('overlays persisted user aliases onto bundled defaults', () => {
    writeJsonAtomic(join(tmpDir, 'benchmarks.json'), {
      version: 2,
      syncedAt: 123,
      aliases: { 'gpt-5-1-codex': 'custom/gpt-5.1-codex' },
      models: [],
    });

    expect(loadStore(tmpDir)?.aliases).toEqual({
      'gpt-5-1-codex': 'custom/gpt-5.1-codex',
      'mimo-v2-5-pro': 'opencode-go/mimo-v2.5',
      'gpt-5-3-codex': 'openai-codex/gpt-5.3-codex-spark',
      'claude-4-sonnet': 'opencode/claude-sonnet-4',
    });
  });

  it('returns undefined for missing file', () => {
    expect(loadStore(tmpDir)).toBeUndefined();
  });

  it('returns undefined for corrupt json', () => {
    saveStore({} as BenchmarkStore, tmpDir);
    const file = join(resolveStoragePath(tmpDir), 'benchmarks.json');
    // Intentionally corrupt the file after atomic write.
    const fs = require('node:fs');
    fs.writeFileSync(file, '{not json', 'utf8');
    expect(loadStore(tmpDir)).toBeUndefined();
  });

  it('detects staleness at boundary', () => {
    const now = 1_000_000;
    const fresh: BenchmarkStore = { ...emptyStore(), syncedAt: now - STALE_MS + 1 };
    const stale: BenchmarkStore = { ...emptyStore(), syncedAt: now - STALE_MS - 1 };
    expect(isStale(fresh, now)).toBe(false);
    expect(isStale(stale, now)).toBe(true);
  });

  it('validates store shape', () => {
    expect(isValidStore({ version: 2, syncedAt: 0, models: [], aliases: {} })).toBe(true);
    expect(isValidStore({ version: 1, syncedAt: 0, models: [], aliases: {} })).toBe(false);
    expect(isValidStore(null)).toBe(false);
  });

  it('discards a v1 store on load, logging one line and returning empty', () => {
    writeJsonAtomic(join(tmpDir, 'benchmarks.json'), {
      version: 1,
      syncedAt: 456,
      aliases: {},
      models: [
        {
          registryId: 'alpha/model',
          benchSlug: 'alpha-model',
          active: true,
          quality: { intelligence: 80 },
          source: 'fixture',
        },
      ],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const loaded = loadStore(tmpDir);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain('v1');
      expect(loaded).toEqual(emptyStore());
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps effort variants of one registryId as separate merged rows', () => {
    const base = {
      registryId: 'a/b',
      active: true,
      benchSlug: 'x',
      quality: { intelligence: 80 },
      source: 'aa',
    };
    const rows = [
      { ...base, benchSlug: 'x-low', effort: 'low', quality: { intelligence: 30 } },
      { ...base, benchSlug: 'x-max', effort: 'max', quality: { intelligence: 50 } },
      // Same (registryId, effort) pair as the first row: one of the two is kept.
      {
        ...base,
        benchSlug: 'x-low-2',
        effort: 'low',
        quality: { coding: 90, agenticCoding: 85 },
      },
    ] as any;
    const merged = mergeBenchRows(rows);
    expect(merged).toHaveLength(2);
    const low = merged.find((m) => m.effort === 'low');
    const max = merged.find((m) => m.effort === 'max');
    expect(low).toMatchObject({ benchSlug: 'x-low-2', quality: { coding: 90, agenticCoding: 85 } });
    expect(max?.quality).toEqual({ intelligence: 50 });
  });

  it('sanitizes effort on load and drops unknown levels', () => {
    writeJsonAtomic(join(tmpDir, 'benchmarks.json'), {
      version: 2,
      syncedAt: 123,
      aliases: {},
      models: [
        {
          registryId: 'alpha/model',
          benchSlug: 'alpha-model',
          active: true,
          quality: { intelligence: 80 },
          effort: 'high',
          costPerTask: 0.42,
          latencyMsTtfa: 1234,
          source: 'fixture',
        },
        {
          registryId: 'beta/model',
          benchSlug: 'beta-model',
          active: true,
          quality: { intelligence: 70 },
          effort: 'super-high',
          costPerTask: 'nope',
          latencyMsTtfa: null,
          source: 'fixture',
        },
      ],
    });
    const loaded = loadStore(tmpDir);
    expect(loaded?.models[0]).toMatchObject({
      effort: 'high',
      costPerTask: 0.42,
      latencyMsTtfa: 1234,
    });
    expect(loaded?.models[1]?.effort).toBeUndefined();
    expect(loaded?.models[1]?.costPerTask).toBeUndefined();
    expect(loaded?.models[1]?.latencyMsTtfa).toBeUndefined();
  });

  it('keeps one measured row whole instead of mixing axes of different AA models', () => {
    // A preview (estimated) and its release resolve to one registry model.
    const rows = [
      {
        registryId: 'a/hy3', active: true, benchSlug: 'hy3-preview', qualityEstimated: true,
        quality: { intelligence: 22.7, coding: 58.8, agenticCoding: 24.1, knowledge: -35 },
        priceInputPer1M: 1, source: 'aa',
      },
      {
        registryId: 'a/hy3', active: true, benchSlug: 'hy3',
        quality: { intelligence: 25.3, knowledge: -18.5, research: 0.27 },
        priceInputPer1M: 2, source: 'aa',
      },
    ] as any;
    const merged = mergeBenchRows(rows);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ benchSlug: 'hy3', priceInputPer1M: 2 });
    expect(merged[0].quality).toEqual({ intelligence: 25.3, knowledge: -18.5, research: 0.27 });
    expect(merged[0].qualityEstimated).toBeUndefined();
  });

  it('routes only from synced data that includes models-page measurements', () => {
    const row = { registryId: 'a/b', active: true, benchSlug: 'b', source: 'aa' } as const;
    const store = (models: unknown[], syncedAt = 1) => ({ version: 2 as const, syncedAt, aliases: {}, models }) as any;
    expect(checkBenchmarkStore(undefined)).toMatchObject({ ready: false, message: expect.stringMatching(/no benchmark data.*\/router-sync/) });
    expect(checkBenchmarkStore(store([{ ...row, quality: { intelligence: 40 } }], 0)).ready).toBe(false);
    expect(checkBenchmarkStore(store([{ ...row, active: false, quality: { research: 0.4 } }])).ready).toBe(false);
    // API-only data has no Briefcase or LCR measurement.
    expect(checkBenchmarkStore(store([{ ...row, quality: { intelligence: 40, knowledge: 10 } }])))
      .toMatchObject({ ready: false, message: expect.stringMatching(/models-page/) });
    expect(checkBenchmarkStore(store([{ ...row, quality: { intelligence: 40, longContext: 0.5 } }]))).toEqual({ ready: true });
  });

  it('preserves unresolved rows after merge', () => {
    const rows = [
      { registryId: 'a/b', active: true, benchSlug: 'x', quality: {}, source: 'aa' },
      { registryId: '', active: false, benchSlug: 'unknown', quality: {}, source: 'aa' },
    ] as any;
    const merged = mergeBenchRows(rows);
    expect(merged).toHaveLength(2);
    expect(merged.some((m) => m.active)).toBe(true);
    expect(merged.some((m) => !m.active)).toBe(true);
  });

  it('drops malformed aliases and benchmark rows', () => {
    writeJsonAtomic(join(tmpDir, 'benchmarks.json'), {
      version: 2,
      syncedAt: 123,
      aliases: { good: 'alpha/model', bad: {}, empty: '' },
      models: [
        {
          registryId: 'alpha/model',
          benchSlug: 'alpha-model',
          active: true,
          quality: { intelligence: 80, coding: null },
          source: 'fixture',
        },
        { registryId: 7, benchSlug: 'bad', active: true, quality: {}, source: 'fixture' },
      ],
    });

    expect(loadStore(tmpDir)).toEqual({
      version: 2,
      syncedAt: 123,
      aliases: { ...DEFAULT_BENCHMARK_ALIASES, good: 'alpha/model' },
      models: [{
        registryId: 'alpha/model',
        benchSlug: 'alpha-model',
        active: true,
        quality: { intelligence: 80 },
        source: 'fixture',
      }],
    });
  });

  it('adds alias immutably', () => {
    const store = emptyStore();
    const next = addAlias(store, 'slug', 'provider/id');
    expect(next.aliases).toEqual({ ...DEFAULT_BENCHMARK_ALIASES, slug: 'provider/id' });
    expect(store.aliases).toEqual(DEFAULT_BENCHMARK_ALIASES);
  });
});
