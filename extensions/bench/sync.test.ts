import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { syncBenchmarks, syncSummary } from './sync.js';
import { loadStore, saveStore, emptyStore } from './store.js';
import * as adapters from '../adapters/index.js';
import type { ExtensionContext } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('syncBenchmarks', () => {
  let tmpDir: string;
  let fakeCtx: ExtensionContext;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pi8-'));
    // Regression: this suite used to create tmpDir and then never use it, so
    // every `vitest run` overwrote the developer's real benchmark store with
    // mocked fixtures.
    vi.stubEnv('PI8_DIR', tmpDir);
    fakeCtx = {
      modelRegistry: {
        getAvailable: () => [
          { provider: 'anthropic', id: 'claude-opus-4-6-20260115' },
          { provider: 'deepseek', id: 'deepseek-chat-v3' },
        ],
      },
    } as unknown as ExtensionContext;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('never writes to the real user storage directory', () => {
    expect(process.env.PI8_DIR).toBe(tmpDir);
    expect(join(homedir(), '.pi/agent/pi8')).not.toBe(tmpDir);
  });

  it('reports a clear error when no source is usable', async () => {
    // AA needs a key and the request excludes the keyless benchlm source.
    const results = await syncBenchmarks(fakeCtx, { sources: ['artificial-analysis'] });
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toMatch(/artificialanalysis/i);
  });

  it('syncs the keyless benchlm source into the store', async () => {
    const fixtureHtml = readFileSync(join(__dirname, '../__fixtures__/benchlm-aaomniscience.html'), 'utf8');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(fixtureHtml, { status: 200 })));
    const ctx = {
      modelRegistry: {
        getAvailable: () => [
          { provider: 'claude-bridge', id: 'claude-fable-5' },
          { provider: 'github-copilot', id: 'claude-fable-5' },
          { provider: 'opencode', id: 'claude-fable-5' },
        ],
      },
    } as unknown as ExtensionContext;

    const results = await syncBenchmarks(ctx, { sources: ['benchlm'] });
    expect(results[0]).toMatchObject({ source: 'benchlm', ok: true, matched: 3 });
    const store = loadStore();
    const fable = store?.models.filter((m) => m.benchSlug === 'claude-fable');
    expect(fable?.map((m) => m.registryId).sort()).toEqual([
      'claude-bridge/claude-fable-5',
      'github-copilot/claude-fable-5',
      'opencode/claude-fable-5',
    ]);
    expect(fable?.every((m) => m.active && m.quality.knowledge === 40.2)).toBe(true);
    expect(store?.syncedAt).toBeGreaterThan(0);
  });

  it('preserves the previous store when a selected adapter fails', async () => {
    const previousStore = {
      ...emptyStore(),
      syncedAt: Date.now(),
      models: [
        {
          registryId: 'anthropic/claude-opus-4-6-20260115',
          benchSlug: 'previous-1',
          active: true,
          quality: { intelligence: 90 },
          source: 'previous',
        },
        {
          registryId: 'deepseek/deepseek-chat-v3',
          benchSlug: 'previous-2',
          active: true,
          quality: { intelligence: 85 },
          source: 'previous',
        },
      ],
    };
    saveStore(previousStore);

    const getEnabledAdaptersSpy = vi.spyOn(adapters, 'getEnabledAdapters').mockReturnValue([
      {
        name: 'successful' as any,
        isAvailable: () => true,
        fetch: async () => [
          { benchSlug: 'claude-opus-4-6', quality: { intelligence: 92 }, source: 'successful' },
        ],
      },
      {
        name: 'failed' as any,
        isAvailable: () => true,
        fetch: async () => {
          throw new Error('adapter outage');
        },
      },
    ]);

    const results = await syncBenchmarks(fakeCtx, { sources: ['successful', 'failed'] as any });

    expect(results[0]).toMatchObject({ source: 'successful', ok: true });
    expect(results[1]).toMatchObject({ source: 'failed', ok: false });
    expect(results[2].source).toBe('store');
    expect(results[2].ok).toBe(false);
    expect(results[2].error).toMatch(/keeping (the )?previous/i);
    expect(loadStore()).toEqual(previousStore);

    getEnabledAdaptersSpy.mockRestore();
  });

  it('keeps existing data when a sync matches nothing', async () => {
    const previousStore = {
      ...emptyStore(),
      syncedAt: Date.now(),
      models: [
        {
          registryId: 'anthropic/claude-opus-4-6-20260115',
          benchSlug: 'keep-me',
          active: true,
          quality: { intelligence: 90 },
          source: 'previous',
        },
      ],
    };
    saveStore(previousStore);

    // Every adapter succeeds, so the partial-sync branch is skipped: this
    // exercises the zero-match guard specifically.
    const spy = vi.spyOn(adapters, 'getEnabledAdapters').mockReturnValue([
      {
        name: 'unmatchable' as any,
        isAvailable: () => true,
        fetch: async () => [
          { benchSlug: 'no-such-model-anywhere', quality: { intelligence: 99 }, source: 'unmatchable' },
        ],
      },
    ]);

    const results = await syncBenchmarks(fakeCtx, { sources: ['unmatchable'] as any });

    expect(results[0]).toMatchObject({ source: 'unmatchable', ok: true, matched: 0 });
    expect(results[1].source).toBe('store');
    expect(results[1].ok).toBe(false);
    expect(results[1].error).toMatch(/matched 0 registry models/i);
    expect(loadStore()).toEqual(previousStore);

    spy.mockRestore();
  });

  it('summary renders each result', () => {
    const results = [
      { source: 'aa', ok: true, fetched: 10, matched: 3, unresolved: 7 },
      { source: 'lb', ok: false, fetched: 0, matched: 0, unresolved: 0, error: 'timeout' },
    ];
    const text = syncSummary(results as any);
    expect(text).toContain('aa: ok, fetched 10');
    expect(text).toContain('timeout');
  });
});
