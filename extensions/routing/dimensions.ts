import type { Dimension } from '../types.js';

/** Task-type strength used when preserving serving minimums. */
export const DIMENSION_STRENGTH: Record<Dimension, number> = {
  lightweight: 0,
  gather: 1,
  implement: 2,
  review: 3,
  plan: 4,
};
