import { describe, it, expect } from 'vitest';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  detectPlatform,
  getEmbeddingDir,
  loadManifest,
  provisionEmbedding,
  type ManifestEntry,
} from './embedding-provision.js';

const PROVISION_NAMES = [
  'Xenova/multilingual-e5-small/tokenizer.json',
  'Xenova/multilingual-e5-small/tokenizer_config.json',
  'Xenova/multilingual-e5-small/config.json',
  'Xenova/multilingual-e5-small/onnx/model_quantized.onnx',
];

function makeMockBody(size: number, fill = 0): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(size).fill(fill));
      controller.close();
    },
  });
}

function mockFetch(size: number, fill = 0) {
  return () =>
    Promise.resolve({
      ok: true,
      status: 200,
      body: makeMockBody(size, fill),
    } as Response);
}

/** sha256 of a `size`-byte body filled with `fill` — matches makeMockBody. */
function bodyHash(size: number, fill = 0): string {
  return createHash('sha256').update(new Uint8Array(size).fill(fill)).digest('hex');
}

/** Manifest whose hashes match mock bodies of `size` bytes (fill 0). */
function makeManifest(size: number): ManifestEntry[] {
  const sha256 = bodyHash(size);
  return PROVISION_NAMES.map((name) => ({
    url: `https://example.test/${name}`,
    name,
    sha256,
    bytes: size,
  }));
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

  // ─── Manifest integrity ─────────────────────────────────────────

  it('loads the shipped manifest with 4 entries for the provisioned files', () => {
    const manifest = loadManifest();
    expect(manifest).toBeDefined();
    expect(manifest?.length).toBe(4);
    for (const entry of manifest ?? []) {
      expect(entry.url).toContain('huggingface.co');
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.bytes).toBeGreaterThan(0);
      expect(PROVISION_NAMES).toContain(entry.name);
    }
  });

  it('provisionEmbedding downloads files and reports ok', async () => {
    const base = join(tmpdir(), `pi8-prov-test-${Date.now()}`);
    try {
      const result = await provisionEmbedding({
        base,
        force: true,
        _fetch: mockFetch(120_000_000),
        _manifest: makeManifest(120_000_000),
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
        _manifest: makeManifest(120_000_000),
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

  it('skips files already present with matching size + sha256 (idempotent)', async () => {
    const base = join(tmpdir(), `pi8-prov-test-${Date.now()}`);
    let calls = 0;
    try {
      await provisionEmbedding({
        base,
        force: true,
        _fetch: mockFetch(120_000_000),
        _manifest: makeManifest(120_000_000),
      });
      calls = 0;
      const result = await provisionEmbedding({
        base,
        _fetch: () => {
          calls += 1;
          return mockFetch(120_000_000)();
        },
        _manifest: makeManifest(120_000_000),
      });
      expect(result.ok).toBe(true);
      expect(result.downloaded).toBeUndefined();
      expect(calls).toBe(0);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('re-downloads an existing file whose sha256 no longer matches (corrupt, same size)', async () => {
    const base = join(tmpdir(), `pi8-prov-test-${Date.now()}`);
    let calls = 0;
    try {
      await provisionEmbedding({
        base,
        force: true,
        _fetch: mockFetch(120_000_000),
        _manifest: makeManifest(120_000_000),
      });
      // Corrupt one file in place with same-size, different-content bytes.
      const modelPath = join(
        base, 'embedding', 'Xenova', 'multilingual-e5-small', 'onnx', 'model_quantized.onnx',
      );
      writeFileSync(modelPath, new Uint8Array(120_000_000).fill(1));
      calls = 0;
      const result = await provisionEmbedding({
        base,
        _fetch: () => {
          calls += 1;
          return mockFetch(120_000_000)();
        },
        _manifest: makeManifest(120_000_000),
      });
      expect(result.ok).toBe(true);
      expect(calls).toBe(1); // exactly the corrupt file was re-fetched
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('rejects a downloaded file whose sha256 mismatches the manifest (non-fatal)', async () => {
    const base = join(tmpdir(), `pi8-prov-test-${Date.now()}`);
    try {
      // Manifest says zero-filled bodies; the fetch returns one-filled bodies
      // of the same size — size passes, sha256 must fail.
      const result = await provisionEmbedding({
        base,
        force: true,
        _fetch: mockFetch(120_000_000, 1),
        _manifest: makeManifest(120_000_000),
      });
      expect(result.ok).toBe(false);
      expect(result.status).toContain('incomplete');
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
        _manifest: makeManifest(120_000_000),
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
        _manifest: makeManifest(100),
      });
      expect(result.ok).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  // ─── Runtime presence reporting ───────────────────────────────

  it('reports whether the onnxruntime-node runtime is importable', async () => {
    const base = join(tmpdir(), `pi8-prov-test-${Date.now()}`);
    try {
      const result = await provisionEmbedding({
        base,
        force: true,
        _fetch: mockFetch(120_000_000),
        _manifest: makeManifest(120_000_000),
      });
      expect(typeof result.runtimeAvailable).toBe('boolean');
      expect(result.status).toContain('onnxruntime-node runtime:');
      if (result.runtimeAvailable) {
        expect(result.status).toContain('available');
      } else {
        expect(result.status).toContain('MISSING');
      }
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
        _manifest: makeManifest(120_000_000),
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
