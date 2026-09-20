import { describe, it, expect } from 'vitest';
import { classifyEmbedding, getPrototypeText, EMBEDDING_HEAD_VERSION } from './embedding-head.js';
import type { Dimension } from '../types.js';

describe('embedding-head', () => {
  // ─── Prototype texts ──────────────────────────────────────────

  it('has distinct prototype text for every dimension', () => {
    const dims: Dimension[] = ['lightweight', 'gather', 'plan', 'implement', 'review'];
    const texts = new Set(dims.map((d) => getPrototypeText(d)));
    expect(texts.size).toBe(5);
  });

  it('prototypes are non-empty', () => {
    const dims: Dimension[] = ['lightweight', 'gather', 'plan', 'implement', 'review'];
    for (const d of dims) {
      expect(getPrototypeText(d).length).toBeGreaterThan(10);
    }
  });

  it('has a positive EMBEDDING_HEAD_VERSION', () => {
    expect(EMBEDDING_HEAD_VERSION).toBeGreaterThan(0);
  });

  // ─── Classification ───────────────────────────────────────────

  it('returns the dimension with the highest cosine', () => {
    // Create synthetic prototypes biased toward implement
    const prototypes = makeBiasPrototypes('implement');

    // Embedding close to implement prototype (slice 3 in dim order)
    const emb = makeBiasedVector(384, 3, 0.99);
    const result = classifyEmbedding(emb, prototypes);
    expect(result.dimension).toBe('implement');
  });

  it('returns high confidence when one prototype dominates', () => {
    const prototypes = makeBiasPrototypes('implement');
    const emb = makeBiasedVector(384, 3, 0.99);
    const result = classifyEmbedding(emb, prototypes);
    expect(result.confidence).toBeGreaterThan(0.5);
    expect(result.scores.implement).toBeGreaterThan(result.scores.gather);
    expect(result.scores.implement).toBeGreaterThan(result.scores.plan);
  });

  it('returns low confidence when all prototypes are similar', () => {
    // All prototypes identical → all scores equal → confidence near 0
    const prototypes: Record<Dimension, Float32Array> = {
      lightweight: makeBiasedVector(384, 0, 1.0),
      gather: makeBiasedVector(384, 0, 1.0),
      plan: makeBiasedVector(384, 0, 1.0),
      implement: makeBiasedVector(384, 0, 1.0),
      review: makeBiasedVector(384, 0, 1.0),
    };
    const emb = makeBiasedVector(384, 0, 1.0);
    const result = classifyEmbedding(emb, prototypes);
    expect(result.confidence).toBeLessThanOrEqual(0.5);
  });

  it('tie-breaks toward stronger dimension', () => {
    // Two dimensions tied: implement (strength 3) vs gather (strength 1)
    const prototypes: Record<Dimension, Float32Array> = {
      lightweight: makeBiasedVector(384, 0, 1.0),
      gather: makeBiasedVector(384, 1, 1.0),
      plan: makeBiasedVector(384, 0, 1.0),
      implement: makeBiasedVector(384, 1, 1.0),
      review: makeBiasedVector(384, 0, 1.0),
    };
    // Embedding equally close to implement and gather
    const emb = makeBiasedVector(384, 1, 1.0);
    const result = classifyEmbedding(emb, prototypes);
    // implement is stronger than gather
    expect(result.dimension).toBe('implement');
  });

  it('returns scores for all five dimensions', () => {
    const prototypes = makeBiasPrototypes('plan');
    const emb = makeBiasedVector(384, 0, 1.0);
    const result = classifyEmbedding(emb, prototypes);
    const dims: Dimension[] = ['lightweight', 'gather', 'plan', 'implement', 'review'];
    for (const d of dims) {
      expect(typeof result.scores[d]).toBe('number');
      expect(Number.isFinite(result.scores[d])).toBe(true);
    }
  });

  it('confidence is always in [0, 1]', () => {
    const prototypes = makeBiasPrototypes('gather');
    // Try a few different biased vectors
    for (const bias of [0, 1, 2, 3, 4]) {
      for (const strength of [0.5, 0.9, 1.0]) {
        const emb = makeBiasedVector(384, bias, strength);
        const result = classifyEmbedding(emb, prototypes);
        expect(result.confidence).toBeGreaterThanOrEqual(0);
        expect(result.confidence).toBeLessThanOrEqual(1);
      }
    }
  });

  // ─── Degrade safety ───────────────────────────────────────────

  it('does not throw on any Float32Array input', () => {
    const prototypes = makeBiasPrototypes('implement');

    // Zero vector
    expect(() => classifyEmbedding(new Float32Array(384), prototypes)).not.toThrow();

    // All ones
    expect(() => classifyEmbedding(new Float32Array(384).fill(0.1), prototypes)).not.toThrow();

    // Mixed signs
    const mixed = new Float32Array(384);
    for (let i = 0; i < 384; i++) mixed[i] = (i % 2 === 0 ? 1 : -1) * 0.05;
    expect(() => classifyEmbedding(mixed, prototypes)).not.toThrow();
  });
});

// ─── Test helpers ────────────────────────────────────────────────────

/** Create prototype vectors where one dimension is uniquely biased. */
function makeBiasPrototypes(_winner: Dimension): Record<Dimension, Float32Array> {
  const dims: Dimension[] = ['lightweight', 'gather', 'plan', 'implement', 'review'];
  const result = {} as Record<Dimension, Float32Array>;
  for (let i = 0; i < dims.length; i++) {
    result[dims[i]] = makeBiasedVector(384, i, 1.0);
  }
  return result;
}

/** Create a 384-dim L2-normalized vector biased at a specific slice. */
function makeBiasedVector(dim: number, sliceIndex: number, magnitude: number): Float32Array {
  const vec = new Float32Array(dim);

  // Distribute bias across a unique 76-element slice per index
  const sliceSize = Math.floor(dim / 5);
  const start = (sliceIndex % 5) * sliceSize;
  const biasPerElement = magnitude / Math.sqrt(sliceSize);
  for (let i = start; i < start + sliceSize && i < dim; i++) {
    vec[i] = biasPerElement;
  }

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) vec[i] /= norm;
  }
  return vec;
}
