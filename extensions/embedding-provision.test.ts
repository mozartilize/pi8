import { describe, it, expect } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  detectPlatform,
  getEmbeddingDir,
  provisionEmbedding,
} from './embedding-provision.js';

function makeMockBody(size: number): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(size));
      controller.close();
    },
  });
}

function mockFetch(size: number) {
  return () =>
    Promise.resolve({
      ok: true,
      status: 200,
      body: makeMockBody(size),
    } as Response);
}

describe('embedding-provision', () => {
  // ─── Platform detection ───────────────────────────────────────

  it('detectPlatform returns expected shape', () => {
    const info = detectPlatform();
    expect(info.platform).toBeTruthy();
    expect(info.arch).toBeTruthy();
    expect(info.artifactKey).toBe(`${info.platform}-${info.arch}`);
    expect(['linux', 'darwin', 'win32']).toContain(info.platform);
    expect(['x64', 'arm64']).toContain(info.arch);
  });

  // ─── Path resolution ─────────────────────────────────────────

  it('getEmbeddingDir returns a path under the store dir', () => {
    const dir = getEmbeddingDir('/tmp/test-pi8');
    expect(dir).toContain('embedding');
    expect(dir.startsWith('/tmp/test-pi8')).toBe(true);
  });

  // ─── Successful provision (mocked fetch) ──────────────────────

  it('provisionEmbedding downloads files and reports ok', async () => {
    const base = join(tmpdir(), `pi8-prov-test-${Date.now()}`);
    try {
      const result = await provisionEmbedding({
        base,
        force: true,
        _fetch: mockFetch(120_000_000),
      });
      expect(result.ok).toBe(true);
      expect(result.downloaded).toBeDefined();
      expect(result.downloaded).toContain('Xenova/multilingual-e5-small/onnx/model_quantized.onnx');
      expect(result.downloaded).toContain('Xenova/multilingual-e5-small/tokenizer.json');
      expect(result.downloaded).toContain('Xenova/multilingual-e5-small/tokenizer_config.json');
      expect(result.downloaded).toContain('Xenova/multilingual-e5-small/config.json');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('lays files out in the transformers.js local layout', async () => {
    const base = join(tmpdir(), `pi8-prov-test-${Date.now()}`);
    try {
      const result = await provisionEmbedding({
        base,
        force: true,
        _fetch: mockFetch(120_000_000),
      });
      expect(result.ok).toBe(true);
      // transformers.js resolves `<env.localModelPath>/<model id>/<file>`, so
      // the embedding dir must contain a model-named subdirectory — the
      // tokenizer must be loadable from disk with no network (fix: provisioned
      // tokenizer.json is actually consumed).
      const expected = [
        join(base, 'embedding', 'Xenova', 'multilingual-e5-small', 'tokenizer.json'),
        join(base, 'embedding', 'Xenova', 'multilingual-e5-small', 'tokenizer_config.json'),
        join(base, 'embedding', 'Xenova', 'multilingual-e5-small', 'config.json'),
        join(base, 'embedding', 'Xenova', 'multilingual-e5-small', 'onnx', 'model_quantized.onnx'),
      ];
      for (const file of expected) {
        expect(existsSync(file)).toBe(true);
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('skips files already present with sufficient size (idempotent)', async () => {
    const base = join(tmpdir(), `pi8-prov-test-${Date.now()}`);
    let calls = 0;
    try {
      await provisionEmbedding({ base, force: true, _fetch: mockFetch(120_000_000) });
      calls = 0;
      const result = await provisionEmbedding({
        base,
        _fetch: () => {
          calls += 1;
          return mockFetch(120_000_000)();
        },
      });
      expect(result.ok).toBe(true);
      expect(result.downloaded).toBeUndefined();
      expect(calls).toBe(0);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  // ─── Degradation on HTTP failure ──────────────────────────────

  it('provisionEmbedding reports failure when HTTP fails', async () => {
    const base = join(tmpdir(), `pi8-prov-test-${Date.now()}`);
    try {
      const result = await provisionEmbedding({
        base,
        force: true,
        _fetch: () => Promise.resolve({ ok: false, status: 500, body: null } as Response),
      });
      expect(result.ok).toBe(false);
      expect(result.status).toContain('incomplete');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  // ─── Degradation on too-small response ────────────────────────

  it('provisionEmbedding rejects files that are too small', async () => {
    const base = join(tmpdir(), `pi8-prov-test-${Date.now()}`);
    try {
      const result = await provisionEmbedding({
        base,
        force: true,
        _fetch: mockFetch(100),
      });
      expect(result.ok).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  // ─── onProgress callback ─────────────────────────────────────

  it('calls onProgress for each file', async () => {
    const base = join(tmpdir(), `pi8-prov-test-${Date.now()}`);
    const progress: string[] = [];

    try {
      await provisionEmbedding({
        base,
        force: true,
        _fetch: mockFetch(120_000_000),
        onProgress: (status) => progress.push(status),
      });

      expect(progress.length).toBeGreaterThanOrEqual(2);
      const hasDownloaded = progress.some((p) => p.includes('downloaded'));
      expect(hasDownloaded).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
