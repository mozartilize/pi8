/**
 * Embedding head — pure function. Maps an E5-small embedding vector to a
 * routing Dimension via cosine similarity to versioned prototype vectors.
 *
 * No I/O, no registry access, no session state. Its only contract is
 * `classifyEmbedding(embedding: Float32Array) → EmbeddingResult`.
 *
 * Prototypes are versioned via EMBEDDING_HEAD_VERSION. Changing them is a
 * reviewable event; the version must be bumped and the change justified by
 * net movement on `classifier-metrics.ts`.
 */
import type { Dimension } from '../types.js';
import { DIMENSION_STRENGTH } from '../routing/classify/classifier-keywords.js';

// ─── Version ──────────────────────────────────────────────────────────

/** Bump when prototypes, scoring rule, or dimension mapping changes. */
export const EMBEDDING_HEAD_VERSION = 1;

// ─── Label prototypes ──────────────────────────────────────────────────

/**
 * One prototype per routing dimension. The text describes the TASK the user
 * wants the agent to perform, not the model's role or capability level.
 *
 * Prototypes are embedded with the E5 `"query: "` prefix at inference time
 * (by the caller), so they are compared in query space against user prompts.
 *
 * Design constraint: prototypes must be semantically distinct. If two
 * prototypes are within ~0.85 cosine, noise dominates classification.
 * The current set is conservative.
 */
const PROTOTYPE_TEXTS: Record<Dimension, string> = {
  lightweight:
    'A very short simple message or greeting. Small talk only. No technical content.',
  gather:
    'A question that asks to find, locate, explain, or investigate something. Search the codebase. Explain how a concept works. Report on status.',
  plan:
    'A request to design, architect, strategize, or plan something. Evaluate tradeoffs between approaches. Draft an RFC or proposal. High-level thinking before building.',
  implement:
    'A request to write, modify, fix, or build code. Debug a bug. Refactor existing code. Add a feature. Run a command that mutates files.',
  review:
    'A request to review, critique, audit, or check existing work for quality, security, or correctness.',
};

/**
 * Return the prototype text for a dimension, used by the caller when
 * embedding prototypes.
 */
export function getPrototypeText(dim: Dimension): string {
  return PROTOTYPE_TEXTS[dim];
}

// ─── Classification ───────────────────────────────────────────────────

export interface EmbeddingResult {
  dimension: Dimension;
  confidence: number;
  /** Per-dimension cosine similarity scores. */
  scores: Record<Dimension, number>;
}

/**
 * Classify a 384-dim L2-normalized embedding vector into a routing
 * dimension via cosine similarity to the prototype vectors.
 *
 * Confidence = margin between the top two dimensions, normalized to [0, 1].
 * Uncertainty routes up: if the top two are close, the stronger dimension wins.
 */
export function classifyEmbedding(
  embedding: Float32Array,
  prototypes: Record<Dimension, Float32Array>,
): EmbeddingResult {
  const dims = Object.keys(prototypes) as Dimension[];

  // Cosine similarity to each prototype (both are L2-normalized, so dot product = cosine)
  const scores: Record<string, number> = {};
  for (const dim of dims) {
    scores[dim] = dotProduct(embedding, prototypes[dim]);
  }

  // Sort by score descending, tie-break toward stronger dimension
  const ordered = dims
    .map((dim) => ({ dim, score: scores[dim] }))
    .sort((a, b) =>
      b.score !== a.score
        ? b.score - a.score
        : DIMENSION_STRENGTH[b.dim] - DIMENSION_STRENGTH[a.dim],
    );

  const top = ordered[0];
  const second = ordered[1]!;
  const confidence = top.score > 0
    ? clamp(1 - second.score / top.score, 0, 1)
    : 0.5;

  return {
    dimension: top.dim,
    confidence,
    scores: scores as Record<Dimension, number>,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────

function dotProduct(a: Float32Array, b: Float32Array): number {
  let result = 0;
  for (let i = 0; i < a.length; i++) result += a[i] * b[i];
  return result;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
