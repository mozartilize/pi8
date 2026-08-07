/**
 * Embedding model provisioning — downloads E5-small ONNX model + tokenizer
 * into the store directory on demand. Idempotent: skips when files exist
 * with the expected size. Atomic: writes to temp dir then renames.
 *
 * Wired into `syncBenchmarks` as a sub-step when `config.embeddingClassifier`
 * is true, and also available standalone via `/router-sync embedding`.
 */
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream';
import { promisify } from 'node:util';

import { resolveStoragePath } from './store.js';

const pipe = promisify(pipeline);

// ─── Constants ────────────────────────────────────────────────────────

const HF_BASE = 'https://huggingface.co/Xenova/multilingual-e5-small/resolve/main';

/** Files to download: relative HF path → local name + minimum expected bytes. */
const PROVISION_FILES: Array<{
  url: string;
  name: string;
  minBytes: number;
}> = [
  {
    url: `${HF_BASE}/onnx/model_quantized.onnx`,
    name: 'model_quantized.onnx',
    minBytes: 110_000_000, // ~118 MB int8
  },
  {
    url: `${HF_BASE}/tokenizer.json`,
    name: 'tokenizer.json',
    minBytes: 15_000_000, // ~17 MB
  },
];

/** Subdirectory inside the store dir for embedding artifacts. */
const EMBEDDING_DIR = 'embedding';

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

// ─── Provisioning ─────────────────────────────────────────────────────

export interface ProvisionResult {
  /** True if all files are present and valid. */
  ok: boolean;
  /** Human-readable status line. */
  status: string;
  /** Files that were downloaded (only on fresh downloads). */
  downloaded?: string[];
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
} = {}): Promise<ProvisionResult> {
  const fetcher = opts._fetch ?? globalThis.fetch;
  const targetDir = getEmbeddingDir(opts.base);
  mkdirSync(targetDir, { recursive: true });

  const platform = detectPlatform();
  const downloaded: string[] = [];
  let allOk = true;

  for (const file of PROVISION_FILES) {
    const destPath = join(targetDir, file.name);

    // Skip if present and valid (not forced)
    if (!opts.force && existsSync(destPath)) {
      try {
        const stat = statSync(destPath);
        if (stat.size >= file.minBytes) {
          opts.onProgress?.(`${file.name}: present (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
          continue;
        }
        opts.onProgress?.(`${file.name}: corrupt (${stat.size} bytes < ${file.minBytes} min), re-downloading`);
      } catch {
        // stat failed — re-download
      }
    }

    // Download to a fresh temp dir (mkdtemp: unique per call, so concurrent
    // provisions cannot collide on a shared timestamped name)
    const tmpDir = mkdtempSync(join(tmpdir(), 'pi8-embed-'));
    const tmpPath = join(tmpDir, file.name);

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

      // Verify
      const stat = statSync(tmpPath);
      if (stat.size < file.minBytes) {
        opts.onProgress?.(
          `${file.name}: too small (${(stat.size / 1024 / 1024).toFixed(1)} MB < ${(file.minBytes / 1024 / 1024).toFixed(0)} MB expected)`,
        );
        allOk = false;
        rmSync(tmpDir, { recursive: true, force: true });
        continue;
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

  if (allOk && downloaded.length === 0) {
    return { ok: true, status: `Embedding model ready (${platform.artifactKey})` };
  }

  if (allOk) {
    return {
      ok: true,
      status: `Embedding model provisioned: ${downloaded.join(', ')} (${platform.artifactKey})`,
      downloaded,
    };
  }

  return {
    ok: false,
    status: `Embedding provision incomplete — some files could not be downloaded. Check network and retry.`,
    downloaded: downloaded.length > 0 ? downloaded : undefined,
  };
}
