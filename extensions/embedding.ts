/**
 * Embedding engine — lazy singleton for E5-small inference.
 *
 * Loads the ONNX model and tokenizer once, then provides `embed(text)` for
 * the lifetime of the process. Every public method degrades to `undefined`
 * on any failure or deadline expiry (R2: the router must never block or
 * fail a turn because of its own bugs). Not a hard dependency: onnxruntime-
 * node and the tokenizer package are dynamically imported and absent
 * packages produce a no-op engine with `available: false`.
 *
 * Deadlines: onnxruntime-node exposes no AbortSignal, so the deadline is a
 * bounded wait, not a cancellation — on timeout the caller gets `undefined`
 * while any in-flight native work finishes in the background (it may still
 * set engine state for later calls). Load failures that need user action
 * (missing package, missing model file) latch; transient failures
 * (tokenizer fetch, session create) retry on the next call instead of
 * bricking the feature until restart.
 *
 * Callers outside the hot path (provisioning, tests) can configure
 * `modelPath` explicitly. The default reads from the store directory
 * (the `/router-sync embedding` provision path).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Suppress ONNX Runtime telemetry before the first dynamic import.
// Must be set before onnxruntime-node loads to prevent the uploader,
// events, and persistent device identifier from being created.
process.env.ORT_DISABLE_TELEMETRY = '1';

import { resolveStoragePath } from './store.js';
import type { Dimension } from './types.js';
import { classifyEmbedding, getPrototypeText } from './embedding-head.js';
import type { EmbeddingResult } from './embedding-head.js';

export type { EmbeddingResult } from './embedding-head.js';

// ─── Types ────────────────────────────────────────────────────────────

export interface EmbeddingOptions {
  /** Path to the int8 ONNX model file. Defaults to store dir. */
  modelPath?: string;
  /** Maximum ms for model load + single inference. Default 5000. */
  deadlineMs?: number;
}

interface OrtModule {
  Tensor: new (type: string, data: BigInt64Array, dims: number[]) => unknown;
  InferenceSession: {
    create: (path: string, opts: Record<string, unknown>) => Promise<Session>;
  };
}

interface Session {
  run: (
    feeds: Record<string, unknown>,
  ) => Promise<Record<string, { data: Float32Array; dims: number[] }>>;
  outputNames: string[];
}

interface TokenizerFn {
  (
    text: string,
  ): {
    input_ids: { data: BigInt64Array; dims: number[] };
    attention_mask: { data: BigInt64Array; dims: number[] };
  };
}

// ─── Constants ────────────────────────────────────────────────────────

/** Matches config.ts `embeddingDeadlineMs` default. */
const DEFAULT_DEADLINE_MS = 5000;

/** E5 models embed queries with a "query: " prefix, passages with "passage: ". */
const E5_QUERY_PREFIX = 'query: ';

/** E5-small fixed hidden dimension. */
const HIDDEN_SIZE = 384;

const DIMENSIONS: Dimension[] = ['lightweight', 'gather', 'plan', 'implement', 'review'];

// ─── Lazy singleton state ─────────────────────────────────────────────

let engineState: {
  ort: OrtModule;
  session: Session;
  tokenizer: TokenizerFn;
  hiddenSize: number;
  prototypes: Record<Dimension, Float32Array>;
} | undefined;

/**
 * Latch for load failures that need user action (missing package, missing
 * model file). Transient failures leave this unset so the next call retries.
 */
let loadError: string | undefined;
let loadPromise: Promise<void> | undefined;

// ─── Test seam ────────────────────────────────────────────────────────

let testOverrides: { ort?: OrtModule; tokenizer?: TokenizerFn } | undefined;

/**
 * Inject fake engine dependencies (tests only). Overrides the dynamic
 * imports and the model-file existence check so the full init → embed →
 * classify pipeline runs without native packages or a downloaded model.
 */
export function setEmbeddingTestOverrides(
  overrides: { ort?: OrtModule; tokenizer?: TokenizerFn } | undefined,
): void {
  testOverrides = overrides;
  resetEmbeddingEngine();
}

// ─── Dynamic imports ──────────────────────────────────────────────────

async function tryImportOrt(): Promise<OrtModule | undefined> {
  try {
    return (await import('onnxruntime-node')) as unknown as OrtModule;
  } catch {
    return undefined;
  }
}

async function tryImportTokenizer(): Promise<TokenizerFn | undefined> {
  try {
    const { AutoTokenizer } = await import('@xenova/transformers');
    const tok = await AutoTokenizer.from_pretrained('Xenova/multilingual-e5-small');
    return (text: string) => {
      const encoded = tok(text, { padding: true, truncation: true, max_length: 128 });
      return {
        input_ids: encoded.input_ids,
        attention_mask: encoded.attention_mask,
      };
    };
  } catch {
    return undefined;
  }
}

// ─── Deadline race ────────────────────────────────────────────────────

/**
 * Resolve `p`'s value, or `undefined` after `ms`. onnxruntime-node exposes
 * no AbortSignal, so the deadline is a bounded wait, not a cancellation:
 * in-flight native work completes in the background and may still set
 * engine state for later calls. Rejections also resolve to `undefined`.
 */
function raceDeadline<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  const bounded = Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_DEADLINE_MS;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), bounded);
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

// ─── Mean pool + L2 normalize ─────────────────────────────────────────

async function embedFromSession(
  ort: OrtModule,
  session: Session,
  tokenizer: TokenizerFn,
  text: string,
  hiddenSize: number,
): Promise<Float32Array> {
  const prefixed = E5_QUERY_PREFIX + text;
  const encoded = tokenizer(prefixed);
  const seqLen = encoded.input_ids.dims[1];
  const idData = encoded.input_ids.data;
  const maskData = encoded.attention_mask.data;

  // Construct ONNX tensors. `ort` is passed in because during init the
  // prototypes are embedded before `engineState` exists.
  const { Tensor } = ort;
  const inputTensor = new Tensor('int64', idData, [1, seqLen]);
  const maskTensor = new Tensor('int64', maskData, [1, seqLen]);
  const typeTensor = new Tensor('int64', new BigInt64Array(seqLen).fill(0n), [1, seqLen]);

  const results = await session.run({
    input_ids: inputTensor,
    attention_mask: maskTensor,
    token_type_ids: typeTensor,
  });
  const output = results[session.outputNames[0]];
  const floatData = output.data;

  // Mean pool with attention mask
  let maskSum = 0;
  for (let i = 0; i < seqLen; i++) maskSum += Number(maskData[i]);
  const pooled = new Float32Array(hiddenSize);
  if (maskSum > 0) {
    for (let t = 0; t < seqLen; t++) {
      if (maskData[t] === 0n) continue;
      for (let h = 0; h < hiddenSize; h++) {
        pooled[h] += floatData[t * hiddenSize + h] / maskSum;
      }
    }
  }

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < hiddenSize; i++) norm += pooled[i] * pooled[i];
  norm = Math.sqrt(norm);
  const normalized = new Float32Array(hiddenSize);
  if (norm > 0) {
    for (let i = 0; i < hiddenSize; i++) normalized[i] = pooled[i] / norm;
  }
  return normalized;
}

// ─── Engine initialization ────────────────────────────────────────────

async function initEngine(opts: EmbeddingOptions): Promise<boolean> {
  if (engineState) return true;
  if (loadError) return false;

  // Deduplicate concurrent init calls: a slow first load (tokenizer fetch,
  // session create) is shared, and every waiter is bounded by its own
  // deadline race at the call site.
  if (loadPromise) {
    await loadPromise;
    return engineState !== undefined;
  }

  loadPromise = (async () => {
    const ort = testOverrides?.ort ?? (await tryImportOrt());
    if (!ort) {
      loadError =
        'onnxruntime-node not available — install it to use the embedding classifier';
      return;
    }

    const tokenizer = testOverrides?.tokenizer ?? (await tryImportTokenizer());
    if (!tokenizer) {
      // Retryable: a missing package fails fast, a failed tokenizer fetch
      // is transient. Neither needs a latch.
      return;
    }

    const modelPath =
      opts.modelPath ?? join(resolveStoragePath(), 'embedding', 'model_quantized.onnx');
    if (!testOverrides && !existsSync(modelPath)) {
      loadError = `embedding model not found at ${modelPath} — run /router-sync embedding`;
      return;
    }

    try {
      const session = await ort.InferenceSession.create(modelPath, {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
      });

      // Pre-embed all five dimension prototypes (one-time, cheap)
      const prototypes = {} as Record<Dimension, Float32Array>;
      for (const dim of DIMENSIONS) {
        prototypes[dim] = await embedFromSession(
          ort,
          session,
          tokenizer,
          getPrototypeText(dim),
          HIDDEN_SIZE,
        );
      }

      engineState = { ort, session, tokenizer, hiddenSize: HIDDEN_SIZE, prototypes };
    } catch {
      // Retryable load failure (corrupt model, transient session error).
      // Leave loadError unset so a later call attempts a fresh load.
    }
  })();

  await loadPromise;
  if (!engineState) loadPromise = undefined; // allow a later retry
  return engineState !== undefined;
}

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Returns true if the engine loaded successfully and is ready to embed.
 */
export function isEmbeddingAvailable(): boolean {
  return engineState !== undefined;
}

/**
 * Human-readable reason why the engine is unavailable, or undefined.
 */
export function getEmbeddingError(): string | undefined {
  return loadError;
}

/**
 * Ensure the engine is loaded, bounded by `deadlineMs` (default 5000).
 * Idempotent — subsequent calls are cheap once loaded. Returns true on
 * success; false if the load failed or did not finish within the deadline
 * (the load may still complete in the background for later calls).
 */
export async function ensureEmbeddingEngine(opts: EmbeddingOptions = {}): Promise<boolean> {
  const ready = await raceDeadline(initEngine(opts), opts.deadlineMs ?? DEFAULT_DEADLINE_MS);
  return ready === true && engineState !== undefined;
}

/**
 * Embed a text and classify into a routing dimension, bounded by
 * `deadlineMs` (default 5000) across engine load + inference.
 *
 * Returns `undefined` on any failure or timeout — the caller MUST use the
 * keyword result as fallback (R2). Never throws.
 */
export async function embedAndClassify(
  text: string,
  opts: { deadlineMs?: number } = {},
): Promise<EmbeddingResult | undefined> {
  const deadline = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
  if (!engineState) {
    const ready = await raceDeadline(initEngine({}), deadline);
    if (ready !== true || !engineState) return undefined;
  }
  const vec = await raceDeadline(
    embedFromSession(
      engineState.ort,
      engineState.session,
      engineState.tokenizer,
      text,
      engineState.hiddenSize,
    ),
    deadline,
  );
  if (!vec) return undefined;
  return classifyEmbedding(vec, engineState.prototypes);
}

/**
 * Reset the engine (tests only). Not for production use — Pi extensions
 * are long-lived singletons.
 */
export function resetEmbeddingEngine(): void {
  engineState = undefined;
  loadError = undefined;
  loadPromise = undefined;
}
