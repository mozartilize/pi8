import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isEmbeddingAvailable,
  getEmbeddingError,
  embedAndClassify,
  ensureEmbeddingEngine,
  resetEmbeddingEngine,
  setEmbeddingTestOverrides,
} from './embedding.js';
import type { Dimension } from '../types.js';

// ─── Fake engine dependencies ─────────────────────────────────────────
// The fake maps text → a one-hot 384-dim vector whose band is chosen by the
// first marker found (greeting→lightweight, find→gather, plan→plan,
// write→implement, review→review). The real prototype texts each hit their
// own marker, so classification is exact while the full tokenize → tensor →
// run → mean-pool → L2-normalize → cosine pipeline runs for real.

const MARKERS: Array<[string, Dimension]> = [
  ['greeting', 'lightweight'],
  ['find', 'gather'],
  ['plan', 'plan'],
  ['write', 'implement'],
  ['review', 'review'],
];

const DIM_INDEX: Record<Dimension, number> = {
  lightweight: 0,
  gather: 1,
  plan: 2,
  implement: 3,
  review: 4,
};

const HIDDEN = 384;
const SEQ_LEN = 8;

function makeFakeDeps(opts: {
  hangCreate?: boolean;
  hangRunAfter?: number;
  failRunAfter?: number;
  /** ONNX graph input names — exercises the inputNames guard. */
  inputNames?: string[];
  /** If set, the session records every feeds object passed to run(). */
  captureFeeds?: boolean;
} = {}) {
  const {
    hangCreate = false,
    hangRunAfter,
    failRunAfter,
    inputNames = ['input_ids', 'attention_mask', 'token_type_ids'],
    captureFeeds = false,
  } = opts;
  let runCalls = 0;
  const feedsLog: Array<Record<string, unknown>> = [];

  class FakeTensor {
    constructor(
      readonly type: string,
      readonly data: BigInt64Array,
      readonly dims: number[],
    ) {}
  }

  const session = {
    outputNames: ['last_hidden_state'],
    inputNames,
    async run(feeds: Record<string, unknown>) {
      runCalls += 1;
      if (captureFeeds) feedsLog.push(feeds);
      if (hangRunAfter !== undefined && runCalls > hangRunAfter) {
        return new Promise<never>(() => {});
      }
      if (failRunAfter !== undefined && runCalls > failRunAfter) {
        throw new Error('fake inference failure');
      }
      const input = feeds.input_ids as FakeTensor;
      const band = Number(input.data[0]);
      const seqLen = input.dims[1];
      const data = new Float32Array(seqLen * HIDDEN);
      for (let t = 0; t < seqLen; t++) data[t * HIDDEN + band] = 1;
      return { last_hidden_state: { data, dims: [1, seqLen, HIDDEN] } };
    },
  };

  const deps = {
    ort: {
      Tensor: FakeTensor,
      InferenceSession: {
        create: async (path: string) => {
          if (!hangCreate) deps._createPaths.push(path);
          return hangCreate ? new Promise<never>(() => {}) : session;
        },
      },
    },
    tokenizer: (text: string) => {
      const lower = text.toLowerCase();
      const marker = MARKERS.find(([m]) => lower.includes(m));
      const band = marker ? DIM_INDEX[marker[1]] : 0;
      const inputIds = new BigInt64Array(SEQ_LEN);
      inputIds[0] = BigInt(band);
      const mask = new BigInt64Array(SEQ_LEN).fill(1n);
      mask[SEQ_LEN - 1] = 0n; // one padding token — exercises the mask path
      return {
        input_ids: { data: inputIds, dims: [1, SEQ_LEN] },
        attention_mask: { data: mask, dims: [1, SEQ_LEN] },
      };
    },
    // Test observability: model path passed to create(), feeds passed to run().
    _createPaths: [] as string[],
    _feedsLog: feedsLog,
  };
  return deps;
}

describe('embedding engine', () => {
  beforeEach(() => {
    resetEmbeddingEngine();
    setEmbeddingTestOverrides(undefined);
  });

  // ─── Fresh state ────────────────────────────────────────────────

  it('is not available before loading', () => {
    expect(isEmbeddingAvailable()).toBe(false);
  });

  it('has no error before any load attempt', () => {
    expect(getEmbeddingError()).toBeUndefined();
  });

  it('returns undefined from embedAndClassify when not loaded', async () => {
    // No fake deps: the real dynamic import fails fast in this environment,
    // so the engine reports unavailable rather than throwing (R2).
    const result = await embedAndClassify('hello', { deadlineMs: 500 });
    expect(result).toBeUndefined();
    expect(isEmbeddingAvailable()).toBe(false);
  });

  // ─── Degrade paths ─────────────────────────────────────────────

  it('ensureEmbeddingEngine fails when deps or model are missing', async () => {
    // Deterministic in any environment: without fake overrides the engine
    // cannot load — either the native packages are not installed (fast
    // import failure) or the model file is absent from the store (fast
    // existence check). Either way the degrade contract holds.
    const storeDir = mkdtempSync(join(tmpdir(), 'pi8-embed-store-'));
    try {
      process.env.PI8_DIR = storeDir;
      const ok = await ensureEmbeddingEngine({ deadlineMs: 500 });
      expect(ok).toBe(false);
      expect(isEmbeddingAvailable()).toBe(false);
      expect(getEmbeddingError()).toBeTruthy();
    } finally {
      delete process.env.PI8_DIR;
      rmSync(storeDir, { recursive: true, force: true });
    }
  });

  it('ensureEmbeddingEngine times out when session create hangs', async () => {
    setEmbeddingTestOverrides(makeFakeDeps({ hangCreate: true }));
    const started = Date.now();
    const ok = await ensureEmbeddingEngine({ deadlineMs: 80 });
    expect(ok).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
    expect(isEmbeddingAvailable()).toBe(false);
  });

  it('embedAndClassify times out when inference hangs', async () => {
    // The 5 prototype embeds succeed during init; the 6th run (the query)
    // hangs, so the call must degrade within the deadline (R5: a silent
    // hang is not a thrown error — it must not block the turn).
    setEmbeddingTestOverrides(makeFakeDeps({ hangRunAfter: 5 }));
    expect(await ensureEmbeddingEngine({ deadlineMs: 1000 })).toBe(true);
    const started = Date.now();
    const result = await embedAndClassify('please write a script', { deadlineMs: 80 });
    expect(result).toBeUndefined();
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
  });

  it('embedAndClassify degrades when inference throws', async () => {
    setEmbeddingTestOverrides(makeFakeDeps({ failRunAfter: 5 }));
    expect(await ensureEmbeddingEngine({ deadlineMs: 1000 })).toBe(true);
    const result = await embedAndClassify('please write a script', { deadlineMs: 500 });
    expect(result).toBeUndefined();
    // The engine itself stays loaded — only this inference failed.
    expect(isEmbeddingAvailable()).toBe(true);
  });

  // ─── Success path (fake deps) ──────────────────────────────────

  it('loads the engine end to end (init → prototypes → ready)', async () => {
    setEmbeddingTestOverrides(makeFakeDeps());
    const ok = await ensureEmbeddingEngine({ deadlineMs: 1000 });
    expect(ok).toBe(true);
    expect(isEmbeddingAvailable()).toBe(true);
    expect(getEmbeddingError()).toBeUndefined();
  });

  it('classifies query text into the marker-matched dimension', async () => {
    setEmbeddingTestOverrides(makeFakeDeps());
    await ensureEmbeddingEngine({ deadlineMs: 1000 });
    const cases: Array<[string, Dimension]> = [
      ['please write a small script', 'implement'],
      ['review this pull request', 'review'],
      ['find where the bug is', 'gather'],
      ['plan the migration', 'plan'],
      ['hi', 'lightweight'],
    ];
    for (const [text, dim] of cases) {
      const result = await embedAndClassify(text, { deadlineMs: 1000 });
      expect(result?.dimension).toBe(dim);
      expect(result?.confidence).toBeGreaterThan(0.99);
    }
  });

  it('ensureEmbeddingEngine is idempotent', async () => {
    setEmbeddingTestOverrides(makeFakeDeps());
    const first = await ensureEmbeddingEngine({ deadlineMs: 1000 });
    const second = await ensureEmbeddingEngine({ deadlineMs: 1000 });
    expect(first).toBe(true);
    expect(second).toBe(true);
  });

  it('resetEmbeddingEngine clears loaded state', async () => {
    setEmbeddingTestOverrides(makeFakeDeps());
    await ensureEmbeddingEngine({ deadlineMs: 1000 });
    expect(isEmbeddingAvailable()).toBe(true);
    resetEmbeddingEngine();
    expect(isEmbeddingAvailable()).toBe(false);
    expect(getEmbeddingError()).toBeUndefined();
  });

  // ─── ONNX input guard ────────────────────────────────────────

  it('feeds only the ONNX inputs the graph declares', async () => {
    // Real E5-small exports declare all three today, but an XLM-R based
    // export (no token_type_ids) must degrade, not throw on an unknown
    // input name.
    const deps = makeFakeDeps({
      inputNames: ['input_ids', 'attention_mask'],
      captureFeeds: true,
    });
    setEmbeddingTestOverrides(deps);
    expect(await ensureEmbeddingEngine({ deadlineMs: 1000 })).toBe(true);
    const result = await embedAndClassify('review this pull request', { deadlineMs: 1000 });
    expect(result?.dimension).toBe('review');
    // 5 prototype embeds + 1 query run — none may feed an undeclared input.
    expect(deps._feedsLog.length).toBe(6);
    for (const feeds of deps._feedsLog) {
      expect(feeds.input_ids).toBeDefined();
      expect(feeds.attention_mask).toBeDefined();
      expect(feeds.token_type_ids).toBeUndefined();
    }
  });

  it('feeds token_type_ids when the graph declares it', async () => {
    const deps = makeFakeDeps({ captureFeeds: true });
    setEmbeddingTestOverrides(deps);
    expect(await ensureEmbeddingEngine({ deadlineMs: 1000 })).toBe(true);
    await embedAndClassify('hello', { deadlineMs: 1000 });
    for (const feeds of deps._feedsLog) {
      expect(feeds.token_type_ids).toBeDefined();
    }
  });

  // ─── Provisioned model path ──────────────────────────────────

  it('loads the ONNX model from the provisioned store path by default', async () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'pi8-embed-path-'));
    try {
      process.env.PI8_DIR = storeDir;
      const deps = makeFakeDeps();
      setEmbeddingTestOverrides(deps);
      expect(await ensureEmbeddingEngine({ deadlineMs: 1000 })).toBe(true);
      // transformers.js layout: <store>/embedding/<model id>/onnx/model_quantized.onnx
      expect(deps._createPaths[0]).toBe(
        join(storeDir, 'embedding', 'Xenova', 'multilingual-e5-small', 'onnx', 'model_quantized.onnx'),
      );
    } finally {
      delete process.env.PI8_DIR;
      rmSync(storeDir, { recursive: true, force: true });
    }
  });
});
