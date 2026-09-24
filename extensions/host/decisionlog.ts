/**
 * Decision log (M4 substrate).
 *
 * Append-only JSONL of every routing decision. Cheap to write (one line per
 * turn) and the foundation for v2 learning (implicit session signals feeding a
 * Thompson-sampling bandit, per the LiteLLM adaptive_router findings).
 *
 * For now it captures *what actually happened*, including real fallbacks, so
 * `/router-status` can show routing history and we can later mine correction /
 * fallback patterns. The router NEVER reads this back in v1.
 */
import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type {
  AssessmentFallbackReason,
  ContractOutcome,
  ExecutionContractMeta,
  CandidateDiagnostic,
  Dimension,
  RoutingAssessment,
  RoutingDecision,
} from '../types.js';
import { resolveStoragePath } from '../bench/store.js';
import { servedKey } from './ui.js';
import { sessionSidecarPath } from '../sessionpaths.js';
import { ASSESSMENT_PROMPT_VERSION } from '../routing/consult/assessment-prompt.js';
import { DIMENSION_STRENGTH } from '../routing/classify/classifier-keywords.js';
import type { MutationSignal, MutationSurface } from '../routing/policy/mutation-detector.js';

export const DECISION_LOG_FILE = 'decisions.jsonl';
/** Sidecar suffix used when writing next to a persisted session file. */
export const DECISION_SIDECAR_SUFFIX = 'router-decisions.jsonl';

let decisionLogBaseOverride: string | undefined;

/** Test/runtime seam; undefined preserves the normal user-scope path. */
export function setDecisionLogBase(base?: string): void {
  decisionLogBaseOverride = base;
}

/**
 * Resolve where the decision log lives, in priority order:
 *  1. explicit `storageBase` argument (tests)
 *  2. `setDecisionLogBase` override (tests)
 *  3. per-session sidecar next to the session .jsonl (each session its own log)
 *  4. shared ~/.pi/agent/pi8/decisions.jsonl (ephemeral sessions)
 */
function decisionLogPath(storageBase?: string): string {
  if (storageBase) return join(resolveStoragePath(storageBase), DECISION_LOG_FILE);
  if (decisionLogBaseOverride) return join(resolveStoragePath(decisionLogBaseOverride), DECISION_LOG_FILE);
  const sidecar = sessionSidecarPath(DECISION_SIDECAR_SUFFIX);
  if (sidecar) return sidecar;
  return join(resolveStoragePath(), DECISION_LOG_FILE);
}

export interface DecisionLogEntry {
  ts: number;
  /** Discriminator. Absent or 'decision' for routing decisions. */
  kind?: 'decision' | 'assessment-metric' | 'mutation-gate' | 'subagent-spend' | 'execution-contract' | 'investigation-handoff';
  dimension: string;
  /** Final chosen model; after fallback this is the served model. */
  chosen: string;
  /** Model that actually served the turn. */
  served: string;
  /** True when an earlier candidate failed before this model served. */
  viaFallback: boolean;
  /** 1-based rank of the served candidate in the chain (undefined if top pick). */
  fallbackRank?: number;
  confidence: number;
  routedUp: boolean;
  routedDown?: boolean;
  cause: string;
  reason: string;
  /** Final fallback chain, with the served model first. */
  chain: string[];
  /** Session cost accumulated at decision time, USD. */
  accumulatedCost?: number;
  /** Per-turn token totals, summed across every attempt including failed ones. */
  usage?: { inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number };
  /** Counterfactual baseline this turn was priced against, and how it was picked. */
  baselineModel?: string;
  baselineSource?: 'config' | 'auto';
  /**
   * Actual vs counterfactual spend for `/router-report`, both priced from
   * registry $/token at the same observed `usage` — never `cost.total`
   * billing, which is a different scale. `baselineCost` absent means no
   * baseline resolved for this turn.
   */
  routedCost?: number;
  baselineCost?: number;
  /** True when an attempt ended without observed usage; routed spend is a lower bound. */
  spendIncomplete?: boolean;
  /** Objective trajectory-friction evidence when it influenced the pick. */
  trajectoryFriction?: RoutingDecision['trajectoryFriction'];
  /** Set on `kind: 'subagent-spend'` records only. */
  subagentSpend?: {
    role?: string;
    routerOwned: boolean;
    reportedCost?: number;
  };
  /** Intent cache key joining assessment telemetry to routing decisions. */
  intentKey?: string;
  /** Set on `kind: 'investigation-handoff'` records only. */
  investigationHandoff?: {
    action: InvestigationHandoffSignal['action'];
    /** Router-authored reject code, never the findings. */
    rejectReason?: string;
  };
  /** Set on `kind: 'execution-contract'` records only. */
  executionContract?: {
    /** `route` marks a routing decision the contract shaped. */
    action: ExecutionContractSignal['action'] | 'route';
    /** Why a submission was refused; router-authored text, never plan content. */
    rejectReason?: string;
    /** Set on `outcome` records: how the contract ended. */
    outcome?: ContractOutcome;
    meta?: ExecutionContractMeta;
  };
  assessmentPromptVersion?: string;
  /** Why the assessment was unavailable. Never changes `cause`. */
  fallbackReason?: string;
  /** Message-origin census; a spike in compaction-summary explains drift. */
  provenance?: Record<string, number>;
  /** Verdict metadata when an assessment ran for this intent, adopted or not. */
  assessment?: {
    kind: string;
    complexity: string;
    scope: string;
    compound: boolean;
    confidence: string;
    reasoning: string;
    model: string;
    ms: number;
    costUsd: number;
  };
  /** Assessment-metric fields: the heuristic the verdict is measured against. */
  heuristicDimension?: string;
  /** Assessment-adopted dimension before later routing precedence. */
  counterfactualDimension?: string;
  /** Strength difference assessment − heuristic. */
  dimensionDelta?: number;
  /** True when this metric records a latch transition. */
  latchTransition?: boolean;
  /** True when the assessment vetoed the latch escalation. */
  wouldVetoLatch?: boolean;
  /** Populated when an inline LLM consultation ran (adopted or not). */
  consult?: {
    model: string;
    ms: number;
    heuristicDimension: string;
    verdict?: string;
    adopted?: boolean;
  };
  /** Historical route_up records only; live decisions no longer write this. */
  escalation?: {
    requestedDimension: string;
    heuristicDimension: string;
    reason: string;
  };
  /** Populated when high parent-context pressure is detected. */
  contextPressure?: {
    usageRatio: number;
    threshold: number;
    suggestion: string;
  };
  /** Capability-tier evidence from the scored fallback chain. */
  candidateDiagnostics?: CandidateDiagnostic[];
  /** Subagent tool-gap observation (v2 read-only detector substrate). */
  gap?: {
    role?: string;
    tool: string;
    model?: string;
    requestedTools?: string[];
    allowedTools?: string[];
    workaroundTool?: string;
  };
  /** Mutation-gate secondary observability record. */
  mutationGate?: {
    providerInvocation: number;
    gateBlockedInvocation?: number;
    terminalFloor?: number;
    servedTaskRatio?: number;
    clearance: boolean | 'unknown';
    action: 'block' | 'allow' | 'escape' | 'complete' | 'error';
    capabilityDegraded?: boolean;
    /** Enum classifier output; never command text or tool arguments. */
    mutationSurface?: MutationSurface;
    mutationSignal?: MutationSignal;
  };
}

/** A durable, joinable secondary record of one mutation-gate transition. Never
 *  serializes tool arguments or payload content — identity and clearance only. */
export interface MutationGateSignal {
  intentKey: string;
  served: string;
  providerInvocation: number;
  gateBlockedInvocation?: number;
  terminalFloor?: number;
  servedTaskRatio?: number;
  clearance: boolean | 'unknown';
  action: 'block' | 'allow' | 'escape' | 'complete' | 'error';
  capabilityDegraded?: boolean;
  /** Enum classifier output; never command text or tool arguments. */
  mutationSurface?: MutationSurface;
  mutationSignal?: MutationSignal;
}

function serializeAssessment(
  assessment: RoutingAssessment | undefined,
): DecisionLogEntry['assessment'] {
  if (!assessment) return undefined;
  return {
    kind: assessment.kind,
    complexity: assessment.complexity,
    scope: assessment.scope,
    compound: assessment.compound,
    confidence: assessment.confidence,
    reasoning: assessment.reasoning,
    model: assessment.model,
    ms: assessment.ms,
    costUsd: assessment.costUsd,
  };
}

/** Append a mutation-gate transition. Best-effort; never throws into the tool call/result path. */
export function appendMutationGateSignal(
  signal: MutationGateSignal,
  storageBase?: string,
): void {
  try {
    const path = decisionLogPath(storageBase);
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const entry: DecisionLogEntry = {
      ts: Date.now(),
      kind: 'mutation-gate',
      dimension: 'implement',
      chosen: signal.served,
      served: signal.served,
      viaFallback: false,
      confidence: 1,
      routedUp: false,
      cause: 'heuristic',
      reason: `mutation gate ${signal.action}`,
      chain: [signal.served],
      intentKey: signal.intentKey,
      mutationGate: {
        providerInvocation: signal.providerInvocation,
        gateBlockedInvocation: signal.gateBlockedInvocation,
        terminalFloor: signal.terminalFloor,
        servedTaskRatio: signal.servedTaskRatio,
        clearance: signal.clearance,
        action: signal.action,
        capabilityDegraded: signal.capabilityDegraded,
        mutationSurface: signal.mutationSurface,
        mutationSignal: signal.mutationSignal,
      },
    };
    appendFileSync(path, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // A logging failure must never fail the user's turn.
  }
}

/** One execution-contract transition. Rubric levels, counts, and model keys
 *  only: never the plan's paths or change descriptions. */
export interface ExecutionContractSignal {
  intentKey: string;
  /**
   * Model that submitted (accept/reject), broke (break), or finished (execute)
   * the contract; for `outcome`, its executor, else its submitter.
   */
  served: string;
  /**
   * `nudge` marks a plan/review edit made without a plan: a missed handoff.
   * `outcome` closes a contract with the label its features are fitted against.
   */
  action: 'accept' | 'reject' | 'break' | 'nudge' | 'execute' | 'outcome';
  rejectReason?: string;
  outcome?: ContractOutcome;
  meta?: ExecutionContractMeta;
}

/** Append an execution-contract transition. Best-effort; never throws into the tool path. */
export function appendExecutionContractSignal(
  signal: ExecutionContractSignal,
  storageBase?: string,
): void {
  try {
    const path = decisionLogPath(storageBase);
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const entry: DecisionLogEntry = {
      ts: Date.now(),
      kind: 'execution-contract',
      dimension: 'implement',
      chosen: signal.served,
      served: signal.served,
      viaFallback: false,
      confidence: 1,
      routedUp: false,
      cause: 'execution-contract',
      reason: `execution contract ${signal.action}`,
      chain: [signal.served],
      intentKey: signal.intentKey,
      executionContract: {
        action: signal.action,
        ...(signal.rejectReason ? { rejectReason: signal.rejectReason } : {}),
        ...(signal.outcome ? { outcome: signal.outcome } : {}),
        ...(signal.meta ? { meta: signal.meta } : {}),
      },
    };
    appendFileSync(path, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // A logging failure must never fail the user's turn.
  }
}

/** One investigation → planning handoff transition. Model keys and codes only: never the findings. */
export interface InvestigationHandoffSignal {
  intentKey: string;
  /** Model that requested planning, was declined, or was reminded. */
  served: string;
  /** `nudge` marks an investigation edit made without a handoff. */
  action: 'accept' | 'reject' | 'nudge';
  rejectReason?: string;
}

/** Append an investigation handoff transition. Best-effort; never throws into the tool path. */
export function appendInvestigationHandoffSignal(
  signal: InvestigationHandoffSignal,
  storageBase?: string,
): void {
  try {
    const path = decisionLogPath(storageBase);
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const entry: DecisionLogEntry = {
      ts: Date.now(),
      kind: 'investigation-handoff',
      dimension: 'gather',
      chosen: signal.served,
      served: signal.served,
      viaFallback: false,
      confidence: 1,
      routedUp: false,
      cause: 'investigation-handoff',
      reason: `investigation handoff ${signal.action}`,
      chain: [signal.served],
      intentKey: signal.intentKey,
      investigationHandoff: {
        action: signal.action,
        ...(signal.rejectReason ? { rejectReason: signal.rejectReason } : {}),
      },
    };
    appendFileSync(path, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // A logging failure must never fail the user's turn.
  }
}

/**
 * Append a decision to the log. Never throws into the routing path — a logging
 * failure must not fail the user's turn.
 */
export function appendDecision(
  decision: RoutingDecision,
  served: { registryId: string; thinkingLevel?: string; viaFallback: boolean; fallbackRank?: number; accumulatedCost: number },
  storageBase?: string,
): void {
  try {
    const path = decisionLogPath(storageBase);
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const servedModel = servedKey(served);
    const entry: DecisionLogEntry = {
      ts: Date.now(),
      dimension: decision.dimension,
      chosen: decision.chosen,
      served: servedModel,
      viaFallback: served.viaFallback,
      fallbackRank: served.fallbackRank,
      confidence: decision.confidence,
      routedUp: decision.routedUp,
      routedDown: decision.routedDown,
      cause: decision.cause,
      reason: decision.reason,
      chain: decision.fallbackChain,
      accumulatedCost: served.accumulatedCost,
      usage: decision.usage,
      baselineModel: decision.baseline?.registryId,
      baselineSource: decision.baseline?.source,
      routedCost: decision.spend?.routedCost,
      baselineCost: decision.spend?.baselineCost,
      spendIncomplete: decision.spend?.incomplete,
      intentKey: decision.intentKey,
      fallbackReason: decision.fallbackReason,
      provenance: decision.provenanceCounts,
      assessment: serializeAssessment(decision.assessment),
      assessmentPromptVersion: decision.assessment ? ASSESSMENT_PROMPT_VERSION : undefined,
      trajectoryFriction: decision.trajectoryFriction,
      contextPressure: decision.contextPressure,
      candidateDiagnostics: decision.candidateDiagnostics,
      ...(decision.executionContract
        ? { executionContract: { action: 'route' as const, meta: decision.executionContract } }
        : {}),
    };
    appendFileSync(path, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // Logging is best-effort.
  }
}

/** Append a subagent tool-gap observation for the read-only gap detector. */
export function appendSubagentGapSignal(
  event: {
    role?: string;
    tool: string;
    model?: string;
    requestedTools?: string[];
    allowedTools?: string[];
    workaroundTool?: string;
  },
  storageBase?: string,
): void {
  try {
    const path = decisionLogPath(storageBase);
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const model = event.model ?? 'unknown/unknown';
    const entry: DecisionLogEntry = {
      ts: Date.now(),
      dimension: 'lightweight',
      chosen: model,
      served: model,
      viaFallback: false,
      confidence: 1,
      routedUp: false,
      cause: 'self-healing-gap',
      reason: `subagent tool gap: ${event.tool}`,
      chain: [model],
      gap: {
        role: event.role,
        tool: event.tool,
        model: event.model,
        requestedTools: event.requestedTools,
        allowedTools: event.allowedTools,
        workaroundTool: event.workaroundTool,
      },
    };
    appendFileSync(path, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // Best-effort logging only.
  }
}

/**
 * One foreground subagent child's spend, joinable with the turn that spawned
 * it. Kept out of `kind: 'decision'` because a child is not a routing turn:
 * folding it into decisions would distort `/router-status` history and the
 * dimension histogram, both of which count turns. Async spawns return before
 * their child finishes and report no terminal usage here, so they are absent
 * by construction rather than counted as zero.
 */
export function appendSubagentSpend(
  record: {
    role?: string;
    model: string;
    routerOwned: boolean;
    usage: { inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number };
    routedCost?: number;
    baselineModel?: string;
    baselineSource?: 'config' | 'auto';
    baselineCost?: number;
    /** pi-subagents' provider-reported billing, kept only as a cross-check. */
    reportedCost?: number;
  },
  storageBase?: string,
): void {
  try {
    const path = decisionLogPath(storageBase);
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const entry: DecisionLogEntry = {
      ts: Date.now(),
      kind: 'subagent-spend',
      dimension: record.role ?? 'subagent',
      chosen: record.model,
      served: record.model,
      viaFallback: false,
      confidence: 1,
      routedUp: false,
      cause: 'heuristic',
      reason: `subagent spend (${record.routerOwned ? 'router-owned' : 'explicit model'})`,
      chain: [record.model],
      usage: record.usage,
      routedCost: record.routedCost,
      baselineModel: record.baselineModel,
      baselineSource: record.baselineSource,
      baselineCost: record.baselineCost,
      subagentSpend: {
        role: record.role,
        routerOwned: record.routerOwned,
        reportedCost: record.reportedCost,
      },
    };
    appendFileSync(path, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // Best-effort logging only.
  }
}

/**
 * Write a separate, joinable assessment record so heuristic-vs-assessment
 * deltas and latch-veto evidence remain queryable without overloading the
 * routing decision entry.
 */
export function appendAssessmentMetric(
  record: AssessmentMetricRecord,
  storageBase?: string,
): void {
  try {
    const path = decisionLogPath(storageBase);
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const delta =
      record.counterfactualDimension === undefined
        ? undefined
        : DIMENSION_STRENGTH[record.counterfactualDimension] -
          DIMENSION_STRENGTH[record.heuristicDimension];
    const entry: DecisionLogEntry = {
      ts: Date.now(),
      kind: 'assessment-metric',
      dimension: record.heuristicDimension,
      chosen: record.assessment?.model ?? 'unknown/unknown',
      served: record.assessment?.model ?? 'unknown/unknown',
      viaFallback: false,
      confidence: 1,
      routedUp: false,
      cause: 'heuristic',
      reason: 'assessment metric',
      chain: [],
      intentKey: record.intentKey,
      heuristicDimension: record.heuristicDimension,
      counterfactualDimension: record.counterfactualDimension,
      dimensionDelta: delta,
      assessment: serializeAssessment(record.assessment),
      assessmentPromptVersion: ASSESSMENT_PROMPT_VERSION,
      fallbackReason: record.fallbackReason,
      latchTransition: record.latchTransition,
      wouldVetoLatch: record.wouldVetoLatch,
    };
    appendFileSync(path, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // A logging failure must never fail the user's turn.
  }
}

/** Assessment telemetry joined to decisions by `intentKey`. */
export interface AssessmentMetricRecord {
  /** Joins this assessment to the decisions taken for the same intent. */
  intentKey: string;
  heuristicDimension: Dimension;
  /** Dimension produced by assessment adoption before later precedence. */
  counterfactualDimension?: Dimension;
  assessment?: RoutingAssessment;
  fallbackReason?: AssessmentFallbackReason;
  latchTransition?: boolean;
  /** True when the assessment vetoed a latch escalation. */
  wouldVetoLatch?: boolean;
}

/** Read the most recent N entries (for /router-status history). */
export function readRecentEntries(
  limit = 10,
  storageBase?: string,
): DecisionLogEntry[] {
  try {
    const path = decisionLogPath(storageBase);
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, 'utf8').trim();
    if (!raw) return [];
    const lines = raw.split('\n');
    const parsed = lines
      .map((l) => {
        try {
          return JSON.parse(l) as DecisionLogEntry;
        } catch {
          return undefined;
        }
      })
      .filter((e): e is DecisionLogEntry => e !== undefined);
    return parsed.slice(-limit);
  } catch {
    return [];
  }
}
