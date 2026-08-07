import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { AA_FETCH_TIMEOUT_MS, fetchRaw, normalize, unwrap } from './artificial-analysis.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = join(__dirname, '../__fixtures__/aa-sample.json');
const payload = JSON.parse(readFileSync(fixture, 'utf8'));

describe('artificial-analysis adapter', () => {
  it('attaches a finite timeout to API requests', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify({ data: [{ slug: 'model' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      await fetchRaw({ apiKey: 'test-key', endpoint: 'https://example.test/models' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(AA_FETCH_TIMEOUT_MS).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  describe('unwrap', () => {
    // Regression: the v2 API returns an envelope, and the adapter used to
    // throw "Unexpected response shape" on every real sync.
    it('unwraps the v2 { pagination, data } envelope', () => {
      const { rows, pagination } = unwrap(payload);
      expect(rows).toHaveLength(7);
      expect(pagination?.page).toBe(1);
    });

    it('still accepts a bare array', () => {
      expect(unwrap([{ slug: 'x' }]).rows).toHaveLength(1);
    });

    it('throws on a genuinely unknown shape', () => {
      expect(() => unwrap({ nope: true })).toThrow(/Unexpected Artificial Analysis response shape/);
    });
  });

  describe('normalize', () => {
    const rows = normalize(unwrap(payload).rows);

    it('reads metrics out of the nested evaluations/pricing/performance objects', () => {
      const flash = rows.find((r) => r.benchSlug === 'gemini-3-5-flash');
      expect(flash).toBeDefined();
      expect(flash?.quality.intelligence).toBe(50.2);
      expect(flash?.quality.coding).toBe(70.1);
      expect(flash?.quality.agenticCoding).toBe(37.4);
      expect(flash?.priceInputPer1M).toBe(1.5);
      expect(flash?.priceOutputPer1M).toBe(9);
      expect(flash?.outputSpeedTps).toBe(171.52);
    });

    it('converts time-to-first-token from seconds to ms', () => {
      const flash = rows.find((r) => r.benchSlug === 'gemini-3-5-flash');
      expect(flash?.latencyMsTtft).toBeCloseTo(22420, 0);
    });

    // The effort parse is pinned against the six observed AA name formats
    // plus one unrecognized label, which must fail closed (undefined).
    it.each([
      ['GPT-5.6 Luna (low)', 'low'],
      ['GPT-5.6 Luna (high)', 'high'],
      ['GPT-5.6 Terra (max)', 'max'],
      ['Claude Opus 5 (Adaptive Reasoning, Xhigh Effort)', 'xhigh'],
      ['Claude Opus 5 (Adaptive Reasoning, Medium Effort)', 'medium'],
      ['DeepSeek V4 Flash (Non-reasoning)', 'off'],
      // L2: non-reasoning as last segment of a multi-part label
      ['Claude Haiku 4 (Adaptive Reasoning, Non-reasoning)', 'off'],
    ] as const)('parses effort label %s → %s', (name, effort) => {
      const [row] = normalize([{ slug: 'x', name }]);
      expect(row?.effort).toBe(effort);
    });

    it('leaves unrecognized effort labels undefined rather than guessing', () => {
      const [noParens] = normalize([{ slug: 'x', name: 'JT-35B-Flash' }]);
      expect(noParens?.effort).toBeUndefined();
      const [nonEffort] = normalize([{ slug: 'x', name: 'Foo (OpenAI)' }]);
      expect(nonEffort?.effort).toBeUndefined();
      const [adaptiveOnly] = normalize([{ slug: 'x', name: 'Foo (Adaptive Reasoning)' }]);
      expect(adaptiveOnly?.effort).toBeUndefined();
    });

    it('reads costPerTask out of the intelligence-index-cost block', () => {
      const lunaLow = rows.find((r) => r.benchSlug === 'gpt-5-6-luna-low');
      expect(lunaLow?.costPerTask).toBeCloseTo(0.0088, 4);
      const lunaMax = rows.find((r) => r.benchSlug === 'gpt-5-6-luna');
      expect(lunaMax?.costPerTask).toBeCloseTo(0.0473, 4);
    });

    it('leaves costPerTask undefined when the block is absent or null', () => {
      const glm = rows.find((r) => r.benchSlug === 'glm-4-5v');
      expect(glm?.costPerTask).toBeUndefined();
      const jt = rows.find((r) => r.benchSlug === 'jt-35b-flash');
      expect(jt?.costPerTask).toBeUndefined();
    });

    it('keeps time-to-first-answer distinct from time-to-first-token on a reasoning row', () => {
      const pro = rows.find((r) => r.benchSlug === 'deepseek-v4-pro');
      expect(pro?.latencyMsTtft).toBeCloseTo(1600, 0);
      expect(pro?.latencyMsTtfa).toBeCloseTo(71250, 0);
      expect(pro?.latencyMsTtfa).not.toBe(pro?.latencyMsTtft);
    });

    it('parses the multi-effort luna family into distinct rows', () => {
      const lunaRows = rows.filter((r) => r.benchSlug.startsWith('gpt-5-6-luna'));
      expect(lunaRows.map((r) => r.effort).sort()).toEqual(['high', 'low', 'max']);
    });

    it('leaves absent indices undefined rather than coercing them to 0', () => {
      const partial = rows.find((r) => r.benchSlug === 'glm-4-5v');
      expect(partial?.quality.intelligence).toBe(7);
      expect(partial?.quality.coding).toBeUndefined();
      expect(partial?.quality.agenticCoding).toBeUndefined();
    });

    it('survives rows missing the nested objects entirely', () => {
      const out = normalize([{ slug: 'bare' }]);
      expect(out).toHaveLength(1);
      expect(out[0].quality.intelligence).toBeUndefined();
      expect(out[0].priceInputPer1M).toBeUndefined();
    });

    it('ignores rows with no usable identifier', () => {
      expect(normalize([{ id: '', name: '' }])).toHaveLength(0);
    });

    it.each([{ slug: {} }, { id: 42 }, { name: [] }])(
      'ignores a row with non-string identifiers: %j',
      (row) => expect(normalize([row as never])).toEqual([]),
    );
  });
});
