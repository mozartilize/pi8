import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ModelThinkingLevel, ThinkingLevelMap } from '@earendil-works/pi-ai';

export type { ExtensionContext };

/**
 * Shared types for the benchmark-aware auto model router.
 */

export type Dimension =
  | 'lightweight'
  | 'gather'
  | 'plan'
  | 'implement'
  | 'review';

export const ROUTER_DIMENSIONS: Dimension[] = [
  'lightweight',
  'gather',
  'plan',
  'implement',
  'review',
];

/** One normalized benchmark row after adapter + registry intersection. */
export interface BenchModel {
  /** Canonical "provider/id" that EXISTS in Pi's model registry. */
  registryId: string;
  /** Source slug as reported by the benchmark adapter. */
  benchSlug: string;
  /** False if the source row could not be resolved to a registry entry. */
  active: boolean;
  quality: {
    intelligence?: number;
    coding?: number;
    agenticCoding?: number;
    /**
     * BenchLM's AA-Omniscience Index: 100 * (correct - incorrect) / questions.
     * Zero is the meaningful reliability boundary where correct and incorrect
     * answers balance; negative values mean wrong answers outnumber correct
     * ones. It remains separate from intelligence/coding ratios.
     */
    knowledge?: number;
  };
  priceInputPer1M?: number;
  priceOutputPer1M?: number;
  /** Output tokens per second, higher better. */
  outputSpeedTps?: number;
  /** Median time to first token in ms. */
  latencyMsTtft?: number;
  /** Median time to first *answer* token in ms. For reasoning rows this is the
   * first non-thinking token — TTFT measures the first thinking token instead. */
  latencyMsTtfa?: number;
  /** Reasoning-effort level the row was measured at; absent when the source published none. */
  effort?: ModelThinkingLevel;
  /**
   * True when `quality` was estimated by stepping down the effort ladder from
   * a measured row of the same model rather than published by the source. The
   * estimate is a conservative lower bound, but it is still not an
   * observation: mechanisms that relax a floor (economic promotion) require
   * measured evidence and must check this flag.
   */
  qualityEstimated?: boolean;
  /** Measured cost per task (AA intelligence-index cost block); absent when unpublished. */
  costPerTask?: number;
  /** Prefer registry value; adapter value is fallback. */
  contextWindow?: number;
  /** Which source produced this row. */
  source: string;
}

export interface BenchmarkStore {
  /** 2 = effort-aware identity; v1 stores are discarded on load (effort lost). */
  version: 2;
  syncedAt: number; // epoch ms
  models: BenchModel[];
  /** benchSlug -> registryId bindings the fuzzy matcher cannot infer on its own. */
  aliases: Record<string, string>;
}

export interface ScoreWeights {
  quality: number;
  cost: number;
  speed: number;
}

export type QualityExclusionReason =
  | 'below-task-floor'
  | 'below-sanity-floor'
  | 'below-knowledge-floor'
  | 'unknown-quality'
  | 'promoted';

export interface CandidateDiagnostic {
  /** Candidate key (`provider/id` or `provider/id:effort`) that was demoted/promoted. */
  candidateKey: string;
  excludedReason?: QualityExclusionReason;
}

/** Registry model joined with its benchmark row (if any) and full registry metadata. */
export interface Candidate {
  registryId: string;
  provider: string;
  id: string;
  bench?: BenchModel;
  /**
   * Reasoning-effort level this candidate should be served at. Present only
   * when a measured bench row exists for exactly this (model, effort) pair;
   * absent means "no measured effort" and the dimension floor applies.
   */
  effort?: ModelThinkingLevel;
  /**
   * Factual-reliability evidence applicable at each reasoning effort. BenchLM
   * publishes AA-Omniscience as a model-wide score, so it applies to every
   * supported reasoning level; exact effort-labelled rows override it.
   * Every sibling retains the map so filtering cannot erase serving evidence.
   */
  knowledgeByEffort?: Partial<Record<ModelThinkingLevel, number>>;
  contextWindow?: number;
  maxTokens?: number;
  /** Whether the registry claims vision support (from input array). */
  vision?: boolean;
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  /** Registry pricing in USD per 1M tokens. Absent when unknown. */
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  /** Availability in the current authenticated context. */
  available: boolean;
}

/**
 * Agent-level origin of a message that `convertToLlm` flattened into
 * `role: "user"`. Pi's harness collapses compaction summaries, branch
 * summaries, custom messages and bash executions into user messages, so
 * `role` alone cannot tell the router what the human actually typed.
 */
export type MessageProvenance =
  | 'user'
  | 'compaction-summary'
  | 'branch-summary'
  | 'synthetic-known'
  | 'assistant'
  | 'tool-result';

export type AssessmentConfidence = 'high' | 'medium' | 'low';

/** Terminal-axis kind is the same vocabulary as routing dimensions. */
export type TaskKind = Dimension;
export type TaskScope = 'bounded' | 'open-ended';
export type ComplexityBand = 'trivial' | 'routine' | 'moderate' | 'hard' | 'frontier';
export type WorkPhase = 'answer' | 'inspect' | 'reason' | 'mutate';
export type CapabilityBand = 'economy' | 'standard' | 'strong' | 'frontier';

export interface TerminalAssessment {
  kind: TaskKind;
  complexity: ComplexityBand;
  scope: TaskScope;
  compound: boolean;
  confidence: AssessmentConfidence;
  discountEligible: boolean;
}

export interface CandidateCapabilityMeta {
  taskRatio?: number;
  clearsTerminalFloor: boolean | 'unknown';
  viaInspectPromotion: boolean;
}

export interface MultiWorkScoringPolicy {
  terminal: TerminalAssessment;
  terminalRequirement: number;
  terminalBand: CapabilityBand;
  phase: WorkPhase;
  phaseReason: string;
  terminalFloor: number;
  inspectFloor: number;
  providerInvocation: number;
}

export interface MultiWorkRoutingMeta extends MultiWorkScoringPolicy {
  candidateCapability: Record<string, CandidateCapabilityMeta>;
  terminalCapableInScoringSet: boolean;
  servedCandidateKey?: string;
  servedCapability?: CandidateCapabilityMeta;
  capabilityDegraded?: boolean;
  mutationGateEscaped?: boolean;
  gateBlockedInvocation?: number;
}

export interface ServedCapabilityMeta {
  providerInvocation: number;
  terminalFloor: number;
  terminalCapableInScoringSet: boolean;
  candidate: CandidateCapabilityMeta;
}

export type AssessmentFallbackReason =
  | 'expiry'
  | 'auth'
  | 'parse'
  | 'error'
  | 'no-assessor'
  | 'disabled';

/** Expected assessor request shape used only for model-selection economics. */
export interface AssessorTokenEstimate {
  input: number;
  output: number;
}

export interface RoutingAssessment {
  kind: TaskKind;
  complexity: ComplexityBand;
  scope: TaskScope;
  compound: boolean;
  confidence: AssessmentConfidence;
  reasoning: string;
  /** Canonical `provider/id` of the model that answered. */
  model: string;
  /** Wall-clock milliseconds, end to end. */
  ms: number;
  usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  costUsd: number;
  /** Set when this assessment was requested by the depth-latch transition. */
  vetoedLatch?: boolean;
}

export type DecisionCause =
  | 'heuristic'
  | 'continuation-context'
  | 'user-escalation'
  | 'router-consult'
  | 'embedding-classify'
  | 'error-fallback'
  | 'no-data'
  | 'model-escalation'
  | 'capability-escalation'
  | 'context-depth'
  | 'self-healing-gap';

export interface RoutingDecision {
  dimension: Dimension;
  /**
   * Effort floor applied when serving, when it must outrank the routed
   * dimension's own floor. The incumbent model is sticky within a task, so a
   * cheap-phrased same-task follow-up keeps the strong model — but its routed
   * dimension (and thus its effort floor) can classify low. This carries the
   * incumbent's resolved dimension forward as an up-only effort floor so the
   * served thinking level cannot drop below what the incumbent ran at.
   * Absent means the routed dimension's floor applies unchanged.
   */
  effortFloorDimension?: Dimension;
  chosen: string;
  reason: string;
  confidence: number;
  routedUp: boolean;
  /**
   * True when the routed dimension is strictly weaker than the heuristic's.
   * Distinct from `routedUp` because "different" and "stronger" are not the
   * same question, and context-pressure advice is only meaningful upward.
   */
  routedDown: boolean;
  /**
   * True only when a routedUp/routedDown actually changed the served model
   * versus the model the un-escalated (heuristic) dimension would have picked.
   * A dimension raise that re-selects the same model served nothing stronger,
   * so the status UI suppresses the "routed-up"/"routed-down" label when this
   * is false. Undefined when neither direction fired. `routedUp`/`routedDown`
   * keep their dimension-level meaning for the decision log and `cause`.
   */
  routedPickChanged?: boolean;
  /** Present when an assessment ran for this intent, adopted or not. */
  assessment?: RoutingAssessment;
  /** Why the assessment was unavailable. Never changes `cause`. */
  fallbackReason?: AssessmentFallbackReason;
  /** Intent cache key joining assessment metrics to this routing decision. */
  intentKey?: string;
  /** Message-origin census for this turn's context. */
  provenanceCounts?: Record<MessageProvenance, number>;
  cause: DecisionCause;
  fallbackChain: string[];
  /** Capability-tier evidence for candidates that were demoted or promoted. */
  candidateDiagnostics?: CandidateDiagnostic[];
  /** True if the chosen model differs from the previous turn's model. */
  switched?: boolean;
  /** Escalation metadata when a serving model requested route_up. */
  escalation?: {
    requestedDimension: Dimension;
    heuristicDimension: Dimension;
    reason: string;
  };
  /** Cache-related usage from the delegated stream, populated after the turn. */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheRead: number;
    cacheWrite: number;
  };
  /** Advisory metadata when high parent context suggests planner offload. */
  contextPressure?: {
    usageRatio: number;
    threshold: number;
    suggestion: string;
  };
  /** Multi-work routing metadata when an eligible compound intent is engaged. */
  multiWork?: MultiWorkRoutingMeta;
  /**
   * Counterfactual baseline this turn is priced against for `/router-report`.
   * `source: 'config'` means `config.baselineModel` was routable this turn;
   * `'auto'` means it was picked from the same candidate pool by measured
   * capability (price only as a tiebreak when no candidate carries bench
   * quality). Absent when no routable candidate could serve as baseline.
   */
  baseline?: {
    registryId: string;
    source: 'config' | 'auto';
    cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  };
  /**
   * Actual vs counterfactual spend for this turn, both priced from registry
   * `$/token` at the SAME observed token counts (`usage`) — never mixed with
   * provider-reported billing (`cost.total`, absent for subscription
   * providers), which would compare two different cost bases. `routedCost`
   * sums every attempt's own price (including failed attempts that still
   * spent tokens); `baselineCost` reprices that same total at the baseline
   * model's rate. Absent `baselineCost` means no baseline was resolved.
   */
  spend?: { routedCost: number; baselineCost?: number };
}

export type Role = 'researcher' | 'planner' | 'worker' | 'reviewer' | 'advisor';

export const ROLE_DIMENSIONS: Record<Role, Dimension> = {
  researcher: 'gather',
  planner: 'plan',
  worker: 'implement',
  reviewer: 'review',
  advisor: 'plan',
};

/** Provider id this extension registers under. */
export const ROUTER_PROVIDER_ID = 'router';

/** Generic model id: dimension comes from classifying the prompt. */
export const AUTO_MODEL_ID = 'auto';

export interface AutoRouterConfig {
  /** Free API key for artificialanalysis.ai (optional but recommended). */
  artificialAnalysisApiKey?: string;
  /** Which sources to sync. */
  sources: string[];
  /** Quality/cost/speed weights per dimension. */
  dimensionWeights: Record<Dimension, ScoreWeights>;
  /** Maximum incumbent-retention bonus for mid-session switching. */
  switchMargin: number;
  /**
   * Counterfactual baseline for `/router-report`'s spend-vs-baseline
   * comparison, as `provider/id`. Absent means the router auto-picks the
   * highest measured-capability routable candidate on each turn's own
   * dimension instead of a fixed pin.
   */
  baselineModel?: string;
  /**
   * Context window to advertise for the synthetic `router/auto` model. Pi tunes
   * compaction to the session model's window, so advertising the largest
   * routable model's window (the default when this is absent) delays
   * compaction on long sessions — which pushes context past each smaller
   * model's real window and drops those (often cheaper) models out of
   * eligibility one by one, biasing long sessions toward large-window models.
   * Set this to the effective window you actually want to route within to make
   * Pi compact earlier and keep cheaper models eligible longer. Absent =
   * largest routable window.
   */
  routerContextWindow?: number;
  /** Threshold for classifier low-confidence route-up. */
  lowConfidenceThreshold: number;
  /**
   * If true (default), await one bounded semantic assessment per real user
   * entry and adopt its verdict under the assessment safety caps.
   */
  consultRouter: boolean;
  /** One end-to-end budget: selection + auth + startup + stream + parse. */
  assessmentDeadlineMs: number;
  /** Hard cap on assembled assessment input, in characters. */
  assessmentMaxInputChars: number;
  /** Assessor must reach this share of the strongest routable intelligence. */
  assessorQualityRatio: number;
  /** Optional "provider/id" override for the consultation model. */
  consultModel?: string;
  /**
   * If true (default), raise a lightweight/gather dimension one tier once the
   * live context grows past `depthEscalationTokens`. The classifier scores only
   * the latest entry's phrasing, so it cannot see a gather session turning
   * into synthesis over gathered material — the context size is the objective
   * proxy for that transition.
   */
  depthEscalation: boolean;
  /** Context-token threshold for depth escalation. */
  depthEscalationTokens: number;
  /** If true, register the route_up self-escalation tool (default true). */
  escalationTool: boolean;
  /** Number of turns a model escalation override stays active. */
  escalationTtlTurns: number;
  /**
   * Show a TUI notification when the router picks/switches the model for a
   * turn (default true). The footer status widget updates regardless.
   */
  prompt: boolean;
  /**
   * Allowlist of routable models as `provider/id` patterns, e.g.
   * `["github-copilot/*", "opencode-go/deepseek-v4-pro"]`.
   * Undefined or empty means every registry model is routable.
   */
  models?: string[];
  /**
   * Persistent blacklist of `provider/id` patterns (same glob syntax as
   * `models`), excluded from routing across sessions. Distinct from the
   * in-memory, per-session blacklist of concrete models that failed at
   * runtime, which is never persisted here.
   */
  blacklist?: string[];
  /**
   * Debug logging. `true` writes per-session timing logs next to the session
   * file; a string writes to that explicit path; `false`/absent disables it.
   */
  debug?: boolean | string;
  /**
   * Opt-in literal prefixes for known integrations (e.g. `pi-context`).
   * Messages starting with a listed prefix are classified as `synthetic-known`
   * rather than `user`, so they neither shift the intent cache key nor
   * impersonate the request. Never inferred — the list is explicit config.
   */
  syntheticPrefixes: string[];
  /**
   * If true, uses a local multilingual embedding classifier (E5-small) when
   * the keyword classifier has no categorical evidence — i.e. non-English
   * prompts and ambiguous English prompts. Blends up only; never overrides
   * a keyword verdict downward. Default false.
   */
  embeddingClassifier?: boolean;
  /** Maximum ms the embedding model load + inference may take. Default 5000. */
  embeddingDeadlineMs?: number;
  /**
   * Minimum embedding-classifier confidence (top-two margin, [0,1]) for its
   * verdict to influence routing. Below it the embedding abstains and the
   * keyword result stands unchanged. Default 0.15.
   */
  embeddingMinConfidence?: number;
}

export interface SyncResult {
  source: string;
  ok: boolean;
  fetched: number;
  matched: number;
  unresolved: number;
  error?: string;
}
