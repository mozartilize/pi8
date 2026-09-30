import type { Dimension, ScoreWeights } from './types.js';

export const STORAGE_DIR = '~/.pi/agent/pi8' as const;
export const STORE_FILE = 'benchmarks.json' as const;
export const CONFIG_FILE = 'config.json' as const;
/** 14 days in ms. */
export const STALE_MS = 14 * 24 * 60 * 60 * 1000;

export const DEFAULT_DIMENSION_WEIGHTS: Record<Dimension, ScoreWeights> = {
  lightweight: { quality: 0.2, cost: 0.6, speed: 0.2 },
  gather: { quality: 0.4, cost: 0.4, speed: 0.2 },
  plan: { quality: 0.8, cost: 0.15, speed: 0.05 },
  implement: { quality: 0.6, cost: 0.3, speed: 0.1 },
  review: { quality: 0.7, cost: 0.25, speed: 0.05 },
};

export const DEFAULT_SWITCH_MARGIN = 0.15;
