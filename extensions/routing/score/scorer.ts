/**
 * Scorer — pure scoring + pickBest for model routing.
 *
 * Input: candidates + dimension + weights + optional incumbent state
 * Output: ordered fallback chain + RoutingDecision
 *
 * No I/O. No registry access. Testable with fixture tables.
 */
import type {
  Candidate,
  CandidateCapabilityMeta,
  Dimension,
  MultiWorkScoringPolicy,
  QualityExclusionReason,
  RoutingDecision,
  ScoreWeights,
} from '../../types.js';
import { DEFAULT_DIMENSION_WEIGHTS, DEFAULT_SWITCH_MARGIN } from '../../constants.js';
import { renderScoredReason, type ScoredReason } from './decision-reason.js';
import type { ModelThinkingLevel, ThinkingLevel, ThinkingLevelMap } from '@earendil-works/pi-ai';

// ─── Candidate identity ─────────────────────────────────────────────

/** Every level a bench row can be measured at; also the key-suffix alphabet. */
export const MODEL_THINKING_LEVELS: readonly ModelThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

const isModelThinkingLevel = (v: string): boolean =>
  (MODEL_THINKING_LEVELS as readonly string[]).includes(v);

/**
 * Identity of one routable entity: `provider/id` for an unmeasured model,
 * `provider/id:effort` for a measured (model, effort) pair. Two effort
 * variants of one model are two chain entries, two blacklist keys, two
 * incumbent keys.
 */
export function candidateKey(c: Pick<Candidate, 'registryId' | 'effort'>): string {
  return c.effort != null ? `${c.registryId}:${c.effort}` : c.registryId;
}

export interface ParsedCandidateKey {
  provider: string;
  id: string;
  effort?: ModelThinkingLevel;
}

/**
 * Reverse of {@link candidateKey}. The effort suffix is only split when it is
 * exactly one of the known levels, so ids that legitimately contain colons
 * (e.g. openrouter `deepseek/deepseek-r1:free`) parse fail-closed as ids.
 */
export function parseCandidateKey(key: string): ParsedCandidateKey {
  const colon = key.lastIndexOf(':');
  const effort =
    colon > 0 && isModelThinkingLevel(key.slice(colon + 1))
      ? (key.slice(colon + 1) as ModelThinkingLevel)
      : undefined;
  const base = effort != null ? key.slice(0, colon) : key;
  const slash = base.indexOf('/');
  if (slash <= 0) return { provider: base, id: base, ...(effort != null ? { effort } : {}) };
  return {
    provider: base.slice(0, slash),
    id: base.slice(slash + 1),
    ...(effort != null ? { effort } : {}),
  };
}

// ─── Per-dimension quality projection ───────────────────────────────

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/**
 * Ranking projection: maps a candidate's benchmark quality to the dimension's
 * preferred measurement axis. Falls back when the primary axis is missing so
 * every measured model sorts on real data instead of collapsing to the
 * unknown-quality default.
 *
 * `review` falls back from `coding` to `intelligence` because a model
 * measured on only one axis should still rank on evidence. This means a model
 * with `intelligence` but no direct `coding` measurement can receive a real
 * `qualityNorm` for ranking while simultaneously being tier 1 (unknown) for
 * eligibility — see `taskAxis` for the contrasting rule.
 */
function qualityForDimension(b: NonNullable<Candidate['bench']>, dim: Dimension): number | undefined {
  switch (dim) {
    case 'lightweight':
    case 'gather':
      return b.quality.intelligence;
    case 'plan':
      // Only `intelligence` is used: quality axes from different benchmark
      // sources are on different raw scales and must never be blended inside
      // one request-local ratio — doing so silently demotes a frontier model
      // measured by only one source.
      return b.quality.intelligence;
    case 'implement':
      return b.quality.agenticCoding ?? b.quality.coding;
    case 'review':
      return b.quality.coding ?? b.quality.intelligence;
  }
}

/**
 * Measured capability of a candidate for a dimension, or undefined when the
 * candidate carries no benchmark row on that dimension's axis. Exported so the
 * routing policy can compare an incumbent against a fresh pick without
 * duplicating the per-dimension axis mapping.
 */
export function capabilityForDimension(c: Candidate, dim: Dimension): number | undefined {
  return c.bench ? qualityForDimension(c.bench, dim) : undefined;
}

/** Live task-axis floor: a candidate must reach 85% of the strongest peer. */
export const FRONTIER_QUALITY_RATIO = 0.85;

/**
 * Absolute task floor for bounded economic promotion. Price can only relax the
 * frontier floor down to this measured capability threshold.
 */
export const ECONOMY_QUALITY_RATIO = 0.7;

/** Minimum broad capability required for implementation and review work. */
export const SANITY_QUALITY_RATIO = 0.45;

/**
 * AA-Omniscience's meaningful zero: correct answers equal incorrect answers.
 * A negative expected factual utility is unsafe for judgment-heavy work even
 * when broad capability benchmarks are strong.
 */
export const KNOWLEDGE_QUALITY_FLOOR = 0;

/**
 * Eligibility axis: the measurement the dimension's work directly depends on.
 * Deliberately does NOT fall back — eligibility requires direct evidence on
 * the work's axis. Contrast with `qualityForDimension`, which falls back so
 * ranking can use whatever measurement exists.
 */
function taskAxis(c: Candidate, dimension: Dimension): number | undefined {
  const quality = c.bench?.quality;
  if (!quality) return undefined;
  switch (dimension) {
    case 'lightweight':
    case 'gather':
      return quality.intelligence;
    case 'plan':
      // See the identical note in qualityForDimension: the cross-source
      // blending prohibition applies to eligibility gates, not just ranking.
      return quality.intelligence;
    case 'implement':
      return quality.agenticCoding ?? quality.coding;
    case 'review':
      return quality.coding;
  }
}

/** Broad capability is a sanity check for coding work, not a second frontier. */
function generalAxis(c: Candidate): number | undefined {
  const quality = c.bench?.quality;
  // Same cross-source blending prohibition as taskAxis and qualityForDimension.
  return quality?.intelligence;
}

/** A request-local capability projection used for eligibility and tie-breaking. */
export interface RelativeQuality {
  taskRatio: number;
  generalRatio?: number;
  bottleneck: number;
  mean: number;
}

const needsGeneralSanity = (dimension: Dimension): boolean =>
  dimension === 'implement' || dimension === 'review';

/**
 * Normalize task and, where relevant, general capability against the strongest
 * request-local peers. Benchmarks use different scales, so relative gaps are
 * more durable than absolute index values.
 */
export function relativeQualities(
  candidates: readonly Candidate[],
  dimension: Dimension,
): Map<string, RelativeQuality> {
  const tasks = new Map<string, number>();
  const generals = new Map<string, number>();
  for (const c of candidates) {
    const task = taskAxis(c, dimension);
    if (task != null) tasks.set(candidateKey(c), task);
    if (needsGeneralSanity(dimension)) {
      const general = generalAxis(c);
      if (general != null) generals.set(candidateKey(c), general);
    }
  }

  const result = new Map<string, RelativeQuality>();
  if (tasks.size === 0) return result;
  const taskMaximum = Math.max(...tasks.values());
  const generalMaximum = generals.size > 0 ? Math.max(...generals.values()) : undefined;

  for (const [candidateKey, task] of tasks) {
    const taskRatio = taskMaximum > 0 ? clamp(task / taskMaximum, 0, 1) : 1;
    const general = generals.get(candidateKey);
    const generalRatio = general == null || generalMaximum == null
      ? undefined
      : generalMaximum > 0 ? clamp(general / generalMaximum, 0, 1) : 1;
    const ratios = generalRatio == null ? [taskRatio] : [taskRatio, generalRatio];
    result.set(candidateKey, {
      taskRatio,
      ...(generalRatio == null ? {} : { generalRatio }),
      bottleneck: Math.min(...ratios),
      mean: ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length,
    });
  }
  return result;
}

/**
 * Capability tiers, served in ascending order. Every tier stays in the fallback
 * chain: a capability judgement controls the preferred model, never objective
 * failure recovery.
 */
type QualityTier = 0 | 1 | 2;

interface TierPolicy {
  /** Minimum task-axis ratio a known candidate must reach to stay in tier 0. */
  qualityRatio: number;
  /** Absolute AA-Omniscience floor when factual reliability is task-critical. */
  knowledgeFloor?: number;
  /** Whether unknown capability ranks with the eligible group or behind it. */
  unknownQualityTier: 'eligible' | 'after-known';
  /** Whether trivial work is also gated on the capability floor. */
  applyFloorToLightweight: boolean;
}

/**
 * The single live selection policy. Unknown quality follows known eligible
 * candidates but remains ahead of measured weak ones; trivial work is ungated.
 */
const LIVE_TIER_POLICY: TierPolicy = {
  qualityRatio: FRONTIER_QUALITY_RATIO,
  unknownQualityTier: 'after-known',
  applyFloorToLightweight: false,
};

/**
 * Price divisor for the bounded promotion band (§8.2): a below-floor
 * candidate must be at least this much cheaper than the cheapest normal
 * tier-0 candidate to earn a relaxed capability judgment.
 */
export const PROMOTION_PRICE_DIVISOR = 4;

interface Eligibility {
  tier: QualityTier;
  excludedReason?: QualityExclusionReason;
}

const unknownEligibility = (policy: TierPolicy): Eligibility => ({
  tier: policy.unknownQualityTier === 'eligible' ? 0 : 1,
  excludedReason: 'unknown-quality',
});

/**
 * Knowledge must describe the effort delegation will actually serve. A lower
 * nominal entry can be raised by the dimension floor (e.g. low reaches
 * medium on plan), so use an exact-effort sibling's measurement before the
 * entry's own.
 */
function effectiveKnowledge(
  candidate: Candidate,
  candidates: readonly Candidate[],
  dimension: Dimension,
): number | undefined {
  const floor = MIN_THINKING_BY_DIMENSION[dimension];
  const effectiveEffort = candidate.effort != null
    ? levelFrom(clampEffortToFloor(candidate.effort, dimension), candidate)
    : floor === 'off' ? undefined : levelFrom(floor, candidate);
  if (effectiveEffort != null) {
    const retained = candidate.knowledgeByEffort?.[effectiveEffort];
    if (retained != null) return retained;
    const exact = candidates.find((peer) =>
      peer.registryId === candidate.registryId
      && peer.effort === effectiveEffort
      && peer.bench?.quality.knowledge != null,
    );
    if (exact?.bench?.quality.knowledge != null) return exact.bench.quality.knowledge;
    // A nominal-effort measurement cannot stand in for a higher effort chosen
    // by the dimension floor; knowledge is never extrapolated across levels.
    if (candidate.effort != null && candidate.effort !== effectiveEffort) return undefined;
  }
  // No named effective effort means delegation uses the model's fixed/default
  // mode. A model-wide score describes that mode directly, including reasoning
  // models without effort controls; this is not cross-effort extrapolation.
  return candidate.bench?.quality.knowledge;
}

function eligibilityOf(
  relative: RelativeQuality | undefined,
  dimension: Dimension,
  policy: TierPolicy,
  knowledge: number | undefined,
): Eligibility {
  if (dimension === 'lightweight' && !policy.applyFloorToLightweight) return { tier: 0 };
  // A known failure on any required axis remains measured weak even when a
  // different required axis is missing. Uncertainty cannot erase evidence.
  if (policy.knowledgeFloor != null && knowledge != null && knowledge < policy.knowledgeFloor) {
    return { tier: 2, excludedReason: 'below-knowledge-floor' };
  }
  if (!relative) return unknownEligibility(policy);
  if (relative.taskRatio < policy.qualityRatio) {
    return { tier: 2, excludedReason: 'below-task-floor' };
  }
  if (needsGeneralSanity(dimension)) {
    if (relative.generalRatio == null) return unknownEligibility(policy);
    if (relative.generalRatio < SANITY_QUALITY_RATIO) {
      return { tier: 2, excludedReason: 'below-sanity-floor' };
    }
  }
  if (policy.knowledgeFloor != null && knowledge == null) return unknownEligibility(policy);
  return { tier: 0 };
}

// ─── Cost estimation helpers ─────────────────────────────────────────

/** Output-weighted blend (agents emit more than they read). */
const isNonNegativeFinite = (value: number | undefined): value is number =>
  value != null && Number.isFinite(value) && value >= 0;

function blend(input: number | undefined, output: number | undefined): number | undefined {
  if (input == null && output == null) return undefined;
  if (input == null) return output!;
  if (output == null) return input;
  return input * 0.25 + output * 0.75;
}

/** Complete input/output pricing used by request-shape economics. */
export function inputOutputPricePer1M(
  c: Candidate,
): { input: number; output: number } | undefined {
  const benchInput = c.bench?.priceInputPer1M;
  const benchOutput = c.bench?.priceOutputPer1M;
  const benchmarkPrice = Number.isFinite(benchInput)
    && Number.isFinite(benchOutput)
    && benchInput! >= 0
    && benchOutput! >= 0
    ? { input: benchInput!, output: benchOutput! }
    : undefined;

  if (c.cost) {
    const { input, output } = c.cost;
    // Registry pricing is provider-specific and authoritative, including free
    // variants of models whose provider-agnostic benchmark price is nonzero.
    // A bare custom 0/0 without benchmark identity remains unknown.
    if (
      Number.isFinite(input)
      && Number.isFinite(output)
      && input! >= 0
      && output! >= 0
      && (input !== 0 || output !== 0 || c.bench != null)
    ) {
      return { input: input!, output: output! };
    }
  }
  return benchmarkPrice;
}

/**
 * Blended price per 1M tokens.
 *
 * Pi's registry carries provider/model-specific rates, including cache pricing,
 * so it is authoritative when present. Benchmark pricing is only a fallback
 * for models whose registry entry is incomplete or unpriced.
 */
export function blendedPricePer1M(c: Candidate): number | undefined {
  const complete = inputOutputPricePer1M(c);
  if (complete) return blend(complete.input, complete.output);
  // Preserve partial benchmark fallback for generic serving economics. The
  // assessor-shaped formula requires both prices and therefore uses only the
  // complete helper above.
  const partialInput = c.bench?.priceInputPer1M;
  const partialOutput = c.bench?.priceOutputPer1M;
  if (partialInput != null && !isNonNegativeFinite(partialInput)) return undefined;
  if (partialOutput != null && !isNonNegativeFinite(partialOutput)) return undefined;
  const partial = blend(partialInput, partialOutput);
  return isNonNegativeFinite(partial) ? partial : undefined;
}

/**
 * Which cost scale a pickBest call compares on. `costPerTask` and blended
 * `$/1M` are different scales and must never be mixed inside one request-local
 * ratio — the same rule that keeps `intelligence` and `coding` out of a shared
 * ratio. Task cost is preferred when EVERY candidate carries it; mixed
 * coverage degrades to the coarser `$/1M` basis for the whole set rather than
 * silently comparing incomparable numbers.
 */
export function costSignal(candidates: readonly Candidate[]): 'task' | 'per-1m' {
  return candidates.length > 0
    && candidates.every((c) => isNonNegativeFinite(c.bench?.costPerTask))
    ? 'task'
    : 'per-1m';
}

/**
 * Log-normalize non-negative costs so one extreme outlier cannot compress the
 * useful differences among the rest. Unknown/invalid values stay undefined
 * and receive no cost credit. A zero-price model is a real endpoint of the
 * scale: shifting by the cheapest positive price keeps logs finite,
 * scale-invariant, and makes free strictly better than every paid candidate.
 */
export function logCostUtilities(
  costs: readonly (number | undefined)[],
): (number | undefined)[] {
  const known = costs.filter(
    (cost): cost is number => cost != null && Number.isFinite(cost) && cost >= 0,
  );
  if (known.length === 0) return costs.map(() => undefined);

  const min = Math.min(...known);
  const max = Math.max(...known);
  if (min === max) {
    return costs.map((cost) =>
      cost != null && Number.isFinite(cost) && cost >= 0 ? 1 : undefined,
    );
  }

  const positiveMinimum = min === 0
    ? Math.min(...known.filter((cost) => cost > 0))
    : 0;
  const shift = Number.isFinite(positiveMinimum) ? positiveMinimum : 0;
  const logMin = Math.log(min + shift);
  const logMax = Math.log(max + shift);
  const span = logMax - logMin;

  // Distinct finite costs can collapse to the same logarithm, or max + shift
  // can overflow. Linear normalization keeps the degenerate case finite and
  // preserves the only required ordering: cheaper costs never score lower.
  if (!Number.isFinite(span) || span <= 0) {
    const linearSpan = max - min;
    return costs.map((cost) => {
      if (cost == null || !Number.isFinite(cost) || cost < 0) return undefined;
      return clamp(1 - (cost - min) / linearSpan, 0, 1);
    });
  }

  return costs.map((cost) => {
    if (cost == null || !Number.isFinite(cost) || cost < 0) return undefined;
    return clamp(1 - (Math.log(cost + shift) - logMin) / span, 0, 1);
  });
}

// ─── Scoring ──────────────────────────────────────────────────────────

export interface ScoreOpts {
  estimatedContextTokens: number;
  /** Previous turn's chosen candidate key (`provider/id` or `provider/id:effort`). */
  incumbentRegistryId?: string;
  /** True if this is a subagent spawn (no cache to lose). */
  isSubagentSpawn?: boolean;
  /** Required vision support (from image attachments). */
  needsVision?: boolean;
  /** Maximum incumbent-retention bonus for mid-session model switches. */
  switchMargin?: number;
  /**
   * Tokens each candidate key's own prompt cache still holds for this
   * conversation: keys that served within the cache lifetime, with the
   * context they sent. Where effort is part of the cache key, this is all a
   * same-model effort change keeps. Absent grants an effort change no credit.
   */
  warmPrefixTokens?: ReadonlyMap<string, number>;
  /**
   * Request-local terminal/inspect floors for an eligible compound-implement
   * intent. Absent selects the current live tier/promotion constants
   * unchanged; with `executionMinimum`, the only inputs that change
   * eligibility parameters.
   */
  multiWorkPolicy?: MultiWorkScoringPolicy;
  /**
   * Implement-axis ratio an accepted execution contract requires of its
   * executor. Replaces the live frontier ratio; never combined with
   * `multiWorkPolicy`.
   */
  executionMinimum?: number;
}

export interface ScoredCandidate extends Candidate {
  score: number;
  qualityComponent: number;
  costComponent: number;
  speedComponent: number;
  switched: boolean;
  excludedReason?: QualityExclusionReason;
}

export function scoreCandidate(
  c: Candidate,
  dimension: Dimension,
  weights: ScoreWeights,
  opts: ScoreOpts,
): ScoredCandidate {
  let qualityNorm = 0;
  let qualityAvailable = false;
  if (c.bench) {
    const q = qualityForDimension(c.bench, dimension);
    if (q != null) {
      qualityNorm = clamp(q / 100, 0, 1);
      qualityAvailable = true;
    }
  }

  // Unknown quality: asymmetric — for hard dimensions, treat as high (route-up bias)
  if (!qualityAvailable) {
    if (dimension === 'plan' || dimension === 'review') {
      qualityNorm = 0.7; // route-up: assume decent capability
    } else if (dimension === 'implement') {
      qualityNorm = 0.5; // neutral
    } else {
      qualityNorm = 0.3; // gather/lightweight: be conservative but usable
    }
  }

  const costNorm = 1; // placeholder — normalized in pickBest across set

  // Speed: from benchmark or registry estimate
  let speedNorm = 0;
  if (c.bench?.outputSpeedTps) {
    speedNorm = clamp(c.bench.outputSpeedTps / 200, 0, 1); // 200 tps = max
  }

  // Raw score
  const qScore = qualityNorm * weights.quality;
  const cScore = costNorm * weights.cost;
  const sScore = speedNorm * weights.speed;

  const switched = opts.incumbentRegistryId != null && !opts.isSubagentSpawn
    ? candidateKey(c) !== opts.incumbentRegistryId
    : false;

  return { ...c, score: qScore + cScore + sScore, qualityComponent: qScore, costComponent: cScore, speedComponent: sScore, switched };
}

// ─── pickEscalation ───────────────────────────────────────────────────

/**
 * Whether a candidate is a valid route-up destination from the source attempt.
 * Same model ids may change provider, but only a strictly higher effort is a
 * stronger destination; different model ids remain eligible as alternatives.
 */
export function isValidEscalationCandidate(candidate: string, fromModel: string): boolean {
  if (candidate === fromModel) return false;
  const source = parseCandidateKey(fromModel);
  const destination = parseCandidateKey(candidate);
  // Different model ids are valid alternatives regardless of effort; this
  // policy is specifically about never replaying the same model at an equal
  // or lower effort through another provider.
  if (destination.id !== source.id) return true;
  // Same-model comparisons require measured effort on both sides. Missing
  // effort cannot prove a strict increase, so fail closed.
  if (source.effort == null || destination.effort == null) return false;
  return MODEL_THINKING_LEVELS.indexOf(destination.effort) > MODEL_THINKING_LEVELS.indexOf(source.effort);
}

/**
 * Resolve the struggling source's own candidate row from a live routable set.
 *
 * The served identity carries the effective effort (`provider/id:medium`) even
 * when the benchmark row that measured it is unsuffixed, so an exact key match
 * would silently lose the source's measured quality — and a comparison against
 * an unknown source cannot prove an upgrade. Match on the base `provider/id`
 * and prefer the exact effort variant when the set actually holds one.
 */
export function findSourceCandidate(
  candidates: readonly Candidate[],
  fromModel: string,
): Candidate | undefined {
  const exact = candidates.find((c) => candidateKey(c) === fromModel);
  if (exact) return exact;
  const parsed = parseCandidateKey(fromModel);
  const base = `${parsed.provider}/${parsed.id}`;
  const sameBase = candidates.filter((c) => c.registryId === base);
  if (parsed.effort != null) {
    const sameEffort = sameBase.find((c) => c.effort === parsed.effort);
    if (sameEffort) return sameEffort;
  }
  // Served identity carries effective effort (`provider/id:medium`) even when
  // the measured row is unsuffixed. A different effort variant is a different
  // measurement and cannot stand in for the source.
  return sameBase.find((c) => c.effort == null);
}

export interface StrongerCompareOpts {
  /** Explicit user/session thinking request, when it outranks labelled effort. */
  userReasoning?: ThinkingLevel;
  userReasoningOverride?: boolean;
  /** Pool used to resolve a sibling row at the effort that will actually serve. */
  candidates?: readonly Candidate[];
}

/**
 * Effort the candidate will actually serve after the dimension floor, the
 * model's support map, and an explicit user override. Same walk as
 * delegation's attempt resolution: labelled efforts go through `levelFrom`,
 * so a stronger-hop proof cannot use a labelled effort that will never be
 * sent.
 */
export function servedEffort(
  candidate: Pick<Candidate, 'effort' | 'reasoning' | 'thinkingLevelMap'>,
  dimension: Dimension,
  opts?: Pick<StrongerCompareOpts, 'userReasoning' | 'userReasoningOverride'>,
): ModelThinkingLevel | undefined {
  if (candidate.effort != null && !opts?.userReasoningOverride) {
    return levelFrom(clampEffortToFloor(candidate.effort, dimension), candidate);
  }
  return resolveThinkingLevel(candidate, opts?.userReasoning, dimension);
}

function destServingKey(
  dest: Candidate,
  dim: Dimension,
  opts?: StrongerCompareOpts,
): string {
  const effort = servedEffort(dest, dim, opts);
  if (effort == null) {
    // A reasoning model that cannot serve its labelled effort must not
    // look like a higher-effort hop. Non-reasoning labelled rows keep
    // their identity: effort there is the bench measurement, not a
    // thinking level the stream will send.
    return dest.reasoning ? dest.registryId : candidateKey(dest);
  }
  if (dest.effort === effort) return candidateKey(dest);
  return `${dest.registryId}:${effort}`;
}

function destAtServedEffort(
  dest: Candidate,
  dim: Dimension,
  opts?: StrongerCompareOpts,
): Candidate | undefined {
  const effort = servedEffort(dest, dim, opts);
  if (effort == null) {
    if (dest.effort == null || !dest.reasoning) return dest;
    return undefined;
  }
  if (dest.effort === effort) return dest;
  const sibling = opts?.candidates?.find(
    (candidate) => candidate.registryId === dest.registryId && candidate.effort === effort,
  );
  if (sibling) return sibling;
  // An unsuffixed row describes the model's served mode; a labelled row
  // at a different effort cannot stand in for the attempt that will run.
  return dest.effort == null ? dest : undefined;
}

/**
 * Whether dest is a strictly stronger serving pick than the struggling source.
 * Same model at higher effort counts. A different model must have measured
 * quality above the source on this dimension — unknown or estimated quality on
 * either side cannot prove an upgrade, so an unresolvable source fails closed.
 * Destination quality is the row for the effort that will actually serve,
 * not the labelled candidate effort.
 */
export function isStrictlyStrongerCandidate(
  dest: Candidate,
  fromModel: string,
  dim: Dimension,
  source?: Candidate,
  opts?: StrongerCompareOpts,
): boolean {
  const destKey = destServingKey(dest, dim, opts);
  if (!isValidEscalationCandidate(destKey, fromModel)) return false;
  const sourceParsed = parseCandidateKey(fromModel);
  const destParsed = parseCandidateKey(destKey);
  // Same model, and the guard above already proved a strictly higher effort.
  // More reasoning effort on the same weights is itself the capability
  // escalation, so this deliberately needs no benchmark comparison — the
  // effort ladder is the evidence. Unmeasured efforts would otherwise be
  // unreachable as destinations even when the model plainly supports them.
  if (destParsed.id === sourceParsed.id) return true;
  const measured = destAtServedEffort(dest, dim, opts);
  if (!measured) return false;
  const destQuality = capabilityForDimension(measured, dim);
  if (destQuality == null || measured.bench?.qualityEstimated === true) return false;
  if (!source || source.bench?.qualityEstimated === true) return false;
  const sourceQuality = capabilityForDimension(source, dim);
  if (sourceQuality == null) return false;
  return destQuality > sourceQuality;
}

/**
 * Pure same-dimension capability escalation: given the model that just
 * served the turn, pick a different candidate using quality-only weights.
 * This is intentionally narrow — it reuses `pickBest` for context/vision
 * guards and scoring so the behavior cannot drift from the normal path.
 */
export function pickEscalation(
  candidates: Candidate[],
  dimension: Dimension,
  fromModel: string,
  opts: ScoreOpts = { estimatedContextTokens: 0 },
): RoutingDecision | undefined {
  // Model route-up must increase capability, not merely change transport.
  const alternatives = candidates.filter((c) => isValidEscalationCandidate(candidateKey(c), fromModel));
  if (alternatives.length === 0) return undefined;

  const decision = pickBest(alternatives, dimension, { quality: 1, cost: 0, speed: 0 }, opts);
  return {
    ...decision,
    cause: 'capability-escalation',
    reason: `${decision.reason} [stronger than ${fromModel}]`,
  };
}

/**
 * Shared escalation target selection for both the between-turn repick and the
 * pre-output in-delegation hop. Apply context/vision guards, keep only the
 * strictly-stronger reachable candidates, then pick the *strongest* by quality
 * via `pickEscalation`. Both surfaces must land on the same target for the same
 * struggle, so selection lives here and cannot diverge: one scans the remaining
 * unattempted chain, the other the full routable set, but neither re-implements
 * "which stronger model". Returns `undefined` when nothing strictly stronger is
 * reachable — the caller owns the no-target policy (keep serving, never route
 * down on the struggle alone).
 */
export function escalationChain(
  candidates: readonly Candidate[],
  dimension: Dimension,
  fromModel: string,
  opts: ScoreOpts,
  compareOpts: StrongerCompareOpts,
): RoutingDecision | undefined {
  // `candidates` is the target pool (the pre-output hop passes only the
  // reachable, unattempted tail, which excludes the struggling source). The
  // source and any served-effort siblings must resolve against the full pool,
  // so prefer `compareOpts.candidates`; the between-turn caller passes the full
  // routable set as `candidates` and leaves `compareOpts.candidates` unset, so
  // the fallback keeps that path unchanged.
  const sourcePool = compareOpts.candidates ?? candidates;
  const source = findSourceCandidate(sourcePool, fromModel);
  const strongerOpts: StrongerCompareOpts = { ...compareOpts, candidates: sourcePool };
  const eligible = applyCandidateGuards([...candidates], opts);
  const stronger = eligible.filter((candidate) =>
    isStrictlyStrongerCandidate(candidate, fromModel, dimension, source, strongerOpts),
  );
  if (stronger.length === 0) return undefined;
  const picked = pickEscalation(stronger, dimension, fromModel, opts);
  if (!picked || picked.chosen === '') return undefined;
  return picked;
}

// ─── pickBest steps ───────────────────────────────────────────────────

/**
 * Drop models that cannot hold the estimated context, then prefer vision
 * when the turn carries an image. Both guards fail open: an empty context
 * filter keeps the single largest-window model; an empty vision filter keeps
 * the set. Blocking the turn is worse than a degraded route. No flag is set
 * here — the scorer is pure; the caller detects the image via `needsVision`
 * and owns any surfacing of a degraded vision route.
 */
export function applyCandidateGuards(
  candidates: Candidate[],
  opts: ScoreOpts,
): Candidate[] {
  let filtered = candidates;
  if (opts.estimatedContextTokens > 0) {
    const guardFiltered = filtered.filter((c) => {
      const win = c.contextWindow ?? 0;
      return win <= 0 || win >= opts.estimatedContextTokens * 1.2;
    });
    if (guardFiltered.length > 0) {
      filtered = guardFiltered;
    } else {
      const largest = [...filtered].sort((a, b) => (b.contextWindow ?? 0) - (a.contextWindow ?? 0))[0];
      if (largest) {
        filtered = [largest];
      }
    }
  }
  if (opts.needsVision) {
    const visionFiltered = filtered.filter((c) => c.vision);
    if (visionFiltered.length > 0) {
      filtered = visionFiltered;
    }
  }
  return filtered;
}

/**
 * Capability is an eligibility gate, not another weighted component: price
 * and speed may rank comparable models, but cannot offset a material quality
 * gap. Lower tiers stay in the chain as objective fallbacks.
 *
 * `multiWorkPolicy` changes only which parameters feed this single
 * eligibility/promotion implementation; its absence selects the current live
 * constants unchanged. Knowledge is task-critical for planning/review and for
 * the terminal phase of compound implementation. Activate its floor only when
 * the scoring pool has at least one measurement: absent coverage is
 * uncertainty, not proof that every model is weak.
 */
function computeEligibility(
  filtered: Candidate[],
  dimension: Dimension,
  opts: ScoreOpts,
) {
  const knowledgeCritical = dimension === 'plan'
    || dimension === 'review'
    || (dimension === 'implement' && opts.multiWorkPolicy != null);
  const knowledgeByCandidate = new Map(filtered.map((candidate) => [
    candidateKey(candidate),
    effectiveKnowledge(candidate, filtered, dimension),
  ]));
  const knowledgeAvailable = [...knowledgeByCandidate.values()].some((value) => value != null);
  const activeTierPolicy: TierPolicy = {
    ...LIVE_TIER_POLICY,
    ...(opts.multiWorkPolicy ? { qualityRatio: opts.multiWorkPolicy.terminalFloor } : {}),
    ...(opts.executionMinimum != null ? { qualityRatio: opts.executionMinimum } : {}),
    ...(knowledgeCritical && knowledgeAvailable ? { knowledgeFloor: KNOWLEDGE_QUALITY_FLOOR } : {}),
  };
  const activePromotionPolicy = opts.multiWorkPolicy
    ? {
        enabled: dimension === 'implement'
          && opts.multiWorkPolicy.inspectFloor < opts.multiWorkPolicy.terminalFloor,
        qualityRatio: opts.multiWorkPolicy.inspectFloor,
        recordsInspectPromotion: true,
      }
    : {
        enabled: dimension === 'gather' || dimension === 'implement' || dimension === 'review',
        qualityRatio: ECONOMY_QUALITY_RATIO,
        recordsInspectPromotion: false,
      };

  const relative = relativeQualities(filtered, dimension);
  const eligibility = new Map<string, Eligibility>(
    filtered.map((c) => [
      candidateKey(c),
      eligibilityOf(
        relative.get(candidateKey(c)),
        dimension,
        activeTierPolicy,
        knowledgeByCandidate.get(candidateKey(c)),
      ),
    ]),
  );
  return {
    knowledgeByCandidate,
    activeTierPolicy,
    activePromotionPolicy,
    relative,
    eligibility,
    terminalEligibility: new Map(eligibility),
  };
}

/**
 * A near-frontier candidate may earn tier 0 only when economics provide a
 * material benefit and no cheaper peer already offers at least its task axis.
 * Plan is pure judgment, so its frontier remains intentionally unrelaxed.
 * Promotion relaxes the capability floor on economic grounds; an estimated
 * row already claims capability it was never measured at, so promotion stays
 * measured-evidence only (`qualityEstimated !== true`).
 */
function applyEconomicPromotion(
  filtered: Candidate[],
  dimension: Dimension,
  eligibility: Map<string, Eligibility>,
  inspectPromoted: Set<string>,
  relative: ReturnType<typeof relativeQualities>,
  knowledgeByCandidate: Map<string, number | undefined>,
  activeTierPolicy: TierPolicy,
  activePromotionPolicy: {
    enabled: boolean;
    qualityRatio: number;
    recordsInspectPromotion: boolean;
  },
  costOf: (c: Candidate) => number | undefined,
): void {
  if (!activePromotionPolicy.enabled) return;
  const eligiblePrices = filtered
    .filter((c) => eligibility.get(candidateKey(c))?.tier === 0 && relative.has(candidateKey(c)))
    .map(costOf)
    .filter((price): price is number => price != null);
  const cheapestEligiblePrice = eligiblePrices.length > 0 ? Math.min(...eligiblePrices) : undefined;
  if (cheapestEligiblePrice == null) return;

  for (const c of filtered) {
    const current = eligibility.get(candidateKey(c))!;
    const quality = relative.get(candidateKey(c));
    const price = costOf(c);
    const task = taskAxis(c, dimension);
    const sanitySatisfied = !needsGeneralSanity(dimension)
      || (quality?.generalRatio != null && quality.generalRatio >= SANITY_QUALITY_RATIO);
    const knowledge = knowledgeByCandidate.get(candidateKey(c));
    const knowledgeSatisfied = activeTierPolicy.knowledgeFloor == null
      || (knowledge != null && knowledge >= activeTierPolicy.knowledgeFloor);
    const dominated = task == null || price == null || filtered.some((peer) => {
      if (candidateKey(peer) === candidateKey(c)) return false;
      // A sibling provider entry of the same benchmark row is a substitute,
      // not a competitor: promoting only the cheapest copy pushes the
      // identical model on every other provider below unknown-quality
      // candidates in the fallback chain, which is the opposite of what a
      // cheap-and-capable finding should do. Effort variants of one model
      // are NOT siblings — their rows are different measurements.
      if (peer.bench?.benchSlug != null && peer.bench.benchSlug === c.bench?.benchSlug) return false;
      const peerTask = taskAxis(peer, dimension);
      const peerPrice = costOf(peer);
      return peerTask != null && peerTask >= task && peerPrice != null && peerPrice < price;
    });
    if (
      current.tier === 2
      && quality != null
      && c.bench?.qualityEstimated !== true
      && quality.taskRatio >= activePromotionPolicy.qualityRatio
      && sanitySatisfied
      && knowledgeSatisfied
      && price != null
      && price <= cheapestEligiblePrice / PROMOTION_PRICE_DIVISOR
      && !dominated
    ) {
      eligibility.set(candidateKey(c), { tier: 0, excludedReason: 'promoted' });
      if (activePromotionPolicy.recordsInspectPromotion) {
        inspectPromoted.add(candidateKey(c));
      }
    }
  }
}

/**
 * Score all candidates. Cost is meaningful only among candidates in the same
 * capability tier; weaker fallback prices must not distort the preferred
 * tier. Economic promotion continues to compare raw prices on `costOf`.
 */
function scoreWithinTiers(
  filtered: Candidate[],
  dimension: Dimension,
  weights: ScoreWeights,
  opts: ScoreOpts,
  eligibility: Map<string, Eligibility>,
  costOf: (c: Candidate) => number | undefined,
): ScoredCandidate[] {
  const costUtilities = new Map<string, number | undefined>();
  for (const tier of [0, 1, 2] as const) {
    const peers = filtered.filter((candidate) => eligibility.get(candidateKey(candidate))!.tier === tier);
    const utilities = logCostUtilities(peers.map(costOf));
    peers.forEach((candidate, index) => {
      costUtilities.set(candidateKey(candidate), utilities[index]);
    });
  }

  return filtered.map((c) => {
    const s = scoreCandidate(c, dimension, weights, opts);
    s.excludedReason = eligibility.get(candidateKey(s))?.excludedReason;
    const costUtility = costUtilities.get(candidateKey(c));
    s.costComponent = costUtility == null ? 0 : costUtility * weights.cost;
    s.score = s.qualityComponent + s.costComponent + s.speedComponent;
    return s;
  });
}

/**
 * A mid-session switch away from the incumbent must beat it on the merits,
 * priced by the cache the incumbent's OWN registry economics say would
 * actually be lost. When the incumbent's registry entry does not publish
 * enough pricing to compute a real loss, no retention credit is granted —
 * an unpriced incumbent is scored on ordinary quality/cost/speed merits.
 *
 * A full model change preserves none of the cache (credit 0); the exact
 * incumbent match preserves all of it. A same-model effort change keeps all
 * of it only where effort shares the model's cache; elsewhere each effort
 * level has its own cache (OpenAI reports `reasoning_effort_changed`, and
 * top-level Anthropic effort invalidates the message blocks), so the credit
 * covers only the prefix that level's cache still holds from a recent serve.
 * A same-model candidate with no measured effort is the model's default call
 * shape and keeps the full credit like an exact incumbent match.
 */
function applySwitchBonus(scored: ScoredCandidate[], opts: ScoreOpts): void {
  if (!opts.incumbentRegistryId || opts.isSubagentSpawn) return;
  const margin = clamp(opts.switchMargin ?? DEFAULT_SWITCH_MARGIN, 0, 1);
  const incumbent = parseCandidateKey(opts.incumbentRegistryId);
  const incumbentScored = scored.find((s) => candidateKey(s) === opts.incumbentRegistryId);
  const total = Math.max(1, opts.estimatedContextTokens);

  const incumbentCost = incumbentScored?.cost;
  // A non-finite or negative cost field is garbage the registry never emits,
  // but if one slips through it must not poison the score: NaN
  // propagates through Math.max/Math.min and would surface as a `scored NaN`
  // decision. Fall back to `input` only when `cacheWrite` is unusable, and
  // drop retention credit entirely unless both endpoints are real prices.
  const cacheWrite = incumbentCost?.cacheWrite;
  const writeBasis = isNonNegativeFinite(cacheWrite) ? cacheWrite : incumbentCost?.input;
  const cacheRead = incumbentCost?.cacheRead;
  const perTokenLoss = isNonNegativeFinite(writeBasis) && isNonNegativeFinite(cacheRead)
    ? Math.max(0, writeBasis - cacheRead)
    : undefined;

  if (perTokenLoss == null) return;
  const modelChangeBonus = Math.min(total * perTokenLoss, margin);
  for (const s of scored) {
    const key = candidateKey(s);
    if (key === opts.incumbentRegistryId) {
      s.score += modelChangeBonus;
      s.switched = false;
      continue;
    }
    const p = parseCandidateKey(key);
    if (p.provider !== incumbent.provider || p.id !== incumbent.id) continue;
    if (p.effort == null || s.effortSharesCache) {
      s.score += modelChangeBonus;
      continue;
    }
    const warm = clamp(opts.warmPrefixTokens?.get(key) ?? 0, 0, total);
    s.score += Math.min(warm * perTokenLoss, margin);
  }
}

/**
 * Sort by economics inside each capability tier, then keep every weaker
 * model behind the eligible group for delegation fallback. After an
 * asymmetric promotion `top` is no longer `scored[0]`; the delegation loop
 * serves fallbackChain[0], so the chain MUST lead with the promoted pick.
 * Keep `chosen === fallbackChain[0]`.
 */
function assembleDecision(
  scored: ScoredCandidate[],
  filtered: Candidate[],
  dimension: Dimension,
  eligibility: Map<string, Eligibility>,
  relative: ReturnType<typeof relativeQualities>,
  terminalEligibility: Map<string, Eligibility>,
  inspectPromoted: Set<string>,
  costBasis: 'task' | 'per-1m',
  opts: ScoreOpts,
): RoutingDecision {
  const compareScore = (a: ScoredCandidate, b: ScoredCandidate): number => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.qualityComponent !== a.qualityComponent) {
      return b.qualityComponent - a.qualityComponent;
    }
    const ra = relative.get(candidateKey(a));
    const rb = relative.get(candidateKey(b));
    if (ra && rb) {
      if (rb.bottleneck !== ra.bottleneck) return rb.bottleneck - ra.bottleneck;
      if (rb.mean !== ra.mean) return rb.mean - ra.mean;
    }
    const speedA = a.bench?.outputSpeedTps ?? 0;
    const speedB = b.bench?.outputSpeedTps ?? 0;
    if (speedB !== speedA) return speedB - speedA;
    return candidateKey(a).localeCompare(candidateKey(b));
  };
  scored.sort((a, b) => (eligibility.get(candidateKey(a))!.tier - eligibility.get(candidateKey(b))!.tier) || compareScore(a, b));

  let top = scored[0];
  let routedUp = false;

  // Structural no-op for plan/review: tier strictly dominates the sort, so a
  // tier-0 candidate always sorts to `top` when one exists. Tier 0 for
  // plan/review requires `taskAxis`, and `qualityForDimension` is defined
  // whenever `taskAxis` is (superset relation), so this body runs only when no
  // tier-0 candidate exists — in which case the search below returns undefined
  // and `top` is left unchanged. Kept for `routedUp` bookkeeping and as a
  // documented invariant, not an active promotion path.
  if (dimension === 'plan' || dimension === 'review') {
    if (!top.bench || qualityForDimension(top.bench, dimension) == null) {
      routedUp = true;
      const known = scored.find(
        (s) => eligibility.get(candidateKey(s))!.tier === 0 && s.bench && qualityForDimension(s.bench, dimension) != null,
      );
      if (known && candidateKey(known) !== candidateKey(top)) {
        top = known;
      }
    }
  }

  const fallbackChain = scored.map((s) => candidateKey(s));
  const topIndex = fallbackChain.indexOf(candidateKey(top));
  if (topIndex > 0) {
    fallbackChain.splice(topIndex, 1);
    fallbackChain.unshift(candidateKey(top));
  }

  const candidateDiagnostics = scored
    .filter((candidate) => candidate.excludedReason != null)
    .map((s) => ({ candidateKey: candidateKey(s), excludedReason: s.excludedReason }));

  const multiWorkPolicy = opts.multiWorkPolicy;
  const multiWork = multiWorkPolicy
    ? {
        ...multiWorkPolicy,
        candidateCapability: Object.fromEntries(filtered.map((c): [string, CandidateCapabilityMeta] => {
          const key = candidateKey(c);
          const quality = relative.get(key);
          const terminalTier = terminalEligibility.get(key)?.tier;
          const clears: boolean | 'unknown' = terminalTier === 0
            ? true
            : terminalTier === 1 ? 'unknown' : false;
          return [key, {
            ...(quality ? { taskRatio: quality.taskRatio } : {}),
            clearsTerminalFloor: clears,
            viaInspectPromotion: inspectPromoted.has(key),
          }];
        })),
        terminalCapableInScoringSet: filtered.some((c) => terminalEligibility.get(candidateKey(c))?.tier === 0),
      }
    : undefined;

  const scoredReason: ScoredReason = {
    score: top.score,
    quality: top.qualityComponent,
    cost: top.costComponent,
    speed: top.speedComponent,
    costBasis,
    upgraded: routedUp,
    details: [],
  };
  return {
    dimension,
    chosen: candidateKey(top),
    reason: renderScoredReason(scoredReason),
    scoredReason,
    ...(candidateDiagnostics.length > 0 ? { candidateDiagnostics } : {}),
    confidence: 0.8, // placeholder — overwritten by classifier
    routedUp,
    routedDown: false,
    cause: 'heuristic',
    fallbackChain,
    ...(multiWork ? { multiWork } : {}),
  };
}

// ─── pickBest ─────────────────────────────────────────────────────────

export function pickBest(
  candidates: Candidate[],
  dimension: Dimension,
  weights: ScoreWeights = DEFAULT_DIMENSION_WEIGHTS[dimension],
  opts: ScoreOpts = { estimatedContextTokens: 0 },
): RoutingDecision {
  const filtered = applyCandidateGuards(candidates, opts);
  const {
    knowledgeByCandidate,
    activeTierPolicy,
    activePromotionPolicy,
    relative,
    eligibility,
    terminalEligibility,
  } = computeEligibility(filtered, dimension, opts);
  const inspectPromoted = new Set<string>();

  // Request-local cost scale, chosen once for this pickBest call. Task cost is
  // used only when every candidate in the pool that can actually win carries
  // it; otherwise that pool compares on blended $/1M. Scoped to the
  // pre-promotion tier-0 pool (not the full filtered set) so a low-quality
  // candidate that never competes for the win — tier 2, e.g. a below-floor
  // model missing costPerTask — can't blind an otherwise task-cost-covered
  // competitive group to effort-aware pricing (same-model higher-effort
  // variants share the same $/1M rate, so a per-1M fallback can't tell them
  // apart even though costPerTask does).
  const tierZeroPool = filtered.filter((c) => eligibility.get(candidateKey(c))?.tier === 0);
  const costBasis = costSignal(tierZeroPool.length > 0 ? tierZeroPool : filtered);
  const costOf = (c: Candidate): number | undefined => {
    const cost = costBasis === 'task' ? c.bench?.costPerTask : blendedPricePer1M(c);
    return isNonNegativeFinite(cost) ? cost : undefined;
  };

  applyEconomicPromotion(
    filtered,
    dimension,
    eligibility,
    inspectPromoted,
    relative,
    knowledgeByCandidate,
    activeTierPolicy,
    activePromotionPolicy,
    costOf,
  );

  const scored = scoreWithinTiers(
    filtered,
    dimension,
    weights,
    opts,
    eligibility,
    costOf,
  );
  applySwitchBonus(scored, opts);
  return assembleDecision(
    scored,
    filtered,
    dimension,
    eligibility,
    relative,
    terminalEligibility,
    inspectPromoted,
    costBasis,
    opts,
  );
}

const THINKING_LEVELS: ModelThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Minimum reasoning effort per dimension — a FLOOR, not an assignment. The
 * scorer may serve any measured effort at or above it (a scored
 * effort may raise the floor, never lower it). A model with no measurement
 * at or above the floor keeps today's behavior: send the floor level,
 * clamped by thinkingLevelMap.
 */
const MIN_THINKING_BY_DIMENSION: Record<Dimension, ThinkingLevel | 'off'> = {
  lightweight: 'off',
  gather: 'low',
  plan: 'medium',
  implement: 'medium',
  review: 'medium',
};

function isThinkingSupported(
  c: Pick<Candidate, 'reasoning' | 'thinkingLevelMap'> | undefined,
  level: ModelThinkingLevel,
): boolean {
  if (!c?.reasoning) return false;
  if (level === 'off') return true;
  const map = c.thinkingLevelMap;
  if (!map) return level !== 'xhigh' && level !== 'max';
  const mapped = map[level];
  if (level === 'xhigh' || level === 'max') return mapped != null;
  return mapped !== null;
}

export function isThinkingSupportedByRegistryModel(
  c: Pick<RegistryModelInfo, 'reasoning' | 'thinkingLevelMap'> | undefined,
  level: ModelThinkingLevel,
): boolean {
  if (!c?.reasoning) return false;
  if (level === 'off') return true;
  const map = c.thinkingLevelMap;
  if (!map) return level !== 'xhigh' && level !== 'max';
  const mapped = map[level];
  if (level === 'xhigh' || level === 'max') return mapped != null;
  return mapped !== null;
}

export function levelFrom(
  level: ModelThinkingLevel,
  c: Pick<Candidate, 'reasoning' | 'thinkingLevelMap'>,
): ModelThinkingLevel | undefined {
  const start = THINKING_LEVELS.indexOf(level);
  for (let i = start; i < THINKING_LEVELS.length; i++) {
    const l = THINKING_LEVELS[i]!;
    if (isThinkingSupported(c, l)) return l;
  }
  return undefined;
}

/**
 * Raise a measured effort to the dimension floor when it sits below it. The
 * floor is the only downward protection on the effort axis; scoring
 * already guarantees chain entries respect it, so this is defense in depth
 * for the delegation loop.
 */
export function clampEffortToFloor(
  effort: ModelThinkingLevel,
  dimension: Dimension,
): ModelThinkingLevel {
  const floor = MIN_THINKING_BY_DIMENSION[dimension];
  const effortIdx = THINKING_LEVELS.indexOf(effort);
  const floorIdx = THINKING_LEVELS.indexOf(floor);
  return effortIdx >= floorIdx ? effort : floor;
}

export function chooseThinkingLevel(
  c: Candidate | undefined,
  dimension: Dimension,
): ModelThinkingLevel | undefined {
  if (!c?.reasoning) return undefined;
  const floor = MIN_THINKING_BY_DIMENSION[dimension];
  // A measured effort at or above the dimension floor is the router's choice;
  // below the floor it is raised to the floor, never sent as-is.
  if (c.effort != null) {
    return levelFrom(clampEffortToFloor(c.effort, dimension), c);
  }
  if (floor === 'off') return undefined;
  return levelFrom(floor, c);
}

export function resolveThinkingLevel(
  c: Pick<Candidate, 'reasoning' | 'thinkingLevelMap'> | undefined,
  requested: ThinkingLevel | undefined,
  dimension: Dimension,
): ModelThinkingLevel | undefined {
  if (!c?.reasoning) return undefined;
  if (requested) {
    const index = THINKING_LEVELS.indexOf(requested as ModelThinkingLevel);
    if (index >= 0) {
      for (let offset = 0; offset < THINKING_LEVELS.length; offset++) {
        const up = index + offset;
        if (up < THINKING_LEVELS.length) {
          const level = THINKING_LEVELS[up]!;
          if (isThinkingSupported(c, level)) return level;
        }
        const down = index - offset;
        if (down >= 0) {
          const level = THINKING_LEVELS[down]!;
          if (isThinkingSupported(c, level)) return level;
        }
      }
    }
    return undefined;
  }
  return chooseThinkingLevel(c as Candidate | undefined, dimension);
}

export function buildRouterThinkingLevelMap(
  models: readonly RegistryModelInfo[],
): ThinkingLevelMap {
  const map: Partial<Record<ModelThinkingLevel, string | null>> = {};
  for (const level of THINKING_LEVELS) {
    map[level] = models.some((m) => isThinkingSupportedByRegistryModel(m as Pick<RegistryModelInfo, 'reasoning' | 'thinkingLevelMap'>, level))
      ? level
      : null;
  }
  return map as ThinkingLevelMap;
}

// ─── Build candidates from registry + store ───────────────────────────

export interface RegistryModelInfo {
  provider: string;
  id: string;
  api?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  input?: readonly ('text' | 'image')[];
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  /** API-specific compatibility flags; only `supportsMidConvoEffort` is read. */
  compat?: object;
}

export function buildCandidate(
  model: RegistryModelInfo,
  bench?: Candidate['bench'],
): Candidate {
  return {
    registryId: `${model.provider}/${model.id}`,
    provider: model.provider,
    id: model.id,
    bench,
    // A candidate built from an effort-labelled row serves at exactly that
    // measured effort; a candidate without a bench row (or with an unlabelled
    // row) carries no effort and the dimension floor applies.
    effort: bench?.effort,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    vision: model.input?.includes('image') ?? false,
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
    // pi-ai sends effort per message only on these models, which keeps the
    // cached prefix; every other call path sets effort on the request.
    ...(model.api === 'anthropic-messages' &&
      (model.compat as { supportsMidConvoEffort?: unknown } | undefined)?.supportsMidConvoEffort === true
      ? { effortSharesCache: true }
      : {}),
    cost: model.cost,
    available: true,
  };
}
