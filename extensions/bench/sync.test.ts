import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

import { syncBenchmarks, syncSummary } from './sync.js';
import { indexVersionWarning } from '../routing/score/scorer.js';
import { loadStore, saveStore, emptyStore } from './store.js';
import * as aa from '../adapters/artificial-analysis.js';
import type { ExtensionContext } from '../types.js';

describe('syncBenchmarks', () => {
  let tmpDir: string;
  let fakeCtx: ExtensionContext;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pi8-'));
    // Ensure tmpDir is passed through to the sync environment so
    // test fixtures do not overwrite user storage.
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

  it('reports a clear error when no API key is configured', async () => {
    vi.stubEnv('ARTIFICIAL_ANALYSIS_API_KEY', '');
    const results = await syncBenchmarks(fakeCtx);
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toMatch(/artificialanalysis/i);
  });

  it('stores the joined API and page rows', async () => {
    vi.spyOn(aa, 'fetchAndNormalize').mockResolvedValue([
      {
        benchSlug: 'claude-opus-4-6',
        effort: 'max',
        quality: { intelligence: 52, knowledge: 30, research: 0.5 },
        qualityEstimated: true,
        timePerTaskSeconds: 120,
        source: 'artificial-analysis',
      },
    ]);
    const results = await syncBenchmarks(fakeCtx, { apiKey: 'key' });
    expect(results).toEqual([
      expect.objectContaining({ source: 'artificial-analysis', ok: true, matched: 1 }),
    ]);
    const [row] = loadStore()!.models;
    expect(row).toMatchObject({
      registryId: 'anthropic/claude-opus-4-6-20260115',
      quality: { intelligence: 52, knowledge: 30, research: 0.5 },
      qualityEstimated: true,
      timePerTaskSeconds: 120,
    });
  });

  it('saves an uncalibrated index version and only warns', async () => {
    const row = {
      benchSlug: 'claude-opus-4-6', effort: 'max' as const, source: 'artificial-analysis',
      quality: { intelligence: 52, knowledge: 30, research: 0.5 },
    };
    vi.spyOn(aa, 'fetchAndNormalize').mockResolvedValue(Object.assign([row], { indexVersion: '4.4' }));
    const results = await syncBenchmarks(fakeCtx, { apiKey: 'key' });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: true, matched: 1, warning: expect.stringMatching(/version 4\.4.*calibrated for version 4\.3/) });
    expect(results[0].error).toBeUndefined();
    expect(loadStore()).toMatchObject({ indexVersion: '4.4', models: [expect.objectContaining({ benchSlug: 'claude-opus-4-6' })] });
    expect(syncSummary(results)).toContain('Warning: ');
  });

  it('accepts the calibrated index version, including patch releases', () => {
    expect(indexVersionWarning('4.3')).toBeUndefined();
    expect(indexVersionWarning('v4.3.1')).toBeUndefined();
    expect(indexVersionWarning('4.4')).toMatch(/version 4\.4/);
    expect(indexVersionWarning(undefined)).toMatch(/not reported/);
  });

  it('keeps the previous store when the fetch fails', async () => {
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
      ],
    };
    saveStore(previousStore);
    vi.spyOn(aa, 'fetchAndNormalize').mockRejectedValue(new Error('Chromium for Playwright is not installed'));

    const results = await syncBenchmarks(fakeCtx, { apiKey: 'key' });

    expect(results[0]).toMatchObject({ source: 'artificial-analysis', ok: false, error: expect.stringMatching(/Chromium/) });
    expect(results[1]).toMatchObject({ source: 'store', ok: false, error: expect.stringMatching(/keeping the previous 1/) });
    expect(loadStore()).toEqual(previousStore);
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
    vi.spyOn(aa, 'fetchAndNormalize').mockResolvedValue([
      { benchSlug: 'no-such-model-anywhere', quality: { intelligence: 99 }, source: 'artificial-analysis' },
    ]);

    const results = await syncBenchmarks(fakeCtx, { apiKey: 'key' });

    expect(results[0]).toMatchObject({ source: 'artificial-analysis', ok: true, matched: 0 });
    expect(results[1]).toMatchObject({ source: 'store', ok: false, error: expect.stringMatching(/matched 0 registry models/i) });
    expect(loadStore()).toEqual(previousStore);
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
