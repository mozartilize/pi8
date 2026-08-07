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
/**
 * Default context-size threshold for depth escalation. A lightweight/gather
 * session whose live context grows past this is synthesizing over gathered
 * material, not just looking things up — route one tier up.
 */
export const DEFAULT_DEPTH_ESCALATION_TOKENS = 32768;

/**
 * One end-to-end assessment budget. Deliberately smaller than the old
 * 3000 ms auth race plus a separate stream deadline: the router may not add
 * perceptible latency to a turn, and in shadow mode it adds none at all
 * because the assessment is detached.
 */
export const DEFAULT_ASSESSMENT_DEADLINE_MS = 1500;

/**
 * Shadow-mode assessment budget. Shadow is detached — it adds zero wall-clock
 * to the turn — so the 1500 ms active budget (which exists only to bound
 * perceptible turn latency) has no reason to apply. The corpus showed 1500 ms
 * discarding every shadow verdict on a provider whose first token arrived
 * after the deadline (24/24 `expiry`, textChars:0). A generous shadow deadline
 * captures those verdicts at zero user cost; the wall clock via the
 * AbortController still enforces it, so a genuinely hung provider is bounded.
 */
export const DEFAULT_ASSESSMENT_SHADOW_DEADLINE_MS = 12000;

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
