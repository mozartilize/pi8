/**
 * Runtime feature mapping (`FEATURE_MAPPING_VERSION`): the single source of feature transforms,
 * missing-value intervals, central representatives and task relevances.
 *
 * These values are authored policy, not calibrated measurements. A change to
 * any of them is a feature-policy revision. If the change alters what a stored
 * preference scenario means, `preferences.version` must also increase. A
 * benchmark refresh changes candidate observations, never these mappings.
 * No caller may define its own normalization, default or relevance.
 */
import type { Dimension, ProvenanceAxis } from '../../types.js';

export const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

// ─── Cost ────────────────────────────────────────────────────────────

/** Lower end of the cost scale, USD. A cheaper or free action has desirability 1. */
export const COST_FLOOR_USD = 0.00001;
/** Decades of cost from the lower end to desirability 0, at $10. */
export const COST_DECADES = 6;

/**
 * Desirability of a predicted all-in USD cost for one decision: log10 of the
 * cost, linear over [$0.00001, $10]. The selector compares only differences,
 * so the difference of two actions depends only on their cost ratio: an action
 * at half the cost gains log10(2)/6 at any price level. A preference answer
 * about a relative saving then applies the same way to a $0.001 turn and a $1 turn.
 */
export function costDesirability(usd: number): number {
  if (usd <= COST_FLOOR_USD) return 1;
  return clamp01(1 - Math.log10(usd / COST_FLOOR_USD) / COST_DECADES);
}

// ─── Time ────────────────────────────────────────────────────────────

/** Fixed per-invocation overhead of the latency proxy, seconds. */
export const LATENCY_OVERHEAD_SECONDS = 2;
export const TIME_SHAPE_SECONDS = 5;
export const TIME_SATURATION_SECONDS = 300;

/**
 * Desirability of the output-dominant latency proxy `t = 2 + O / tps`.
 * This is not observed task wall time.
 */
export function timeDesirability(seconds: number): number {
  return clamp01(1 - Math.log(1 + seconds / TIME_SHAPE_SECONDS) / Math.log(1 + TIME_SATURATION_SECONDS / TIME_SHAPE_SECONDS));
}

export const latencyProxySeconds = (outputTokens: number, outputSpeedTps: number): number =>
  LATENCY_OVERHEAD_SECONDS + outputTokens / outputSpeedTps;

// ─── Demand of one next provider invocation ─────────────────────────

/**
 * Output tokens of one invocation at demand scale 1. Each value is
 * multiplied by the action's demand scale (`effortDemandScale`), so a higher
 * effort, or a model that writes more, costs more and takes longer when AA
 * measured that it does.
 */
export const OUTPUT_TOKENS_CENTRAL = 1024;
export const OUTPUT_TOKENS_MIN = 512;
export const OUTPUT_TOKENS_MAX = 4096;

/**
 * Output-equivalent tokens per AA task at demand scale 1. An authored
 * reference near the median of synchronized rows, not a measurement.
 */
export const REFERENCE_TOKENS_PER_TASK = 100_000;
/**
 * Demand-scale envelope of a model with no measured cost per task. It spans
 * the measured range, so missing evidence widens the cost and time intervals
 * and gives no advantage.
 */
export const DEMAND_SCALE_UNKNOWN_MIN = 0.05;
export const DEMAND_SCALE_UNKNOWN_MAX = 12;

// ─── Capability axes ─────────────────────────────────────────────────

/** AA Intelligence Index on a 0..100 scale. */
export const normalizeIntelligence = (index: number): number => clamp01(index / 100);
/** Terminal-Bench 4.0 Agentic Coding pass rate in percent. */
export const normalizeTerminalBench = (percent: number): number => clamp01(percent / 100);
/** AA-Briefcase rubric pass rate, already in [0, 1]. */
export const normalizeResearch = (rate: number): number => clamp01(rate);
/** AA-Omniscience Index on a -100..100 scale. */
export const normalizeKnowledge = (index: number): number => clamp01((index + 100) / 200);
/** LCR / MMMU-Pro correctness fraction, already in [0, 1]. */
export const normalizeFraction = (fraction: number): number => clamp01(fraction);

/** Research share of `researchFit`; Knowledge has the remainder. */
export const RESEARCH_SHARE = 0.75;
export const KNOWLEDGE_SHARE = 0.25;

/** Central representative of a missing [0, 1] metric. */
export const MISSING_REPRESENTATIVE = 0.5;
/** Common `inputFit` value when no input aspect is relevant; it cancels between candidates. */
export const INPUT_NOT_RELEVANT_VALUE = 0.5;
/** Common `costDesirability` value when the price is unknown. Not a USD estimate. */
export const PRICE_UNKNOWN_VALUE = 0.5;
/** Common `timeDesirability` value when the output speed is unknown. */
export const SPEED_UNKNOWN_VALUE = 0.5;

/**
 * Estimated context size from which long-context quality is relevant. This is
 * an input-shape relevance rule, not a model capability minimum.
 */
export const LONG_CONTEXT_RELEVANCE_TOKENS = 64_000;

// ─── Task relevance ──────────────────────────────────────────────────

export interface TaskRelevance {
  /** Reasoning relevance R. */
  reasoning: number;
  /** Agentic coding relevance D. */
  agentic: number;
  /** Research relevance H. */
  research: number;
}

export const PHASE_RELEVANCE: Readonly<Record<Dimension, TaskRelevance>> = {
  lightweight: { reasoning: 0.15, agentic: 0, research: 0.1 },
  gather: { reasoning: 0.4, agentic: 0, research: 1 },
  plan: { reasoning: 1, agentic: 0.25, research: 0.5 },
  implement: { reasoning: 0.6, agentic: 1, research: 0.15 },
  review: { reasoning: 1, agentic: 0.5, research: 0.8 },
};

/** Reasoning relevance when open decisions are explicitly observed (> 0). */
export const OPEN_DECISIONS_REASONING = 0.9;

// ─── Task difficulty ─────────────────────────────────────────────────

/** Capability targets use absolute normalized benchmark scales, not pool ranks. */
export const CAPABILITY_TARGETS: Readonly<Record<keyof TaskRelevance, readonly [number, number]>> = {
  reasoning: [0.2, 0.55],
  agentic: [0.01, 0.6],
  research: [0.25, 0.65],
};

/** Unknown demand uses the highest target without claiming that it was measured. */
export function capabilityTarget(axis: keyof TaskRelevance, difficulty: number | undefined): number {
  const [easy, hard] = CAPABILITY_TARGETS[axis];
  const demand = difficulty === undefined || !Number.isFinite(difficulty) ? 1 : clamp01(difficulty);
  return easy + (hard - easy) * demand;
}

/** A fixed shortfall spans the fit scale; raising the target must not divide away capability differences. */
export const CAPABILITY_SHORTFALL: Readonly<Record<keyof TaskRelevance, number>> = {
  reasoning: 0.15,
  agentic: 0.2,
  research: 0.2,
};

/** Meeting the target earns full fit. Missing it by the axis shortfall earns zero. */
export const capabilityFit = (quality: number, target: number, axis: keyof TaskRelevance): number =>
  clamp01(1 - Math.max(0, target - quality) / CAPABILITY_SHORTFALL[axis]);

// ─── Evidence required to compete ────────────────────────────────────

/**
 * Quality axes a model must have evidence for to be compared in a phase: the
 * axes this phase relies on most. Evidence means a measured value or a
 * same-metric, same-model, same-effort source estimate. A model without it
 * stays callable and stays in the fallback chain after every model with
 * evidence, but it is not compared by regret.
 * `lightweight` relies on no single axis.
 */
export const REQUIRED_EVIDENCE_AXES: Readonly<Record<Dimension, readonly ProvenanceAxis[]>> = {
  lightweight: [],
  gather: ['research'],
  plan: ['intelligence'],
  implement: ['intelligence', 'agenticCoding'],
  review: ['intelligence'],
};

// ─── Continuity, friction and recovery ───────────────────────────────

export const CONTINUITY = {
  /** Ordinary authorized boundary: same served model at any effort. */
  ordinarySameModel: 0.65,
  ordinaryDifferentModel: 0.45,
  /** Attributed rework boundary. */
  reworkSameModelHigherEffort: 0.78,
  reworkSameModelEqualOrLowerEffort: 0.65,
  reworkDifferentModel: 0.48,
  /** No incumbent or unknown identity: common to all actions. */
  unknown: 0.5,
} as const;

export const FRICTION = {
  attributedRework: 0,
  severeReasoningLoop: 0.25,
  none: 1,
} as const;
