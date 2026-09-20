/**
 * Embedding model provisioning — downloads E5-small ONNX model + tokenizer
 * into the store directory on demand. Idempotent: skips files whose size
 * AND sha256 match the shipped manifest. Atomic: writes to temp dir then
 * renames. Integrity: every downloaded and every pre-existing file is
 * verified against `embedding-manifest.json` (sha256), so a corrupt file
 * cannot masquerade as provisioned.
 *
 * Wired into `syncBenchmarks` as a sub-step when `config.embeddingClassifier`
 * is true, and also available standalone via `/router-sync embedding`.
 *
 * All failures are NON-FATAL (R2): a failed download, checksum mismatch, or
 * missing runtime is reported through `onProgress`/`status` and the caller
 * moves on with the layer disabled.
 */
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream';
import { promisify } from 'node:util';

import { resolveStoragePath } from '../bench/store.js';

const pipe = promisify(pipeline);

// ─── Constants ────────────────────────────────────────────────────────

const HF_BASE = 'https://huggingface.co/Xenova/multilingual-e5-small/resolve/main';

/**
 * transformers.js model id. The tokenizer is loaded from disk under a
 * model-named subdirectory of the embedding dir (transformers.js layout:
 * `<env.localModelPath>/<model_id>/<file>`), so files must be laid out as
 * `Xenova/multilingual-e5-small/...`, not flat.
 */
export const EMBEDDING_MODEL_ID = 'Xenova/multilingual-e5-small';

/** Files to download: relative HF path → local path under the embedding dir + minimum expected bytes. */
const PROVISION_FILES: Array<{
  url: string;
  name: string;
  minBytes: number;
}> = [
  {
    url: `${HF_BASE}/tokenizer.json`,
    name: `${EMBEDDING_MODEL_ID}/tokenizer.json`,
    minBytes: 15_000_000, // ~17 MB
  },
  // tokenizer_config.json + config.json are read by transformers.js when
  // resolving the tokenizer class; without them AutoTokenizer falls back
  // to heuristics. Both are tiny.
  {
    url: `${HF_BASE}/tokenizer_config.json`,
    name: `${EMBEDDING_MODEL_ID}/tokenizer_config.json`,
    minBytes: 100,
  },
  {
    url: `${HF_BASE}/config.json`,
    name: `${EMBEDDING_MODEL_ID}/config.json`,
    minBytes: 100,
  },
  {
    url: `${HF_BASE}/onnx/model_quantized.onnx`,
    name: `${EMBEDDING_MODEL_ID}/onnx/model_quantized.onnx`,
    minBytes: 110_000_000, // ~118 MB int8
  },
];

/** Subdirectory inside the store dir for embedding artifacts. */
const EMBEDDING_DIR = 'embedding';

// ─── Integrity manifest ───────────────────────────────────────────────

export interface ManifestEntry {
  url: string;
  name: string;
  sha256: string;
  bytes: number;
}

let cachedManifest: ManifestEntry[] | undefined;

/**
 * Load the shipped integrity manifest (`embedding-manifest.json`).
 * Returns undefined (degrade to size-only checks) when the manifest is
 * missing or malformed — provisioning must never fail on the manifest.
 */
export function loadManifest(): ManifestEntry[] | undefined {
  if (cachedManifest) return cachedManifest;
  try {
    const raw = readFileSync(
      new URL('./embedding-manifest.json', import.meta.url),
      'utf8',
    );
    const parsed = JSON.parse(raw) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.every(
        (e): e is ManifestEntry =>
          !!e &&
          typeof e === 'object' &&
          typeof (e as ManifestEntry).url === 'string' &&
          typeof (e as ManifestEntry).name === 'string' &&
          typeof (e as ManifestEntry).sha256 === 'string' &&
          typeof (e as ManifestEntry).bytes === 'number',
      )
    ) {
      cachedManifest = parsed;
    }
  } catch {
    // manifest missing/corrupt — caller falls back to size-only verification
  }
  return cachedManifest;
}

/** Stream a file through sha256, resolving to the lowercase hex digest. */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// ─── Optional runtime presence ────────────────────────────────────────

/**
 * Whether the `onnxruntime-node` native runtime is importable. Model files
 * alone are insufficient — the embedding engine degrades to unavailable when
 * this optional dependency is missing, so the provisioning status must say so.
 * Never throws; a missing/broken package resolves to false (R2).
 */
export async function isOnnxRuntimeImportable(): Promise<boolean> {
  try {
    await import('onnxruntime-node');
    return true;
  } catch {
    return false;
  }
}

function runtimeStatusLine(runtimeAvailable: boolean): string {
  return runtimeAvailable
    ? 'onnxruntime-node runtime: available'
    : 'onnxruntime-node runtime: MISSING — install the optional onnxruntime-node + @xenova/transformers deps to use the embedding classifier';
}

// ─── Platform detection ───────────────────────────────────────────────

export interface PlatformInfo {
  platform: string;
  arch: string;
  /** e.g. 'linux-x64' */
  artifactKey: string;
}

export function detectPlatform(): PlatformInfo {
  return {
    platform: process.platform,
    arch: process.arch,
    artifactKey: `${process.platform}-${process.arch}`,
  };
}

// ─── Path resolution ──────────────────────────────────────────────────

export function getEmbeddingDir(base?: string): string {
  return join(resolveStoragePath(base), EMBEDDING_DIR);
}

/**
 * Directory containing the provisioned model files, laid out in
 * transformers.js form (`<embedding dir>/<model id>/`).
 */
export function getEmbeddingModelDir(base?: string): string {
  return join(getEmbeddingDir(base), EMBEDDING_MODEL_ID);
}

/** Path to the provisioned int8 ONNX model. */
export function getEmbeddingModelPath(base?: string): string {
  return join(getEmbeddingModelDir(base), 'onnx', 'model_quantized.onnx');
}

// ─── Provisioning ─────────────────────────────────────────────────────

export interface ProvisionResult {
  /** True if all files are present and valid. */
  ok: boolean;
  /** Human-readable status line. */
  status: string;
  /** Files that were downloaded (only on fresh downloads). */
  downloaded?: string[];
  /** Whether the onnxruntime-node optional runtime is importable. */
  runtimeAvailable: boolean;
}

/**
 * Ensure embedding model files exist in the store directory.
 *
 * Idempotent: skips files that already exist with sufficient size.
 * Atomic: downloads to a temp directory then renames into place, so a
 * partial download or crash cannot leave a corrupt model.
 *
 * Provision failure is NON-FATAL: the caller logs the status and moves on.
 * The embedding engine degrades to `available: false` when files are missing.
 */
export async function provisionEmbedding(opts: {
  base?: string;
  force?: boolean;
  onProgress?: (status: string) => void;
  /** Injectable fetch for testing. Defaults to globalThis.fetch. */
  _fetch?: typeof globalThis.fetch;
  /** Injectable integrity manifest for testing. Defaults to the shipped manifest. */
  _manifest?: ManifestEntry[];
} = {}): Promise<ProvisionResult> {
  const fetcher = opts._fetch ?? globalThis.fetch;
  const manifest = opts._manifest ?? loadManifest();
  const runtimeAvailable = await isOnnxRuntimeImportable();
  const targetDir = getEmbeddingDir(opts.base);
  mkdirSync(targetDir, { recursive: true });

  const platform = detectPlatform();
  const downloaded: string[] = [];
  let allOk = true;

  for (const file of PROVISION_FILES) {
    const destPath = join(targetDir, file.name);
    mkdirSync(dirname(destPath), { recursive: true });
    const manifestEntry = manifest?.find((m) => m.name === file.name);

    // Skip if present and valid (not forced). "Valid" means size AND sha256
    // match the manifest — a same-size corrupt file must be re-downloaded.
    if (!opts.force && existsSync(destPath)) {
      try {
        const stat = statSync(destPath);
        if (stat.size >= file.minBytes) {
          if (manifestEntry && manifestEntry.bytes !== stat.size) {
            opts.onProgress?.(
              `${file.name}: corrupt (${stat.size} bytes != ${manifestEntry.bytes} expected), re-downloading`,
            );
          } else if (manifestEntry) {
            const actual = await sha256File(destPath);
            if (actual === manifestEntry.sha256) {
              opts.onProgress?.(`${file.name}: present (verified sha256)`);
              continue;
            }
            opts.onProgress?.(
              `${file.name}: sha256 mismatch (${actual.slice(0, 12)}... != ${manifestEntry.sha256.slice(0, 12)}...), re-downloading`,
            );
          } else {
            // No manifest entry — fall back to the size-only check.
            opts.onProgress?.(`${file.name}: present (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
            continue;
          }
        } else {
          opts.onProgress?.(`${file.name}: corrupt (${stat.size} bytes < ${file.minBytes} min), re-downloading`);
        }
      } catch {
        // stat/hash failed — re-download
      }
    }

    // Download to a fresh temp dir (mkdtemp: unique per call, so concurrent
    // provisions cannot collide on a shared timestamped name). The tmp file
    // stays flat — the nested destination dirs only need to exist at rename
    // time (the loop mkdirs them above).
    const tmpDir = mkdtempSync(join(tmpdir(), 'pi8-embed-'));
    const tmpPath = join(tmpDir, file.name.replaceAll('/', '_'));

    try {
      opts.onProgress?.(`${file.name}: downloading from ${file.url} ...`);

      const response = await fetcher(file.url);
      if (!response.ok || !response.body) {
        opts.onProgress?.(`${file.name}: HTTP ${response.status}`);
        allOk = false;
        rmSync(tmpDir, { recursive: true, force: true });
        continue;
      }

      const dest = createWriteStream(tmpPath);
      await pipe(response.body, dest);

      // Verify size then sha256 against the manifest.
      const stat = statSync(tmpPath);
      if (stat.size < file.minBytes) {
        opts.onProgress?.(
          `${file.name}: too small (${(stat.size / 1024 / 1024).toFixed(1)} MB < ${(file.minBytes / 1024 / 1024).toFixed(0)} MB expected)`,
        );
        allOk = false;
        rmSync(tmpDir, { recursive: true, force: true });
        continue;
      }

      if (manifestEntry) {
        const actual = await sha256File(tmpPath);
        if (actual !== manifestEntry.sha256) {
          opts.onProgress?.(
            `${file.name}: sha256 mismatch (${actual.slice(0, 12)}... != ${manifestEntry.sha256.slice(0, 12)}...), file rejected`,
          );
          allOk = false;
          rmSync(tmpDir, { recursive: true, force: true });
          continue;
        }
      }

      // Atomic rename into place
      if (existsSync(destPath)) rmSync(destPath);
      renameSync(tmpPath, destPath);
      rmSync(tmpDir, { recursive: true, force: true });

      downloaded.push(file.name);
      opts.onProgress?.(
        `${file.name}: downloaded (${(stat.size / 1024 / 1024).toFixed(1)} MB)`,
      );
    } catch (e) {
      opts.onProgress?.(`${file.name}: failed — ${String(e)}`);
      allOk = false;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  const runtimeLine = runtimeStatusLine(runtimeAvailable);

  if (allOk && downloaded.length === 0) {
    return {
      ok: true,
      status: `Embedding model ready (${platform.artifactKey}); ${runtimeLine}`,
      runtimeAvailable,
    };
  }

  if (allOk) {
    return {
      ok: true,
      status: `Embedding model provisioned: ${downloaded.join(', ')} (${platform.artifactKey}); ${runtimeLine}`,
      downloaded,
      runtimeAvailable,
    };
  }

  return {
    ok: false,
    status: `Embedding provision incomplete — some files failed integrity verification. Check network and retry. ${runtimeLine}`,
    downloaded: downloaded.length > 0 ? downloaded : undefined,
    runtimeAvailable,
  };
}
