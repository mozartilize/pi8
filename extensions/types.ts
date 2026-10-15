import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ScoredReason } from './routing/score/decision-reason.js';
import type { ModelThinkingLevel, ThinkingLevelMap } from '@earendil-works/pi-ai';
import type { ContextReason, ContextRelation, ResolverTier } from './routing/context/types.js';
import type { FactsLog } from './routing/policy/change-facts.js';
import type { AxisProvenance } from './routing/features/schema.js';

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
    /**
     * Terminal-Bench 4.0 pass rate in percent [0, 100]. A row without a result
     * carries an estimate from the older AA indexes and `qualityEstimated`.
     */
    agenticCoding?: number;
    /**
     * AA Agentic Index. Explicit implement requirements below 0.45 use this
     * axis. Default and higher requirements use Terminal-Bench 4.0.
     */
    agenticIndex?: number;
    /**
     * AA-Omniscience Index: 100 * (correct - incorrect) / questions, closed
     * book. Zero is where correct and incorrect answers balance; negative
     * values mean wrong answers outnumber correct ones.
     */
    knowledge?: number;
    /**
     * AA-Briefcase rubric pass rate in [0, 1]: the share of rubric checks the
     * deliverables pass on multi-week knowledge-work projects with thousands
     * of input files. Work from sources, checked for correctness.
     */
    research?: number;
    /** LCR and MMMU-Pro correctness fractions in [0, 1]. */
    longContext?: number;
    visionReasoning?: number;
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
   * True when `quality` is an estimate, not an observation: Artificial
   * Analysis estimated the index, its provenance is unknown, or the router stepped it down the effort
   * ladder from a measured row of the same model. A claim that one model is
   * strictly stronger than another requires measured evidence.
   */
  qualityEstimated?: boolean;
  /**
   * Provenance of each quality axis, set independently. A populated value in
   * `quality` does not establish `measured`. A row without this map (written
   * before provenance existed) gives no axis evidence to the unified
   * selector until a sync rewrites it.
   */
  axisProvenance?: Partial<Record<ProvenanceAxis, AxisProvenance>>;
  /** Measured cost per task (AA intelligence-index cost block); absent when unpublished. */
  costPerTask?: number;
  /** Measured wall time per Intelligence Index task in seconds; absent when unpublished. */
  timePerTaskSeconds?: number;
  /**
   * AA weighted output tokens (answer and reasoning) per Intelligence Index
   * task. A benchmark observation, not a forecast of the next invocation.
   * Absent when the models page publishes none or the value is unusable.
   */
  outputTokensPerTask?: number;
  /**
   * Provenance of `outputTokensPerTask`, separate from the quality-axis
   * provenance. Absent when the models page has no token observation.
   */
  outputTokensProvenance?: OutputTokensProvenance;
  /** Prefer registry value; adapter value is fallback. */
  contextWindow?: number;
  /** Which source produced this row. */
  source: string;
}

/** Quality axes that carry independent provenance. */
export type ProvenanceAxis = 'intelligence' | 'agenticCoding' | 'research' | 'knowledge' | 'longContext' | 'visionReasoning';
export const PROVENANCE_AXES: readonly ProvenanceAxis[] = ['intelligence', 'agenticCoding', 'research', 'knowledge', 'longContext', 'visionReasoning'];

/**
 * Status of an output-token observation:
 * - `measured`: AA did not estimate the Intelligence Index of the row.
 * - `source-estimated`: AA estimated the index, or the page does not say.
 * - `unknown-effort`: the display name has no effort label the router parses.
 * - `invalid`: the page value is not a finite nonnegative number.
 * - `conflict`: two observations for one identity disagree.
 */
export type OutputTokensStatus = 'measured' | 'source-estimated' | 'unknown-effort' | 'invalid' | 'conflict';
export const OUTPUT_TOKENS_STATUSES: readonly OutputTokensStatus[] = ['measured', 'source-estimated', 'unknown-effort', 'invalid', 'conflict'];

export interface OutputTokensProvenance {
  status: OutputTokensStatus;
  /** Intelligence Index version that the models page shows; absent when the page shows none or more than one. */
  indexVersion?: string;
}

export interface BenchmarkStore {
  /** AA index scale the synchronized measurements use. */
  indexVersion?: string;
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

/** One benchmark axis a capability minimum is set on. */
export type QualityAxis = keyof BenchModel['quality'];

/** Axes measured at one exact effort and never estimated across efforts. */
export type ExactQuality = Pick<BenchModel['quality'], 'knowledge' | 'research' | 'longContext' | 'visionReasoning'>;

export type QualityExclusionReason = `below-${QualityAxis}-minimum` | 'unknown-quality';

export interface CandidateDiagnostic {
  /** Candidate key (`provider/id` or `provider/id:effort`) that left the first capability tier. */
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
   * when a bench row (measured or stepped down) exists for exactly this
   * (model, effort) pair; absent means "no effort label", and Pi's session
   * thinking level applies.
   */
  effort?: ModelThinkingLevel;
  /**
   * Exact-effort measurements of this model at each effort it was measured
   * at. Delegation may serve a higher effort than the candidate's own (a gap
   * in the support map, or the incumbent's minimum thinking level), and
   * these axes are never estimated across efforts, so eligibility reads them
   * at the served effort. Every sibling
   * keeps the map so filtering cannot erase serving evidence.
   */
  exactQualityByEffort?: Partial<Record<ModelThinkingLevel, ExactQuality>>;
  contextWindow?: number;
  maxTokens?: number;
  /** Whether the registry claims vision support (from input array). */
  vision?: boolean;
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  /**
   * True when a reasoning-effort change keeps this model's prompt cache. Only
   * per-message effort does (`anthropic-messages` with
   * `compat.supportsMidConvoEffort`): elsewhere effort is part of the cache
   * key, so each effort level has a cache of its own.
   */
  effortSharesCache?: boolean;
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

export type TaskScope = 'bounded' | 'open-ended';
export type ComplexityBand = 'trivial' | 'routine' | 'moderate' | 'hard' | 'frontier';
export type CapabilityBand = 'economy' | 'standard' | 'strong' | 'frontier';

export type RubricCriterion = 'openDecisions' | 'spread' | 'verification' | 'knowledge' | 'coupling';
/** Submitter's description of the remaining work: one level per criterion, 1 (easiest) to 5 (hardest). */
export type ExecutionRubric = Record<RubricCriterion, number>;

export type ReasoningCriterion = 'alternatives' | 'stakes' | 'spread' | 'knowledge' | 'uncertainty';
/** Investigator's description of the planning, review, or investigation left to do: 1 (easiest) to 5 (hardest). */
export type ReasoningRubric = Record<ReasoningCriterion, number>;

/**
 * Facts the router measures about the files a planning or review handoff
 * rests on; an undefined field means the measurement failed.
 */
export interface ReasoningEvidence {
  /** False when no file backs the handoff: the evidence is in the conversation. */
  applicable: boolean;
  files: number;
  directories: number;
  existingLines?: number;
  /** Commits touching the files in the history window. Logged; not weighted. */
  commits?: number;
  fixCommits?: number;
}

/** A task type that a handoff values with a rubric. `gather` is an investigation that collecting context hands off. */
export type HandoffTarget = 'plan' | 'review' | 'implement' | 'gather';
/** The execution rubric of an implementation, or the reasoning rubric of a plan, review, or investigation. */
export type HandoffRubric = ExecutionRubric | ReasoningRubric;

/**
 * An accepted context handoff to a plan, review, implementation, or investigation,
 * as routing and logs see it. The identifier keeps its name in the decision log.
 */
export interface ReasoningHandoffMeta {
  /** Joins the handoff to later records; the intent key of the entry that accepted it. */
  id: string;
  /** Served key of the model that called the tool. */
  requester: string;
  target: HandoffTarget;
  /** The declared rubric; a missing rubric uses complexity bounds when declared. */
  rubric?: HandoffRubric;
  complexity?: ComplexityBand;
  scope?: TaskScope;
  evidence: ReasoningEvidence;
  /** The boundary still releases the incumbent: no invocation has served the phase yet. */
  pending: boolean;
  /** Served key of the model that received the phase. */
  owner?: string;
  /** Objective trajectory escalation repicked inside the phase. */
  trajectoryFired?: boolean;
  /** An execution contract was accepted after the handoff. */
  contractAccepted?: boolean;
}

/** Plan facts the router measures; an undefined field means the measurement failed. */
export interface MeasuredFeatures {
  /** Distinct declared file targets. */
  files: number;
  /** Distinct parent directories of those targets. */
  directories: number;
  steps: number;
  /** Targets that look like test files. Logged for fitting; not weighted. */
  testTargets: number;
  /** Lines in the edit/delete targets that already exist. */
  existingLines?: number;
  /**
   * Edit/delete targets that do not exist on disk; undefined when any
   * target's existence could not be checked.
   */
  missingTargets?: number;
  /** Commits touching the targets in the history window. Logged; not weighted. */
  commits?: number;
  /** Of those commits, the ones whose subject reads as a fix. */
  fixCommits?: number;
}

/** Why an accepted plan stays with its submitter. */
export type ContractKeepReason = 'size' | 'unknown-target' | 'delete' | 'open-decisions';

/** How a contract ended; the label its logged features are fitted against. */
export type ContractOutcome = 'clean' | 'fixed' | 'rework' | 'broken' | 'unfinished';

export interface ExecutionContractMeta {
  /** `executed`: every declared edit/create target was edited, or the step budget ran out. */
  status: 'active' | 'executed' | 'broken';
  /** False when the submitting model keeps executing the plan. */
  release: boolean;
  keepReason?: ContractKeepReason;
  /** Undefined when the submitter scored no criterion. */
  rubric?: ExecutionRubric;
  measured: MeasuredFeatures;
  /** Declared facts as codes, router measurements, and the shadow requirement. */
  facts?: FactsLog;
  submitter: string;
  targets: number;
  steps: number;
  /** Model other than the submitter that edited a declared target. */
  executor?: string;
  executedReason?: 'complete' | 'budget';
  /** The submitter edited files while reviewing the executed plan. */
  reviewEdited?: boolean;
  /** First verifier result observed after execution. */
  reviewVerifier?: 'pass' | 'fail';
  /**
   * `unattributed-mutation`: a shell command that writes files, which the
   * router cannot check against the declared targets. It breaks the plan
   * without a strike, since the write may well be inside the plan.
   */
  breakReason?: 'undeclared-target' | 'unattributed-mutation' | 'replan' | 'struggle';
  breaker?: string;
  /** Executor models excluded for this task after repeated breaks. */
  excludedExecutors?: string[];
  /** Context handoff this plan followed, in the same entry or the one before. */
  handoffId?: string;
}

/** Catalog choice of work, by id or reserved value; the router derives the relation. */
export interface WorkChoice {
  topicId: string;
  workItemId: string;
}

/**
 * The entry's work-context resolution as routing and logs see it: the tier
 * that decided it, ids, and categories. Titles and summaries stay out.
 */
export interface WorkContextMeta {
  resolver: ResolverTier;
  relation: ContextRelation;
  topicId: string;
  workItemId: string;
  /** Reasons the request owed context; empty when it owed none. */
  contextReasons: ContextReason[];
  /** Whether the router found that context in hand when the entry resolved. */
  contextSatisfied: boolean;
  createdWorkItem?: boolean;
  /** Placed on work found in the conversation from before tracking started. */
  legacy?: boolean;
}

export type DecisionCause =
  | 'heuristic'
  | 'continuation-context'
  | 'router-consult'
  | 'execution-contract'
  | 'investigation'
  | 'investigation-handoff'
  | 'error-fallback'
  | 'no-data'
  | 'capability-escalation'
  | 'trajectory-escalation'
  | 'self-healing-gap'
  | 'manual-override'
  | 'resume'
  | 'semi-hold'
  | 'incumbent'
  | 'work-context';

/**
 * The terminal accounting of one provider attempt. The delegation loop emits
 * one event for each attempt that reached the provider, including a failed
 * attempt and a retry. It has ids, codes, and counts only.
 */
export interface AttemptUsageEvent {
  /** Unique for each attempt. Deduplication uses only this value. */
  usageEventId: string;
  provider: string;
  modelId: string;
  /** The candidate key. It has the effort that the attempt requested. */
  candidateKey: string;
  servedEffort?: string;
  /** True when the attempt ended without a failure. */
  served: boolean;
  /** Why the attempt failed: a category and an HTTP status, never the provider message. */
  failure?: { category: string; status?: number };
  /** Elapsed ms since attempt start, including auth. Missing milestones were not reached. */
  timing?: {
    authMs?: number;
    firstEventMs?: number;
    firstOutputMs?: number;
    durationMs: number;
    /** Longest silence after auth, including the initial and final waits. */
    maxEventGapMs: number;
  };
  /** These flags explain why released output prevents replay after a failure. */
  outputState?: { visibleTextReceived: boolean; toolCallReceived: boolean; committedToStream: boolean };
  /** Absent when the provider reported no usage. */
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** True when the provider reported a terminal usage. Otherwise the spend is a lower bound. */
  usageComplete: boolean;
  /** For a cross-check only. It is not on the scale of the registry price. */
  providerReportedUsd?: number;
  /** Registry price in USD per 1M tokens, when it is known. */
  price?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

/** The numbers that ordered one action in a unified decision. */
export interface UnifiedActionTrace {
  key: string;
  /** Position in the full ranking, starting at 1. */
  rank: number;
  /** Diagnostic: largest relevant-axis shortfall. It does not order actions. */
  capabilityShortfall?: number;
  /**
   * Exact max regret; absent for a central fallback. With `regretScope: 'pool'`
   * the value is against the whole pool. A record without that marker can hold
   * values that are comparable only among actions of equal shortfall.
   */
  maxRegret?: number;
  /** Dot product of the fallback weights and the central features; absent for an exact decision. */
  centralScore?: number;
  /** Central feature values by feature name. */
  features: Record<string, number>;
  /** Predicted spend in USD; absent when the price is unknown. */
  costUsd?: { central: number; min?: number; max?: number };
  /** Billed prompt tokens per estimated token of the action's model; absent when 1. */
  promptTokenScale?: number;
  /** Required quality axes without evidence. */
  evidenceGaps: string[];
}

/** Evidence of a unified selection: identities, codes, counts and the numbers that ordered the best actions. */
export interface UnifiedDecisionMeta {
  solver: 'exact' | 'fallback-central' | 'no-feasible-action';
  solverFallbackReason?: string;
  domainStatus: string;
  /** False when preference answers exist but were not applied. */
  constraintsEnforced: boolean;
  /** Weight-domain mode that ordered this pick. Absent when no artifact was applied. */
  domainMode?: 'base' | 'hard' | 'min-slack';
  /** Minimum total slack when the domain used uniform slack. */
  totalSlack?: number;
  profileDigest: string;
  compiledDomainIdentity?: string;
  benchmarkSnapshotDigest?: string;
  featureSchemaDigest: string;
  /** Present on exact decisions whose regret values compare every ranked action. */
  regretScope?: 'pool';
  /** Numerically valid legal actions in the ranking. */
  ranked: number;
  /** Diagnostic: malformed or duplicate actions excluded from ranking and dispatch fallback. */
  invalidActions?: string[];
  /** Diagnostic: ranked actions without evidence for a required quality axis. */
  insufficientEvidence: number;
  /** Ranked actions whose window holds the current prompt. */
  holdingPrompt: number;
  /** Better-ranked action that waits for context preparation. */
  preparationTarget?: string;
  /** Maximum central axis demand. Absent means unknown, with bounds [0, 1]. */
  difficulty?: number;
  difficultyAxes?: { reasoning: number; agentic: number; research: number };
  difficultySource?: 'execution-rubric' | 'reasoning-rubric' | 'declared-complexity';
  /** Bounds that map to capability-fit intervals. Collection uses its fixed targets instead. */
  difficultyBounds?: Record<'reasoning' | 'agentic' | 'research', { lower: number; upper: number }>;
  /** Why demand is absent. An absent code in an older record is not evidence of a cause. */
  difficultyMissingReason?: 'collecting-context' | 'direct-answer' | 'no-rubric' | 'phase-mismatch' | 'continuation' | 'no-handoff';
  /** Weights of a central fallback, in feature order. */
  theta?: number[];
  /** Best-ranked actions (all of them in debug), the chosen action and the incumbent, with their numbers. */
  top?: UnifiedActionTrace[];
}

export interface RoutingDecision {
  dimension: Dimension;
  /** Present when the unified selector made this decision. */
  unified?: UnifiedDecisionMeta;
  /** Set only when an evaluation process runs the candidate policy. */
  policyVersion?: import('./routing/policy/policy-version.js').PolicyVersion;
  /** Frozen capability inputs of the development comparator. No task text or paths. */
  capabilityEvidence?: {
    policyDigest: string;
    comparisonAxis: QualityAxis;
    metricVersion: string;
    benchmarkIndexVersion?: string;
    benchmarkSnapshotDigest?: string;
    minimums: Readonly<Partial<Record<QualityAxis, number>>>;
  };
  /**
   * The incumbent's minimum thinking level: the model (`provider/id`) that
   * served the task and the effort it served at. Chain entries of that model
   * serve at this effort or higher, so a same-task follow-up that keeps the
   * incumbent does not drop to a lower effort. An explicit user thinking
   * level still wins. Absent when the incumbent minimums are skipped.
   */
  incumbentEffort?: { model: string; effort: ModelThinkingLevel };
  chosen: string;
  reason: string;
  /** Typed source for scorer and policy wording; reason remains the rendered log/UI value. */
  scoredReason?: ScoredReason;
  /** Historical classification metadata; not emitted by routing. */
  confidence?: number;
  routedUp?: boolean;
  /**
   * True when the routed dimension is strictly weaker than the heuristic's.
   * Distinct from `routedUp` because "different" and "stronger" are not the
   * same question, and context-pressure advice is only meaningful upward.
   */
  routedDown?: boolean;
  /**
   * True only when a routedUp/routedDown actually changed the served model
   * versus the model the un-escalated (heuristic) dimension would have picked.
   * A dimension raise that re-selects the same model served nothing stronger,
   * so the status UI suppresses the "routed-up"/"routed-down" label when this
   * is false. Undefined when neither direction fired. `routedUp`/`routedDown`
   * keep their dimension-level meaning for the decision log and `cause`.
   */
  routedPickChanged?: boolean;
  /** Intent cache key joining this routing decision to later records. */
  intentKey?: string;
  /** A mutation tool call was observed; the task type may still be plan/review. */
  mutationObserved?: boolean;
  /** Execution contract that shaped this invocation, active or just broken. */
  executionContract?: ExecutionContractMeta;
  /** The task type the entry owes when the routed phase is collecting context before it. */
  deliverable?: Dimension;
  /** Context handoff that shaped this invocation. */
  reasoningHandoff?: ReasoningHandoffMeta;
  /** Handoff of the previous entry, on the first decision of the entry after it. */
  previousHandoffId?: string;
  /** Message-origin census for this turn's context. */
  provenanceCounts?: Record<MessageProvenance, number>;
  /** The entry's work-context resolution. */
  workContext?: WorkContextMeta;
  cause: DecisionCause;
  fallbackChain: string[];
  /** Capability-tier evidence for candidates that were demoted or promoted. */
  candidateDiagnostics?: CandidateDiagnostic[];
  /** True if the chosen model differs from the previous turn's model. */
  switched?: boolean;
  /** Objective trajectory-friction evidence when it influenced the pick. */
  trajectoryFriction?: {
    tfi: number;
    signals: Array<{
      kind: 'aor' | 'failure-persistence' | 'backtracking' | 'stagnation' | 'reasoning-loop';
      severity: 'warning' | 'severe';
      evidenceCount: number;
    }>;
    fromModel: string;
    preOutput: boolean;
    unavailable?: boolean;
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
   * `incomplete` is true when an attempt ended without terminal usage, so
   * routed spend is a lower bound and must not be presented as complete
   * savings. Partial/zero-initialized usage during an abandoned stream is
   * counted once but does not make the turn complete.
   */
  spend?: { routedCost: number; baselineCost?: number; incomplete?: boolean };
}

export type Role = 'researcher' | 'planner' | 'worker' | 'reviewer' | 'advisor';

export const ROLE_DIMENSIONS: Record<Role, Dimension> = {
  researcher: 'plan',
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
  /** Collect global counts and use exact-prefix cache credit; default true. */
  reputation?: boolean;
  /** Unset means compliance collection only until weights are fitted. */
  reputationWeights?: { reminder: number; ignored: number };
  /** Free API key for artificialanalysis.ai (optional but recommended). */
  artificialAnalysisApiKey?: string;
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
  /**
   * Show a TUI notification when the router picks/switches the model for a
   * turn (default true). The footer status widget updates regardless.
   */
  prompt: boolean;
  /**
   * Semi-automatic mode (default false). When true and the router would switch
   * away from the model that served the previous turn, the user is asked to
   * confirm the switch before delegating: accept the new model, keep the
   * current one for this turn only, or pin a specific model (acts as
   * `/router-manual`). Requires an interactive UI; a no-op without one.
   */
  semi: boolean;
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
}

export interface SyncResult {
  source: string;
  ok: boolean;
  fetched: number;
  matched: number;
  unresolved: number;
  error?: string;
  /** A successful sync that saved data the minimums are not calibrated for. */
  warning?: string;
}
