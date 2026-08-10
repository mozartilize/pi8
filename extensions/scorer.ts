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
} from './types.js';
import { DEFAULT_DIMENSION_WEIGHTS, DEFAULT_SWITCH_MARGIN } from './constants.js';
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
      // measured by only one source. See spec §17.6 and §redundancy-report G3.
      return b.quality.intelligence;
    case 'implement':
      return b.quality.agenticCoding ?? b.quality.coding;
    case 'review':
      return b.quality.coding ?? b.quality.intelligence;
  }
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
 * nominal entry can be raised by the dimension floor (plan always reaches
 * max), so use an exact-effort sibling's measurement before the entry's own.
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
function blend(input: number | undefined, output: number | undefined): number | undefined {
  if (input == null && output == null) return undefined;
  if (input == null) return output!;
  if (output == null) return input;
  return input * 0.25 + output * 0.75;
}

/**
 * Blended price per 1M tokens.
 *
 * Pi's registry carries provider/model-specific rates, including cache pricing,
 * so it is authoritative when present. Benchmark pricing is only a fallback
 * for models whose registry entry is incomplete or unpriced.
 */
export function blendedPricePer1M(c: Candidate): number | undefined {
  if (c.cost) {
    const { input, output } = c.cost;
    // Registry-sourced price data — including genuinely free (0/0) models from
    // known providers (e.g. opencode/*-free, openrouter/*:free).
    //
    // A free model that also carries benchmark data is a real known entity;
    // its zero cost is deliberate. A model with 0/0 cost but no benchmark data
    // may be a custom endpoint that pi-core zero-filled, i.e. genuinely unknown
    // — treat that case conservatively (return undefined, no cost credit).
    if (
      Number.isFinite(input) &&
      Number.isFinite(output) &&
      (input !== 0 || output !== 0 || c.bench != null)
    ) {
      return blend(input, output);
    }
  }
  return c.bench ? blend(c.bench.priceInputPer1M, c.bench.priceOutputPer1M) : undefined;
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
  return candidates.length > 0 && candidates.every((c) => c.bench?.costPerTask != null)
    ? 'task'
    : 'per-1m';
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
   * Request-local terminal/inspect floors for an eligible compound-implement
   * intent. Absent selects the current live tier/promotion constants
   * unchanged — this is the only input that changes eligibility parameters.
   */
  multiWorkPolicy?: MultiWorkScoringPolicy;
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
  const alternatives = candidates.filter((c) => candidateKey(c) !== fromModel);
  if (alternatives.length === 0) return undefined;

  const decision = pickBest(alternatives, dimension, { quality: 1, cost: 0, speed: 0 }, opts);
  return {
    ...decision,
    cause: 'capability-escalation',
    reason: `${decision.reason} [escalation from ${fromModel}]`,
  };
}

// ─── pickBest ─────────────────────────────────────────────────────────

export function pickBest(
  candidates: Candidate[],
  dimension: Dimension,
  weights: ScoreWeights = DEFAULT_DIMENSION_WEIGHTS[dimension],
  opts: ScoreOpts = { estimatedContextTokens: 0 },
): RoutingDecision {
  let filtered = candidates;

  // Long-context guard: exclude models whose window < estimatedTokens * 1.2
  if (opts.estimatedContextTokens > 0) {
    const guardFiltered = filtered.filter((c) => {
      const win = c.contextWindow ?? 0;
      return win <= 0 || win >= opts.estimatedContextTokens * 1.2;
    });
    // If the guard empties the set, keep the single largest-window model.
    if (guardFiltered.length > 0) {
      filtered = guardFiltered;
    } else {
      const largest = [...filtered].sort((a, b) => (b.contextWindow ?? 0) - (a.contextWindow ?? 0))[0];
      if (largest) {
        filtered = [largest];
      }
    }
  }

  // Vision guard
  if (opts.needsVision) {
    const visionFiltered = filtered.filter((c) => c.vision);
    if (visionFiltered.length > 0) {
      filtered = visionFiltered;
    }
    // If no vision-capable model: keep all, set routedUp flag
  }

  // Capability is an eligibility gate, not another weighted component: price
  // and speed may rank comparable models, but cannot offset a material quality
  // gap. Lower tiers stay in the chain as objective fallbacks.
  //
  // `multiWorkPolicy` changes only which parameters feed this single
  // eligibility/promotion implementation; its absence selects the current
  // live constants unchanged (rule: one filtering/ranking/fallback path).
  // Knowledge is task-critical for planning/review and for the terminal phase
  // of compound implementation. Activate its floor only when the scoring pool
  // has at least one measurement: absent coverage is uncertainty, not proof
  // that every model is weak.
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
  const terminalEligibility = new Map(eligibility);
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
  const costOf = (c: Candidate): number | undefined =>
    costBasis === 'task' ? c.bench?.costPerTask : blendedPricePer1M(c);

  // A near-frontier candidate may earn tier 0 only when economics provide a
  // material benefit and no cheaper peer already offers at least its task axis.
  // Plan is pure judgment, so its frontier remains intentionally unrelaxed.
  if (activePromotionPolicy.enabled) {
    const eligiblePrices = filtered
      .filter((c) => eligibility.get(candidateKey(c))?.tier === 0 && relative.has(candidateKey(c)))
      .map(costOf)
      .filter((price): price is number => price != null);
    const cheapestEligiblePrice = eligiblePrices.length > 0 ? Math.min(...eligiblePrices) : undefined;

    if (cheapestEligiblePrice != null) {
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
          // Promotion relaxes the capability floor on economic grounds. An
          // estimated row already claims capability it was never measured at;
          // relaxing the floor for it too would stack one inference on
          // another, so promotion stays measured-evidence only.
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
  }
  const tierOf = (c: Candidate): QualityTier => eligibility.get(candidateKey(c))!.tier;

  // Score all candidates, normalize cost across the set.
  const maxCost = Math.max(
    0.0001,
    ...filtered.map((c) => costOf(c) ?? 0),
  );

  const scored = filtered.map((c) => {
    const s = scoreCandidate(c, dimension, weights, opts);
    s.excludedReason = eligibility.get(candidateKey(s))?.excludedReason;
    // Normalize cost: cheaper = higher score
    const blended = costOf(c);
    if (blended != null && maxCost > 0) {
      const costRatio = 1 - clamp(blended / maxCost, 0, 1);
      s.costComponent = costRatio * weights.cost;
    } else {
      s.costComponent = 0; // unknown price → no credit (asymmetric safe)
    }
    s.score = s.qualityComponent + s.costComponent + s.speedComponent;
    return s;
  });

  // Switch penalty: incumbent gets a bonus proportional to context size.
  if (opts.incumbentRegistryId && !opts.isSubagentSpawn) {
    // The configured margin caps cache-preservation stickiness so it cannot
    // overwhelm the quality/cost/speed score on long sessions.
    const margin = clamp(opts.switchMargin ?? DEFAULT_SWITCH_MARGIN, 0, 1);
    const penalty = Math.min(opts.estimatedContextTokens * 0.000005, margin);
    for (const s of scored) {
      if (candidateKey(s) === opts.incumbentRegistryId) {
        s.score += penalty;
        s.switched = false;
      }
    }
  }

  // Sort by economics inside each capability tier, then keep every weaker
  // model behind the eligible group for delegation fallback. Relative quality
  // breaks exact weighted ties before the registry id does, so ordering is
  // decided by benchmark evidence rather than by name whenever evidence exists.
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
  scored.sort((a, b) => tierOf(a) - tierOf(b) || compareScore(a, b));

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
      // Only a tier-zero known candidate may outrank unknown-quality fallbacks.
      const known = scored.find(
        (s) => tierOf(s) === 0 && s.bench && qualityForDimension(s.bench, dimension) != null,
      );
      if (known && candidateKey(known) !== candidateKey(top)) {
        top = known;
      }
    }
  }

  // After an asymmetric promotion `top` is no longer `scored[0]`. The
  // delegation loop serves fallbackChain[0], so the chain MUST lead with the
  // promoted pick — otherwise `chosen` and the model actually served diverge:
  // `chosen` names the routed-up known-quality model while the loop streams
  // the original unknown-quality top. Keep `chosen === fallbackChain[0]`.
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

  return {
    dimension,
    chosen: candidateKey(top),
    reason: `scored ${top.score.toFixed(3)} (q:${top.qualityComponent.toFixed(2)} c:${top.costComponent.toFixed(2)} s:${top.speedComponent.toFixed(2)}) [cost-basis: ${costBasis}]${routedUp ? ' [routed-up]' : ''}`,
    ...(candidateDiagnostics.length > 0 ? { candidateDiagnostics } : {}),
    confidence: 0.8, // placeholder — overwritten by classifier
    routedUp,
    routedDown: false,
    cause: 'heuristic',
    fallbackChain,
    ...(multiWork ? { multiWork } : {}),
  };
}

const THINKING_LEVELS: ModelThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Minimum reasoning effort per dimension — a FLOOR, not an assignment. The
 * scorer may serve any measured effort at or above it (rule 3: a scored
 * effort may raise the floor, never lower it; `plan` therefore stays at max,
 * and the freedom the measured axis buys is *which model* runs at max, not
 * how hard it thinks). A model with no measurement at or above the floor
 * keeps today's behavior: send the floor level, clamped by thinkingLevelMap.
 */
const MIN_THINKING_BY_DIMENSION: Record<Dimension, ThinkingLevel | 'off'> = {
  lightweight: 'off',
  gather: 'low',
  plan: 'max',
  implement: 'medium',
  review: 'high',
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
 * floor is the only downward protection on the effort axis (rule 3); scoring
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
  // below the floor it is raised to the floor (rule 3), never sent as-is.
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
    cost: model.cost,
    available: true,
  };
}
