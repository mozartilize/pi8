import { describe, it, expect } from 'vitest';
import {
  KIND_DESCRIPTIONS,
  KIND_MIN_MARGIN,
  SUBSTANTIVE_EXAMPLES,
  THIN_EXAMPLES,
  THIN_MIN_MARGIN,
  readEmbedding,
  referenceTexts,
  referenceVectors,
  type ReferenceVectors,
} from './embedding-head.js';
import type { TaskKind } from '../types.js';

/** A unit vector at `angle` radians in the first plane. */
const at = (angle: number): Float32Array => Float32Array.from([Math.cos(angle), Math.sin(angle), 0, 0]);
const axis = (index: number): Float32Array => {
  const v = new Float32Array(4);
  v[index] = 1;
  return v;
};

function refs(over: Partial<ReferenceVectors> = {}): ReferenceVectors {
  const kinds = {
    lightweight: axis(3), gather: axis(3), plan: axis(3), implement: axis(3), review: axis(3),
  } as Record<TaskKind, Float32Array>;
  return { thin: [at(0), at(0), at(0)], substantive: [at(1), at(1), at(1)], kinds, ...over };
}

describe('reference texts', () => {
  it('lists thin examples, substantive examples, then one description per kind', () => {
    const texts = referenceTexts();
    expect(texts).toHaveLength(THIN_EXAMPLES.length + SUBSTANTIVE_EXAMPLES.length + 5);
    const vectors = texts.map((_, index) => Float32Array.from([index]));
    const split = referenceVectors(vectors);
    expect(split.thin.map((v) => v[0])).toEqual(THIN_EXAMPLES.map((_, i) => i));
    expect(split.substantive).toHaveLength(SUBSTANTIVE_EXAMPLES.length);
    for (const kind of Object.keys(KIND_DESCRIPTIONS) as TaskKind[]) {
      expect(texts[split.kinds[kind]![0]!]).toBe(KIND_DESCRIPTIONS[kind]);
    }
  });

  it('never labels one text both thin and substantive', () => {
    const thin = new Set(THIN_EXAMPLES);
    expect(SUBSTANTIVE_EXAMPLES.filter((text) => thin.has(text))).toEqual([]);
  });
});

describe('thin reading', () => {
  it('reads a prompt nearer the thin examples as thin', () => {
    const reading = readEmbedding(at(0.05), refs());
    expect(reading.thinMargin).toBeGreaterThan(THIN_MIN_MARGIN);
    expect(reading.thin).toBe(true);
  });

  it('reads a prompt nearer the substantive examples as not thin', () => {
    const reading = readEmbedding(at(0.95), refs());
    expect(reading.thinMargin).toBeLessThan(0);
    expect(reading.thin).toBe(false);
  });

  it('needs the thin lead to clear the margin, not merely be positive', () => {
    // Halfway between the two sets, nudged toward thin by less than the margin.
    const reading = readEmbedding(at(0.49), refs());
    expect(reading.thinMargin).toBeGreaterThan(0);
    expect(reading.thinMargin).toBeLessThan(THIN_MIN_MARGIN);
    expect(reading.thin).toBe(false);
  });

  it('compares against the nearest examples, so one close example is not enough', () => {
    const reading = readEmbedding(at(0), refs({ thin: [at(0), at(1.4), at(1.4)] }));
    expect(reading.thin).toBe(false);
  });
});

describe('kind reading', () => {
  const kinds = {
    lightweight: axis(3), gather: at(1.5), plan: at(0.9), implement: at(0), review: axis(2),
  } as Record<TaskKind, Float32Array>;

  it('reads the nearest description and its lead over the next one', () => {
    const reading = readEmbedding(at(0.1), refs({ kinds }));
    expect(reading.kind).toBe('implement');
    expect(reading.kindMargin).toBeCloseTo(Math.cos(0.1) - Math.cos(0.8), 5);
    expect(reading.kindDecided).toBe(true);
  });

  it('leaves the kind undecided when two descriptions are about as near', () => {
    const reading = readEmbedding(at(0.45), refs({ kinds }));
    expect(reading.kindMargin).toBeLessThan(KIND_MIN_MARGIN);
    expect(reading.kindDecided).toBe(false);
  });
});
