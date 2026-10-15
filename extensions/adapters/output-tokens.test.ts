import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { parseSiteIndexVersion, parseSiteModels, type AASiteModel } from './artificial-analysis-site.js';
import { normalize } from './artificial-analysis.js';
import { compareMergeRows, loadStore, mergeActiveBenchRows, saveStore, selectMergeRow } from '../bench/store.js';
import { rowAtServedEffort } from '../routing/features/model.js';
import type { BenchModel } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(__dirname, '../../fixtures/aa-site-output-tokens.json'), 'utf8')) as {
  versionLabels: string[];
  rows: Record<string, unknown>[];
};
const recorded = JSON.parse(readFileSync(join(__dirname, '../../fixtures/aa-site-sample.json'), 'utf8')) as Record<string, unknown>[];

/** The page parser needs a full-size payload; the recorded sample supplies it. */
const parseWith = (rows: Record<string, unknown>[]): AASiteModel[] => {
  const slugs = new Set(rows.map((row) => row.slug));
  return parseSiteModels([...recorded.filter((row) => !slugs.has(row.slug)), ...rows]);
};
const site = (slug: string, extra: Partial<AASiteModel> = {}): AASiteModel => ({ slug, name: slug, ...extra });

describe('AA output tokens per task: website field', () => {
  it('reads intelligenceIndexOutputTokensPerTask.output exactly, without rounding', () => {
    const rows = parseWith(fixture.rows);
    expect(rows.find((row) => row.slug === 'gemini-3-5-flash')?.outputTokensPerTask).toBe(54642.77172835717);
    expect(rows.find((row) => row.slug === 'gpt-6-sol-low')?.outputTokensPerTask).toBe(3372.836305754137);
    const absent = rows.find((row) => row.slug === 'glm-4-5v');
    expect(absent?.outputTokensPerTask).toBeUndefined();
    expect(absent?.outputTokensInvalid).toBeUndefined();
  });

  it('keeps zero and marks malformed values invalid instead of coercing them', () => {
    const cases: [unknown, number | undefined, boolean][] = [
      [{ output: 0 }, 0, false],
      [{ output: '1200' }, undefined, true],
      [{ output: -1 }, undefined, true],
      [{ output: Infinity }, undefined, true],
      [{ output: null }, undefined, true],
      [{ answer: 10, reasoning: 5 }, undefined, true],
      [1200, undefined, true],
      [null, undefined, false],
    ];
    for (const [value, expected, invalid] of cases) {
      const row = parseWith([{ slug: 'probe', name: 'Probe (high)', intelligenceIndexOutputTokensPerTask: value }])
        .find((parsed) => parsed.slug === 'probe');
      expect(row?.outputTokensPerTask, JSON.stringify(value)).toBe(expected);
      expect(row?.outputTokensInvalid === true, JSON.stringify(value)).toBe(invalid);
    }
  });

  it('a malformed token value does not fail an otherwise valid page parse', () => {
    expect(() => parseWith(recorded.map((row) => ({ ...row, intelligenceIndexOutputTokensPerTask: 'x' })))).not.toThrow();
  });

  it('reads one index version from page labels and rejects absent or conflicting labels', () => {
    expect(parseSiteIndexVersion(fixture.versionLabels)).toBe('4.3.2');
    expect(parseSiteIndexVersion([])).toBeUndefined();
    expect(parseSiteIndexVersion(['Intelligence Index v4.3.2', 'Intelligence Index v4.4'])).toBeUndefined();
    expect(parseSiteIndexVersion(['Terminal-Bench v2.0'])).toBeUndefined();
  });
});

describe('AA output tokens per task: join to API rows', () => {
  const api = (slug: string, name: string) => ({ slug, name, evaluations: { artificial_analysis_intelligence_index: 50 } });

  it('attaches the observation at the explicit effort with the page index version', () => {
    const [row] = normalize([api('m', 'M (high)')], [site('m', { name: 'M (high)', intelligenceIndexIsEstimated: false, outputTokensPerTask: 42 })], '4.3.2');
    expect(row?.outputTokensPerTask).toBe(42);
    expect(row?.outputTokensProvenance).toEqual({ status: 'measured', indexVersion: '4.3.2' });
  });

  it('does not borrow an observation from another effort', () => {
    const [row] = normalize([api('m', 'M (low)')], [site('m', { name: 'M (high)', intelligenceIndexIsEstimated: false, outputTokensPerTask: 42 })]);
    expect(row?.outputTokensPerTask).toBeUndefined();
    expect(row?.outputTokensProvenance).toBeUndefined();
  });

  it('labels an observation without a parsed effort as unknown-effort, not off', () => {
    const [bare] = normalize([api('m', 'M (Reasoning)')], [site('m', { name: 'M (Reasoning)', intelligenceIndexIsEstimated: false, outputTokensPerTask: 7 })]);
    expect(bare?.effort).toBeUndefined();
    expect(bare?.outputTokensProvenance?.status).toBe('unknown-effort');
  });

  it('labels estimated or unflagged index rows source-estimated', () => {
    for (const flag of [true, undefined]) {
      const [row] = normalize([api('m', 'M (high)')], [site('m', { name: 'M (high)', intelligenceIndexIsEstimated: flag, outputTokensPerTask: 7 })]);
      expect(row?.outputTokensProvenance?.status).toBe('source-estimated');
    }
  });

  it('marks conflicting duplicate observations, in either input order', () => {
    const a = site('m', { name: 'M (high)', intelligenceIndexIsEstimated: false, outputTokensPerTask: 10 });
    const b = site('m', { name: 'M (high)', intelligenceIndexIsEstimated: false, outputTokensPerTask: 20 });
    const invalid = site('m', { name: 'M (high)', outputTokensInvalid: true });
    for (const pages of [[a, b], [b, a], [a, invalid], [invalid, a]]) {
      const [row] = normalize([api('m', 'M (high)')], pages);
      expect(row?.outputTokensPerTask).toBeUndefined();
      expect(row?.outputTokensProvenance?.status).toBe('conflict');
    }
    const [same] = normalize([api('m', 'M (high)')], [a, { ...a }]);
    expect(same?.outputTokensPerTask).toBe(10);
  });

  it('keeps an invalid observation distinguishable from an absent one', () => {
    const [row] = normalize([api('m', 'M (high)')], [site('m', { name: 'M (high)', outputTokensInvalid: true })]);
    expect(row?.outputTokensPerTask).toBeUndefined();
    expect(row?.outputTokensProvenance?.status).toBe('invalid');
  });
});

describe('AA output tokens per task: storage and row selection', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pi8-tokens-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const bench = (extra: Partial<BenchModel>): BenchModel => ({
    registryId: 'p/m', benchSlug: 'm', active: true, source: 'artificial-analysis',
    quality: { intelligence: 50 }, axisProvenance: { intelligence: 'measured' }, effort: 'high', ...extra,
  });

  it('round-trips the value and provenance, and drops malformed stored values', () => {
    const kept = bench({ outputTokensPerTask: 0, outputTokensProvenance: { status: 'measured', indexVersion: '4.3.2' } });
    const malformed = { ...bench({ benchSlug: 'n' }), outputTokensPerTask: -5, outputTokensProvenance: { status: 'guess' } };
    saveStore({ version: 2, syncedAt: 1, models: [kept, malformed as never], aliases: {} }, dir);
    const [a, b] = loadStore(dir)!.models;
    expect(a?.outputTokensPerTask).toBe(0);
    expect(a?.outputTokensProvenance).toEqual({ status: 'measured', indexVersion: '4.3.2' });
    expect(b?.outputTokensPerTask).toBeUndefined();
    expect(b?.outputTokensProvenance).toBeUndefined();
  });

  it('loads a store written before output tokens existed', () => {
    saveStore({ version: 2, syncedAt: 1, models: [bench({})], aliases: {} }, dir);
    expect(loadStore(dir)!.models[0]?.outputTokensPerTask).toBeUndefined();
  });

  it('token values never change which quality row is selected, in either input order', () => {
    // Tied on provenance counts and source identity. Without tokens, the
    // canonical row text selects `legacy` (intelligence 40 < 60 as text).
    const legacy = bench({ quality: { intelligence: 40 }, outputTokensPerTask: 900 });
    const other = bench({ quality: { intelligence: 60 }, outputTokensPerTask: 1 });
    expect(compareMergeRows(legacy, other)).toBeLessThan(0);
    for (const rows of [[legacy, other], [other, legacy]]) {
      expect(mergeActiveBenchRows(rows)[0]?.quality.intelligence).toBe(40);
      expect(rowAtServedEffort(rows, { registryId: 'p/m', effort: 'high' } as never)?.quality.intelligence).toBe(40);
    }
  });

  it('equal quality rows with different token observations give a conflict, in either order', () => {
    const a = bench({ outputTokensPerTask: 10, outputTokensProvenance: { status: 'measured' } });
    const b = bench({ outputTokensPerTask: 20, outputTokensProvenance: { status: 'measured' } });
    for (const rows of [[a, b], [b, a]]) {
      const kept = selectMergeRow(rows);
      expect(kept?.outputTokensPerTask).toBeUndefined();
      expect(kept?.outputTokensProvenance?.status).toBe('conflict');
      expect(rowAtServedEffort(rows, { registryId: 'p/m', effort: 'high' } as never)?.outputTokensProvenance?.status).toBe('conflict');
    }
    expect(selectMergeRow([a, { ...a }])?.outputTokensPerTask).toBe(10);
  });
});
