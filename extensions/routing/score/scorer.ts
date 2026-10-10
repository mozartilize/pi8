/**
 * Scorer — pure scoring + pickBest for model routing.
 *
 * Input: candidates + dimension + weights + optional incumbent state
 * Output: ordered fallback chain + RoutingDecision
 *
 * No I/O. No registry access. Testable with fixture tables.
 */
import { createHash } from 'node:crypto';
import { identityKey } from '../../bench/matcher.js';
import type {
  CapabilityBand,
  BenchModel,
  Candidate,
  Dimension,
  ExactQuality,
  QualityAxis,
  QualityExclusionReason,
  RoutingDecision,
  ScoreWeights,
} from '../../types.js';
import { DEFAULT_DIMENSION_WEIGHTS, DEFAULT_SWITCH_MARGIN } from '../../constants.js';
import { renderScoredReason, type ScoredReason } from './decision-reason.js';
import type { PolicyVersion } from '../policy/policy-version.js';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
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
 * Ranking axis: the measurement a candidate's quality credit is read from.
 * The development comparator uses Intelligence at every requirement.
 * Production implementation uses the requirement-selected axis, with coding
 * as a ranking-only fallback. Missing required measurements remain unknown.
 */
function rankingAxis(dim: Dimension, requirement?: number, version: PolicyVersion = 'legacy'): 'agenticIndex' | 'agenticCoding' | 'intelligence' {
  if (version === 'cheapest-sufficient' || dim !== 'implement') return 'intelligence';
  return requirement != null && requirement < 0.45 ? 'agenticIndex' : 'agenticCoding';
}

function qualityForDimension(b: NonNullable<Candidate['bench']>, dim: Dimension, requirement?: number, version: PolicyVersion = 'legacy'): number | undefined {
  const measured = b.quality[rankingAxis(dim, requirement, version)];
  return version === 'legacy' && dim === 'implement' ? measured ?? b.quality.coding : measured;
}

/**
 * Measured capability of a candidate for a dimension, or undefined when the
 * candidate carries no benchmark row on that dimension's axis. Exported so the
 * routing policy can compare an incumbent against a fresh pick without
 * duplicating the per-dimension axis mapping.
 */
export function capabilityForDimension(c: Candidate, dim: Dimension, version: PolicyVersion = 'legacy'): number | undefined {
  const value = c.bench ? qualityForDimension(c.bench, dim, undefined, version) : undefined;
  return value != null && Number.isFinite(value) ? value : undefined;
}

type Minimums = Readonly<Partial<Record<QualityAxis, number>>>;

/**
 * Fixed capability minimums for a task type, on Artificial Analysis
 * Intelligence Index v4.3 scales, calibrated on 2026-10-02 against the models
 * the router serves. AA rescales its indexes between versions: a new version
 * needs a new calibration here.
 *
 * - gather: intelligence 20 keeps out mini and non-reasoning variants.
 * - plan, review: intelligence 30; Omniscience 0, so the model states facts
 *   right at least as often as wrong; AA-Briefcase rubric 0.35, so its work
 *   from many source files holds up when checked.
 * - implement: agentic coding 34, the Terminal-Bench 4.0 pass rate in
 *   percent (calibrated on 2026-10-08). 34 is 0.53 of the reference, so the
 *   default implement requirement stays in the standard band. Explicit
 *   requirements below 0.45 use the AA Agentic Index for eligibility and
 *   ranking. Default and higher requirements use Terminal-Bench 4.0.
 * - lightweight: none; trivial work goes to the cheapest model.
 */
const CAPABILITY_MINIMUMS: Readonly<Record<Dimension, Minimums>> = {
  lightweight: {},
  gather: { intelligence: 20 },
  plan: { intelligence: 30, knowledge: 0, research: 0.35 },
  review: { intelligence: 30, knowledge: 0, research: 0.35 },
  implement: { agenticCoding: 34 },
};

/**
 * Strongest value measured on each axis when `CAPABILITY_MINIMUMS` was
 * calibrated. A handoff requirement is a share of these, so the difficulty
 * scale means the same in every request, whatever models the pool holds.
 */
export const AXIS_REFERENCE: Readonly<Record<Exclude<QualityAxis, 'knowledge'>, number>> = {
  intelligence: 57.6,
  coding: 78.3,
  agenticCoding: 63.6,
  agenticIndex: 57.9,
  research: 0.61,
  longContext: 1,
  visionReasoning: 1,
};

/** The Intelligence Index major.minor version that the minimums above are calibrated for. */
export const CALIBRATED_INDEX_VERSION = '4.3';

/**
 * Development comparator parameters. Independent outcomes must validate sufficiency before activation.
 * The implement minimum is 65% of the Intelligence reference (37.4). A fixed model at
 * Intelligence 38 completed 9 of 10 repository bug fixes from a full bug report. No model below
 * that level has a measured result on the same tasks.
 */
const COMPARATOR_MINIMUMS: Readonly<Record<Dimension, Minimums>> = {
  ...CAPABILITY_MINIMUMS,
  implement: { intelligence: 0.65 * AXIS_REFERENCE.intelligence },
};
const COMPARATOR_DIGEST = createHash('sha256').update(JSON.stringify({
  version: 'intelligence-comparator-v1',
  metricVersion: CALIBRATED_INDEX_VERSION,
  fixedMinimums: COMPARATOR_MINIMUMS,
  references: AXIS_REFERENCE,
  mapping: 'clamped-requirement-times-reference;knowledge-fixed',
  comparisonAxis: 'intelligence',
  componentRules: [],
  inputMinimums: { contextTokens: 64_000, longContext: 0.30, visionReasoning: 0.30 },
})).digest('hex');

/**
 * A warning when the synced index version is not the calibrated version.
 * A new version can change evaluations and scales, but the user chose to
 * keep routing: the warning asks for a recalibration and does not block.
 */
export function indexVersionWarning(version: string | undefined): string | undefined {
  const reported = version?.trim().replace(/^v/i, '').split('.').slice(0, 2).join('.');
  if (reported === CALIBRATED_INDEX_VERSION) return undefined;
  return `Artificial Analysis Intelligence Index ${reported ? `version ${reported}` : 'version is not reported'}. `
    + `The capability minimums are calibrated for version ${CALIBRATED_INDEX_VERSION}. Routing continues with these minimums.`;
}

/** The strongest handoff requirement: the work keeps a model near the reference. */
export const FRONTIER_REQUIREMENT = 0.85;

/**
 * The task type's fixed minimums of the policy as one requirement: the largest
 * share of an axis reference among them. The Omniscience minimum is not a
 * share of a reference, so it does not count.
 */
export function defaultRequirement(dimension: Dimension, version: PolicyVersion = 'legacy'): number {
  const fixed = (version === 'cheapest-sufficient' ? COMPARATOR_MINIMUMS : CAPABILITY_MINIMUMS)[dimension];
  const shares = (Object.keys(fixed) as QualityAxis[])
    .filter((axis): axis is Exclude<QualityAxis, 'knowledge'> => axis !== 'knowledge')
    .map((axis) => fixed[axis]! / AXIS_REFERENCE[axis]);
  return Math.max(0, ...shares);
}

/**
 * The minimums a candidate must meet. Without a handoff, the task type's
 * fixed minimums. A handoff requirement replaces each axis with that share of
 * the reference, on the same axes. The Omniscience minimum does not scale:
 * zero is where wrong answers start to outnumber right ones, not a level of
 * strength.
 */
function minimumsFor(dimension: Dimension, requirement?: number, version: PolicyVersion = 'legacy'): Minimums {
  const fixed = (version === 'cheapest-sufficient' ? COMPARATOR_MINIMUMS : CAPABILITY_MINIMUMS)[dimension];
  if (requirement == null) return fixed;
  // An explicit requirement below 0.45 selects the AA Agentic Index.
  // Default and higher requirements keep Terminal-Bench 4.0.
  if (rankingAxis(dimension, requirement, version) === 'agenticIndex') {
    return { agenticIndex: clamp(requirement, 0, 1) * AXIS_REFERENCE.agenticIndex };
  }
  return Object.fromEntries(
    (Object.keys(fixed) as QualityAxis[]).map((axis) => [
      axis,
      axis === 'knowledge' ? fixed.knowledge : clamp(requirement, 0, 1) * AXIS_REFERENCE[axis],
    ]),
  );
}

/**
 * Capability tiers, served in ascending order: 0 meets every minimum, 1 lacks
 * a measurement, 2 measured below a minimum. Every tier stays in the fallback
 * chain: a capability judgement controls the preferred model, never objective
 * failure recovery.
 */
type QualityTier = 0 | 1 | 2;

interface Eligibility {
  tier: QualityTier;
  excludedReason?: QualityExclusionReason;
}

/**
 * Exact-effort axes at the effort delegation will serve. A gap in the
 * model's thinking-level map can raise a candidate's own effort, and these
 * axes are never estimated across efforts, so another effort's measurement
 * never stands in for the served one.
 */
function servedExactQuality(
  candidate: Candidate,
  candidates: readonly Candidate[],
): ExactQuality {
  const exact = (quality: BenchModel['quality'] = {}): ExactQuality => ({
    knowledge: quality.knowledge, research: quality.research,
    longContext: quality.longContext, visionReasoning: quality.visionReasoning,
  });
  const own = exact(candidate.bench?.quality);
  const served = candidate.effort != null ? levelFrom(candidate.effort, candidate) : undefined;
  if (served == null || served === candidate.effort) return own;
  const retained = candidate.exactQualityByEffort?.[served];
  if (retained) return exact(retained);
  const sibling = candidates.find((peer) => peer.registryId === candidate.registryId && peer.effort === served);
  if (sibling) return exact(sibling.bench?.quality);
  return candidate.effort == null ? own : exact();
}

/**
 * A measured value below any minimum is tier 2 even when another axis is
 * unmeasured: uncertainty cannot erase evidence. A missing measurement
 * otherwise is tier 1, behind every candidate that meets the minimums.
 */
function eligibilityOf(quality: BenchModel['quality'] | undefined, minimums: Minimums): Eligibility {
  let unmeasured = false;
  for (const [axis, minimum] of Object.entries(minimums) as Array<[QualityAxis, number]>) {
    const value = quality?.[axis];
    if (value == null || !Number.isFinite(value)) unmeasured = true;
    else if (value < minimum) return { tier: 2, excludedReason: `below-${axis}-minimum` };
  }
  return unmeasured ? { tier: 1, excludedReason: 'unknown-quality' } : { tier: 0 };
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
function inputOutputPricePer1M(
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
  // Preserve partial benchmark fallback for generic serving economics.
  const partialInput = c.bench?.priceInputPer1M;
  const partialOutput = c.bench?.priceOutputPer1M;
  if (partialInput != null && !isNonNegativeFinite(partialInput)) return undefined;
  if (partialOutput != null && !isNonNegativeFinite(partialOutput)) return undefined;
  const partial = blend(partialInput, partialOutput);
  return isNonNegativeFinite(partial) ? partial : undefined;
}

/**
 * True when most of `candidates` carry a per-task measurement. Task cost and
 * time are measured per effort, while `$/1M` and tokens/sec are shared by every
 * effort of a model, so only the task scale can tell efforts apart. Estimated
 * rows and some measured rows never carry it, so one gap must not discard the
 * scale for the whole pool. A candidate without the measurement gets no credit
 * on that component, which never favours an unmeasured candidate.
 */
function mostlyMeasured(candidates: readonly Candidate[], value: (c: Candidate) => number | undefined): boolean {
  const measured = candidates.filter((c) => isNonNegativeFinite(value(c))).length;
  return measured * 2 > candidates.length;
}

/**
 * Which cost scale a pickBest call compares on. `costPerTask` and blended
 * `$/1M` are different scales and must never be mixed inside one request-local
 * ratio — the same rule that keeps `intelligence` and `coding` out of a shared
 * ratio. Task cost is used when most candidates carry it (`mostlyMeasured`).
 */
export function costSignal(candidates: readonly Candidate[]): 'task' | 'per-1m' {
  return mostlyMeasured(candidates, (c) => c.bench?.costPerTask) ? 'task' : 'per-1m';
}

/**
 * Log-normalize non-negative costs so one extreme outlier cannot compress the
 * useful differences among the rest. Unknown/invalid values stay undefined
 * and receive no cost credit. A zero-price model is a real endpoint of the
 * scale: shifting by the cheapest positive price keeps logs finite,
 * scale-invariant, and makes free strictly better than every paid candidate.
 */
export function logUtilities(
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
  /** One captured policy for scoring and recovery. Absent selects production semantics. */
  policyVersion?: PolicyVersion;
  /** Required vector captured at the decision boundary, including input-shape minimums. */
  requiredMinimums?: Minimums;
  benchmarkIndexVersion?: string;
  benchmarkSnapshotDigest?: string;
  /** Previous turn's chosen candidate key (`provider/id` or `provider/id:effort`). */
  incumbentRegistryId?: string;
  /** True if this is a subagent spawn (no cache to lose). */
  isSubagentSpawn?: boolean;
  /** Required vision support (from image attachments). */
  needsVision?: boolean;
  /** Maximum prompt-cache credit for a candidate. */
  switchMargin?: number;
  /**
   * Tokens each candidate key's own prompt cache still holds for this
   * conversation: keys that served within the cache lifetime, with the
   * context they sent. Where effort is part of the cache key, this is all a
   * same-model effort change keeps. Absent grants an effort change no credit.
   */
  warmPrefixTokens?: ReadonlyMap<string, number>;
  /**
   * Requirement an accepted handoff sets for the next phase's model: the
   * executor of an execution contract, or the model after a context handoff.
   * The candidate must meet that share of each required axis's reference strength.
   * Quality above it earns no credit. An absent requirement uses the task type's fixed minimums.
   */
  handoffMinimum?: number;
  /** Measured compliance preference, bounded and applied inside capability tiers only. */
  protocolPenalties?: ReadonlyMap<string, number>;
  /**
   * Put each candidate without a known price behind every candidate of its capability tier that has
   * one. The candidate policy sets it: a price-only ranking must not give an unknown price the place
   * of the dearest known price.
   */
  unknownPriceLast?: boolean;
}

export interface ScoredCandidate extends Candidate {
  protocolPenalty?: number;
  score: number;
  qualityComponent: number;
  costComponent: number;
  speedComponent: number;
  switched: boolean;
  excludedReason?: QualityExclusionReason;
  /** False when the pick had no price for the candidate on its cost basis. */
  priceKnown?: boolean;
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
    const q = qualityForDimension(c.bench, dimension, opts.handoffMinimum, opts.policyVersion);
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
  policyVersion?: PolicyVersion;
  /** Explicit user/session thinking request, when it outranks labelled effort. */
  userReasoning?: ThinkingLevel;
  userReasoningOverride?: boolean;
  /** Pool used to resolve a sibling row at the effort that will actually serve. */
  candidates?: readonly Candidate[];
}

/**
 * Effort the candidate will actually serve after the model's support map
 * and an explicit user override. Same walk as delegation's attempt
 * resolution: labelled efforts go through `levelFrom`, so a stronger-hop
 * proof cannot use a labelled effort that will never be sent.
 */
export function servedEffort(
  candidate: Pick<Candidate, 'effort' | 'reasoning' | 'thinkingLevelMap'>,
  opts?: Pick<StrongerCompareOpts, 'userReasoning' | 'userReasoningOverride'>,
): ModelThinkingLevel | undefined {
  if (candidate.effort != null && !opts?.userReasoningOverride) {
    return levelFrom(candidate.effort, candidate);
  }
  return resolveThinkingLevel(candidate, opts?.userReasoning);
}

function destServingKey(
  dest: Candidate,
  opts?: StrongerCompareOpts,
): string {
  const effort = servedEffort(dest, opts);
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
  opts?: StrongerCompareOpts,
): Candidate | undefined {
  const effort = servedEffort(dest, opts);
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
  const destKey = destServingKey(dest, opts);
  if (!isValidEscalationCandidate(destKey, fromModel)) return false;
  const sourceParsed = parseCandidateKey(fromModel);
  const destParsed = parseCandidateKey(destKey);
  // Same model, and the guard above already proved a strictly higher effort.
  // More reasoning effort on the same weights is itself the capability
  // escalation, so this deliberately needs no benchmark comparison — the
  // effort ladder is the evidence. Unmeasured efforts would otherwise be
  // unreachable as destinations even when the model plainly supports them.
  if (destParsed.id === sourceParsed.id) return true;
  const measured = destAtServedEffort(dest, opts);
  if (!measured) return false;
  const destQuality = capabilityForDimension(measured, dim, opts?.policyVersion);
  if (destQuality == null || measured.bench?.qualityEstimated === true) return false;
  if (!source || source.bench?.qualityEstimated === true) return false;
  const sourceQuality = capabilityForDimension(source, dim, opts?.policyVersion);
  if (sourceQuality == null) return false;
  return destQuality > sourceQuality;
}

/** Band whose executor minimum covers `requirement`; `frontier` keeps the submitter. */
export function bandForRequirement(requirement: number): CapabilityBand {
  if (requirement < 0.45) return 'economy';
  if (requirement < 0.70) return 'standard';
  if (requirement < FRONTIER_REQUIREMENT) return 'strong';
  return 'frontier';
}

const BAND_ORDER: readonly CapabilityBand[] = ['economy', 'standard', 'strong', 'frontier'];

/**
 * The band that a candidate's measured capability covers on the dimension's
 * axis, or undefined when the candidate has no measurement on that axis.
 */
function candidateBand(candidate: Candidate, dimension: Dimension): CapabilityBand | undefined {
  const quality = candidate.bench?.quality;
  if (!quality) return undefined;
  if (dimension === 'implement') {
    if (quality.agenticCoding !== undefined) return bandForRequirement(quality.agenticCoding / AXIS_REFERENCE.agenticCoding);
    if (quality.coding !== undefined) return bandForRequirement(quality.coding / AXIS_REFERENCE.coding);
    return undefined;
  }
  return quality.intelligence === undefined ? undefined : bandForRequirement(quality.intelligence / AXIS_REFERENCE.intelligence);
}

/**
 * The stronger candidates in the lowest band above the source's band. A
 * struggle asks for the next step up, not for the strongest model: the
 * strongest model costs the most and is rarely needed. Without a band above
 * the source, or without a measured source band, all stronger candidates
 * stay. A candidate without a measured band (for example a higher effort of
 * the same model) counts as the source's band.
 */
function nextBandCandidates(stronger: Candidate[], source: Candidate | undefined, dimension: Dimension): Candidate[] {
  const sourceBand = source ? candidateBand(source, dimension) : undefined;
  if (!sourceBand) return stronger;
  const sourceRank = BAND_ORDER.indexOf(sourceBand);
  const ranked = stronger.map((candidate) => ({ candidate, rank: BAND_ORDER.indexOf(candidateBand(candidate, dimension) ?? sourceBand) }));
  const above = ranked.filter((entry) => entry.rank > sourceRank);
  if (above.length === 0) return stronger;
  const next = Math.min(...above.map((entry) => entry.rank));
  return above.filter((entry) => entry.rank === next).map((entry) => entry.candidate);
}

/**
 * Price decides, with no credit for quality above the capability minimums. The cache credit and
 * the protocol penalty still apply, bounded, and time and the key break ties.
 */
export const ECONOMICS_FIRST_WEIGHTS: ScoreWeights = { quality: 0, cost: 1, speed: 0 };

/** An escalation target is already stronger, so among targets the price decides. */
const ESCALATION_WEIGHTS: ScoreWeights = ECONOMICS_FIRST_WEIGHTS;

/**
 * Pure same-dimension capability escalation: given the model that just
 * served the turn, pick a different candidate. This is intentionally narrow —
 * it reuses `pickBest` for context/vision guards and scoring so the behavior
 * cannot drift from the normal path. `weights` defaults to quality only.
 */
export function pickEscalation(
  candidates: Candidate[],
  dimension: Dimension,
  fromModel: string,
  opts: ScoreOpts = { estimatedContextTokens: 0 },
  weights: ScoreWeights = { quality: 1, cost: 0, speed: 0 },
): RoutingDecision | undefined {
  // Model route-up must increase capability, not merely change transport.
  const alternatives = candidates.filter((c) => isValidEscalationCandidate(candidateKey(c), fromModel));
  if (alternatives.length === 0) return undefined;

  const decision = pickBest(alternatives, dimension, weights, opts);
  return {
    ...decision,
    cause: 'capability-escalation',
    reason: `${decision.reason} [stronger than ${fromModel}]`,
  };
}

/**
 * Shared escalation target selection for both the between-turn repick and the
 * pre-output in-delegation hop. Apply context/vision guards, keep only the
 * strictly-stronger reachable candidates, then pick the cheapest candidate in
 * the next band above the source (`nextBandCandidates`). The higher bands
 * follow in the fallback chain, cheapest first. Both surfaces must land on the same target for the same
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
  version: PolicyVersion = 'legacy',
): RoutingDecision | undefined {
  // `candidates` is the target pool (the pre-output hop passes only the
  // reachable, unattempted tail, which excludes the struggling source). The
  // source and any served-effort siblings must resolve against the full pool,
  // so prefer `compareOpts.candidates`; the between-turn caller passes the full
  // routable set as `candidates` and leaves `compareOpts.candidates` unset, so
  // the fallback keeps that path unchanged.
  const sourcePool = compareOpts.candidates ?? candidates;
  const source = findSourceCandidate(sourcePool, fromModel);
  const strongerOpts: StrongerCompareOpts = { ...compareOpts, candidates: sourcePool, policyVersion: version };
  const eligible = applyCandidateGuards([...candidates], opts);
  const stronger = eligible.filter((candidate) =>
    isStrictlyStrongerCandidate(candidate, fromModel, dimension, source, strongerOpts),
  );
  if (stronger.length === 0) return undefined;
  // Required-vector tiers precede price across the full proven-stronger set.
  // Unknown and insufficient candidates remain available for recovery.
  if (version === 'cheapest-sufficient') {
    const all = pickEscalation(stronger, dimension, fromModel, { ...opts, policyVersion: version, unknownPriceLast: true }, ESCALATION_WEIGHTS);
    return all && all.chosen !== '' ? all : undefined;
  }
  const next = nextBandCandidates(stronger, source, dimension);
  const picked = pickEscalation(next, dimension, fromModel, opts, ESCALATION_WEIGHTS);
  if (!picked || picked.chosen === '') return undefined;
  const higher = stronger.filter((candidate) => !next.includes(candidate));
  const rest = higher.length > 0 ? pickEscalation(higher, dimension, fromModel, opts, ESCALATION_WEIGHTS) : undefined;
  return rest ? { ...picked, fallbackChain: [...picked.fallbackChain, ...rest.fallbackChain] } : picked;
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
 * and speed may rank comparable models, but cannot offset a missed minimum.
 * Lower tiers stay in the chain as objective fallbacks.
 */
function computeEligibility(
  filtered: Candidate[],
  minimums: Minimums,
): Map<string, Eligibility> {
  return new Map(filtered.map((c) => [
    candidateKey(c),
    eligibilityOf(
      c.bench && { ...c.bench.quality, ...servedExactQuality(c, filtered) },
      minimums,
    ),
  ]));
}

/**
 * Score all candidates. Cost and time per task are meaningful only among
 * candidates in the same capability tier; weaker fallback values must not
 * distort the preferred tier.
 */
function scoreWithinTiers(
  filtered: Candidate[],
  dimension: Dimension,
  weights: ScoreWeights,
  opts: ScoreOpts,
  eligibility: Map<string, Eligibility>,
  costOf: (c: Candidate) => number | undefined,
  speedBasis: 'task' | 'tps',
): ScoredCandidate[] {
  const costUtilities = new Map<string, number | undefined>();
  const timeUtilities = new Map<string, number | undefined>();
  for (const tier of [0, 1, 2] as const) {
    const peers = filtered.filter((candidate) => eligibility.get(candidateKey(candidate))!.tier === tier);
    const costs = logUtilities(peers.map(costOf));
    const times = speedBasis === 'task' ? logUtilities(peers.map((c) => c.bench?.timePerTaskSeconds)) : [];
    peers.forEach((candidate, index) => {
      costUtilities.set(candidateKey(candidate), costs[index]);
      timeUtilities.set(candidateKey(candidate), times[index]);
    });
  }

  // A handoff minimum states how much capability the handed-off work needs.
  // Quality above it earns no credit, so among candidates that clear it the
  // economic components — cost, speed, and the cache credit — decide;
  // otherwise a quality-heavy task weighting would pick the strongest model
  // whatever the minimum says. The ceiling uses the selected ranking axis.
  const axis = rankingAxis(dimension, opts.handoffMinimum, opts.policyVersion);
  const qualityCeiling = opts.handoffMinimum != null
    ? clamp(clamp(opts.handoffMinimum, 0, 1) * AXIS_REFERENCE[axis] / 100, 0, 1) * weights.quality
    : undefined;
  return filtered.map((c) => {
    const s = scoreCandidate(c, dimension, weights, opts);
    if (qualityCeiling != null) s.qualityComponent = Math.min(s.qualityComponent, qualityCeiling);
    s.excludedReason = eligibility.get(candidateKey(s))?.excludedReason;
    const costUtility = costUtilities.get(candidateKey(c));
    s.priceKnown = costUtility != null;
    s.costComponent = costUtility == null ? 0 : costUtility * weights.cost;
    if (speedBasis === 'task') s.speedComponent = (timeUtilities.get(candidateKey(c)) ?? 0) * weights.speed;
    s.score = s.qualityComponent + s.costComponent + s.speedComponent;
    return s;
  });
}

/**
 * Cache credit prices the warm prefix a candidate can reuse. The incumbent
 * keeps the whole conversation; other keys keep only their own warm prefix.
 * Effort changes share the whole prefix only where the provider supports it.
 * Missing registry cache prices earn no credit. Subagent spawns have no
 * conversation cache to retain.
 */
function applySwitchBonus(scored: ScoredCandidate[], opts: ScoreOpts): void {
  if (opts.isSubagentSpawn) return;
  const margin = clamp(opts.switchMargin ?? DEFAULT_SWITCH_MARGIN, 0, 1);
  const incumbent = opts.incumbentRegistryId ? parseCandidateKey(opts.incumbentRegistryId) : undefined;
  const incumbentScored = scored.find((s) => candidateKey(s) === opts.incumbentRegistryId);
  const total = Math.max(1, opts.estimatedContextTokens);

  const loss = (candidate: ScoredCandidate): number | undefined => {
    const cost = candidate.cost;
    const write = isNonNegativeFinite(cost?.cacheWrite) ? cost.cacheWrite : cost?.input;
    return isNonNegativeFinite(write) && isNonNegativeFinite(cost?.cacheRead)
      ? Math.max(0, write - cost.cacheRead)
      : undefined;
  };
  const incumbentLoss = incumbentScored && loss(incumbentScored);
  for (const s of scored) {
    const key = candidateKey(s);
    const p = parseCandidateKey(key);
    const sameModel = incumbent && p.provider === incumbent.provider && p.id === incumbent.id;
    const keepsFullPrefix = key === opts.incumbentRegistryId || (sameModel && (p.effort == null || s.effortSharesCache));
    const tokens = keepsFullPrefix ? total : clamp(opts.warmPrefixTokens?.get(key) ?? 0, 0, total);
    const perTokenLoss = keepsFullPrefix ? incumbentLoss : loss(s);
    if (perTokenLoss != null) s.score += Math.min(tokens * perTokenLoss, margin);
    if (key === opts.incumbentRegistryId) s.switched = false;
  }
}

/**
 * Sort by economics inside each capability tier, then keep every weaker
 * model behind the eligible group for delegation fallback. The delegation
 * loop serves `fallbackChain[0]`, which is `chosen`.
 */
function assembleDecision(
  scored: ScoredCandidate[],
  dimension: Dimension,
  eligibility: Map<string, Eligibility>,
  costBasis: 'task' | 'per-1m',
  speedBasis: 'task' | 'tps',
  unknownPriceLast = false,
): RoutingDecision {
  const compareScore = (a: ScoredCandidate, b: ScoredCandidate): number => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.qualityComponent !== a.qualityComponent) return b.qualityComponent - a.qualityComponent;
    const speedA = speedBasis === 'task' ? -(a.bench?.timePerTaskSeconds ?? Infinity) : a.bench?.outputSpeedTps ?? 0;
    const speedB = speedBasis === 'task' ? -(b.bench?.timePerTaskSeconds ?? Infinity) : b.bench?.outputSpeedTps ?? 0;
    if (speedB !== speedA) return speedB - speedA;
    return candidateKey(a).localeCompare(candidateKey(b));
  };
  const tierOf = (s: ScoredCandidate): number => eligibility.get(candidateKey(s))!.tier;
  const priceRank = (s: ScoredCandidate): number => (unknownPriceLast && s.priceKnown === false ? 1 : 0);
  const order = (a: ScoredCandidate, b: ScoredCandidate): number => (tierOf(a) - tierOf(b)) || (priceRank(a) - priceRank(b));
  scored.sort((a, b) => order(a, b) || compareScore(a, b));

  const top = scored[0]!;
  const candidateDiagnostics = scored
    .filter((candidate) => candidate.excludedReason != null)
    .map((s) => ({ candidateKey: candidateKey(s), excludedReason: s.excludedReason }));

  const scoredReason: ScoredReason = {
    score: top.score,
    quality: top.qualityComponent,
    cost: top.costComponent,
    speed: top.speedComponent,
    costBasis,
    details: [],
  };
  const withoutPenalty = [...scored].sort((a, b) => order(a, b) || compareScore(
    { ...a, score: a.score + (a.protocolPenalty ?? 0) },
    { ...b, score: b.score + (b.protocolPenalty ?? 0) },
  ))[0]!;
  if (candidateKey(withoutPenalty) !== candidateKey(top)) {
    scoredReason.details.push({ kind: 'protocol-penalty', model: candidateKey(withoutPenalty), penalty: withoutPenalty.protocolPenalty!, changed: true });
  } else if (top.protocolPenalty) {
    scoredReason.details.push({ kind: 'protocol-penalty', model: candidateKey(top), penalty: top.protocolPenalty, changed: false });
  }
  return {
    dimension,
    chosen: candidateKey(top),
    reason: renderScoredReason(scoredReason),
    scoredReason,
    ...(candidateDiagnostics.length > 0 ? { candidateDiagnostics } : {}),
    cause: 'heuristic',
    fallbackChain: scored.map((s) => candidateKey(s)),
  };
}

/**
 * Which speed scale a pickBest call compares on: measured time per task when
 * most candidates in the pool that can win carry it (`mostlyMeasured`), else
 * output tokens per second. Like cost, the two scales are never mixed in one
 * pick.
 */
function speedSignal(candidates: readonly Candidate[]): 'task' | 'tps' {
  return mostlyMeasured(candidates, (c) => c.bench?.timePerTaskSeconds) ? 'task' : 'tps';
}

// ─── pickBest ─────────────────────────────────────────────────────────

export function pickBest(
  candidates: Candidate[],
  dimension: Dimension,
  weights: ScoreWeights = DEFAULT_DIMENSION_WEIGHTS[dimension],
  opts: ScoreOpts = { estimatedContextTokens: 0 },
): RoutingDecision {
  const filtered = applyCandidateGuards(candidates, opts);
  const minimums: Minimums = opts.requiredMinimums ?? {
    ...minimumsFor(dimension, opts.handoffMinimum, opts.policyVersion),
    // Below these conservative correctness minimums, the model has measured
    // weak ability on the input shape. Missing measurements remain unknown.
    ...(opts.estimatedContextTokens >= 64_000 ? { longContext: 0.30 } : {}),
    ...(opts.needsVision ? { visionReasoning: 0.30 } : {}),
  };
  const eligibility = computeEligibility(filtered, minimums);

  // Request-local cost and speed scales, chosen once for this call from the
  // tier-0 pool: a tier-2 candidate missing task cost or time never competes
  // for the win, so it must not blind the competitive group to effort-aware
  // measurements (same-model effort variants share one $/1M rate, but not
  // one cost or time per task).
  const tierZeroPool = filtered.filter((c) => eligibility.get(candidateKey(c))?.tier === 0);
  const pool = tierZeroPool.length > 0 ? tierZeroPool : filtered;
  const costBasis = costSignal(pool);
  const costOf = (c: Candidate): number | undefined => {
    const cost = costBasis === 'task' ? c.bench?.costPerTask : blendedPricePer1M(c);
    return isNonNegativeFinite(cost) ? cost : undefined;
  };

  const speedBasis = speedSignal(pool);
  const scored = scoreWithinTiers(
    filtered,
    dimension,
    weights,
    opts,
    eligibility,
    costOf,
    speedBasis,
  );
  applySwitchBonus(scored, opts);
  for (const candidate of scored) {
    const raw = opts.protocolPenalties?.get(identityKey(candidate.registryId));
    const penalty = isNonNegativeFinite(raw) ? Math.min(raw, opts.switchMargin ?? DEFAULT_SWITCH_MARGIN) : 0;
    if (penalty > 0) { candidate.protocolPenalty = penalty; candidate.score -= penalty; }
  }
  const decision = assembleDecision(scored, dimension, eligibility, costBasis, speedBasis, opts.unknownPriceLast === true);
  if (opts.policyVersion === 'cheapest-sufficient') {
    decision.policyVersion = opts.policyVersion;
    decision.capabilityEvidence = {
      policyDigest: COMPARATOR_DIGEST,
      comparisonAxis: 'intelligence',
      metricVersion: CALIBRATED_INDEX_VERSION,
      minimums: { ...minimums },
      ...(opts.benchmarkIndexVersion ? { benchmarkIndexVersion: opts.benchmarkIndexVersion } : {}),
      ...(opts.benchmarkSnapshotDigest ? { benchmarkSnapshotDigest: opts.benchmarkSnapshotDigest } : {}),
    };
  }
  return decision;
}

const THINKING_LEVELS: ModelThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Pi's own rule, read from Pi so the two cannot differ: a null map entry is
 * an unsupported level, `off` included, and `xhigh`/`max` need an explicit
 * entry. A model without reasoning has no thinking level to send, so it
 * supports none here; Pi lists only `off` for it.
 */
function isThinkingSupported(
  c: Pick<Candidate, 'reasoning' | 'thinkingLevelMap'> | undefined,
  level: ModelThinkingLevel,
): boolean {
  if (!c?.reasoning) return false;
  return getSupportedThinkingLevels(c as Parameters<typeof getSupportedThinkingLevels>[0]).includes(level);
}

export function isThinkingSupportedByRegistryModel(
  c: Pick<RegistryModelInfo, 'reasoning' | 'thinkingLevelMap'> | undefined,
  level: ModelThinkingLevel,
): boolean {
  return isThinkingSupported(c, level);
}

/**
 * Providers that cannot turn thinking off. Pi sends no reasoning for `off`,
 * and these providers then send no effort, so the model runs at its own
 * default effort. A measured `off` row describes a request they never send.
 */
const PROVIDERS_WITHOUT_THINKING_OFF: ReadonlySet<string> = new Set(['claude-bridge']);

/**
 * Whether a request at `off` runs the mode an `off` row measures: always for
 * a model without reasoning, and for a reasoning model only when it supports
 * `off` and its provider can turn thinking off.
 */
export function servesThinkingOff(
  m: Pick<RegistryModelInfo, 'provider' | 'reasoning' | 'thinkingLevelMap'>,
): boolean {
  if (!m.reasoning) return true;
  return isThinkingSupported(m, 'off') && !PROVIDERS_WITHOUT_THINKING_OFF.has(m.provider);
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
 * The router's effort for a candidate: its measured (or estimated) effort,
 * raised only to the nearest level the model supports. Each effort has its
 * own score, so the scorer has already chosen the effort for the task. A
 * candidate with no effort label gets no router choice; the caller sends
 * Pi's session thinking level, as Pi does when a user selects that model.
 */
export function chooseThinkingLevel(c: Candidate | undefined): ModelThinkingLevel | undefined {
  if (!c?.reasoning || c.effort == null) return undefined;
  return levelFrom(c.effort, c);
}

export function resolveThinkingLevel(
  c: Pick<Candidate, 'reasoning' | 'thinkingLevelMap'> | undefined,
  requested: ThinkingLevel | undefined,
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
  return chooseThinkingLevel(c as Candidate | undefined);
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
    // row) carries no effort and Pi's session thinking level applies.
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
