import type { Dimension, ScoreWeights } from './types.js';

export const STORAGE_DIR = '~/.pi/agent/pi8' as const;
export const STORE_FILE = 'benchmarks.json' as const;
export const CONFIG_FILE = 'config.json' as const;
/** 14 days in ms. */
export const STALE_MS = 14 * 24 * 60 * 60 * 1000;

/** The four complexity tiers correspond to LiteLLM's boundaries. */
export const TIER_BOUNDARIES = {
  simple_medium: 0.15,
  medium_complex: 0.35,
  complex_reasoning: 0.6,
} as const;

/**
 * Dimension weights ported from LiteLLM's complexity router.
 */
export const DEFAULT_COMPLEXITY_DIMENSION_WEIGHTS: Record<string, number> = {
  tokenCount: 0.1,
  codePresence: 0.3,
  reasoningMarkers: 0.25,
  technicalTerms: 0.25,
  simpleIndicators: 0.05,
  multiStepPatterns: 0.03,
  questionComplexity: 0.02,
};

export const DEFAULT_DIMENSION_WEIGHTS: Record<Dimension, ScoreWeights> = {
  lightweight: { quality: 0.2, cost: 0.6, speed: 0.2 },
  gather: { quality: 0.4, cost: 0.4, speed: 0.2 },
  plan: { quality: 0.8, cost: 0.15, speed: 0.05 },
  implement: { quality: 0.6, cost: 0.3, speed: 0.1 },
  review: { quality: 0.7, cost: 0.25, speed: 0.05 },
};

export const DEFAULT_SWITCH_MARGIN = 0.15;
export const DEFAULT_LOW_CONFIDENCE_THRESHOLD = 0.15;

/** Reported confidence never drops below this floor, so a caller threshold
 * below it cannot silently change the routed dimension. */
export const CONFIDENCE_FLOOR = 0.1;
/**
 * Minimum embedding-classifier confidence (the margin between the top two
 * prototype scores) for the blend to apply. Below it the embedding layer
 * abstains and the keyword result stands unchanged — abstention never routes
 * cheaper (R3). Default 0.15.
 */
export const DEFAULT_EMBEDDING_MIN_CONFIDENCE = 0.15;

/**
 * One end-to-end assessment budget. It bounds selection, auth, startup,
 * streaming, and parsing so semantic routing cannot stall the turn.
 */
export const DEFAULT_ASSESSMENT_DEADLINE_MS = 1500;

/**
 * Total assembled assessment input cap. The assessor sees bounded, redacted,
 * role-labelled prose — never tool arguments, tool results, file contents or
 * environment values.
 */
export const DEFAULT_ASSESSMENT_MAX_INPUT_CHARS = 6000;

/**
 * Minimum share of the strongest routable candidate's intelligence index an
 * assessor must reach. A weak assessor produces expensive downstream
 * mistakes, so cheapest-and-fastest is not a sufficient rule.
 */
export const DEFAULT_ASSESSOR_QUALITY_RATIO = 0.5;
