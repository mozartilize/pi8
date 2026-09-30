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
  ContractOutcome,
  ExecutionContractMeta,
  CandidateDiagnostic,
  Dimension,
  ReasoningHandoffMeta,
  RoutingDecision,
  WorkContextMeta,
} from '../types.js';
import type { ContextReason } from '../routing/context/types.js';
import { resolveStoragePath } from '../bench/store.js';
import { servedKey } from './ui.js';
import { sessionSidecarPath } from '../sessionpaths.js';

export const DECISION_LOG_FILE = 'decisions.jsonl';
/**
 * Schema version stamped on every record. Records without one predate
 * versioning; readers treat their fields as they were written and never
 * reinterpret them under a later schema.
 */
export const DECISION_LOG_SCHEMA_VERSION = 4;
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
  /** {@link DECISION_LOG_SCHEMA_VERSION} at write time; absent on unversioned records. */
  schemaVersion?: number;
  /** Discriminator. Absent or 'decision' for routing decisions. */
  kind?: 'decision' | 'subagent-spend' | 'execution-contract' | 'investigation-handoff';
  dimension: string;
  /** Final chosen model; after fallback this is the served model. */
  chosen: string;
  /** Model that actually served the turn. */
  served: string;
  /** True when an earlier candidate failed before this model served. */
  viaFallback: boolean;
  /** 1-based rank of the served candidate in the chain (undefined if top pick). */
  fallbackRank?: number;
  /** The keyword classifier's confidence; routing decisions only. */
  confidence?: number;
  routedUp?: boolean;
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
  /** Intent cache key joining this entry's classification to later log records. */
  intentKey?: string;
  /** Set on `kind: 'investigation-handoff'` records only. */
  investigationHandoff?: {
    action: InvestigationHandoffSignal['action'];
    /** Router-authored reject code, never the findings. */
    rejectReason?: string;
    handoff?: ReasoningHandoffMeta;
    deliverable?: Dimension;
    /** Why the entry owed context, as categories. */
    contextReasons?: ContextReason[];
  };
  /** The entry's work-context resolution: tier, ids, categories; never titles. */
  workContext?: WorkContextMeta;
  /** Routed phase records: the deliverable behind an investigation, and the join to the previous entry's handoff. */
  deliverable?: string;
  reasoningHandoff?: ReasoningHandoffMeta;
  previousHandoffId?: string;
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
  /** Message-origin census; a spike in compaction-summary explains drift. */
  provenance?: Record<string, number>;
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
}

/** One JSONL line, stamped with the schema version it was written under. */
function serializeRecord(entry: DecisionLogEntry): string {
  return JSON.stringify({ schemaVersion: DECISION_LOG_SCHEMA_VERSION, ...entry }) + '\n';
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
   * `nudge` marks a plan/review change attempted without a plan: a missed handoff.
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
    appendFileSync(path, serializeRecord(entry), 'utf8');
  } catch {
    // A logging failure must never fail the user's turn.
  }
}

/**
 * One investigation → planning/review handoff transition. Model keys, codes,
 * rubric levels and counts only: never the findings, the question, or paths.
 */
export interface InvestigationHandoffSignal {
  intentKey: string;
  /** Model that handed off, was declined, was reminded, or owns the phase. */
  served: string;
  /**
   * `nudge` marks a reminder to hand off; `deny` a call refused while
   * collecting context. `needs-user` and `budget-exhausted` mark collecting
   * context ending in a question to the user: the model asked for it, or the
   * entry spent its requests or refusals. `served` marks the first invocation
   * that served the next phase. At entry end, `phase-end` closes an accepted
   * handoff and `no-handoff` owed context that was never handed off.
   */
  action:
    | 'accept' | 'answer' | 'reject' | 'nudge' | 'deny' | 'needs-user' | 'budget-exhausted'
    | 'served' | 'phase-end' | 'no-handoff';
  rejectReason?: string;
  handoff?: ReasoningHandoffMeta;
  deliverable?: Dimension;
  contextReasons?: ContextReason[];
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
      cause: 'investigation-handoff',
      reason: `investigation handoff ${signal.action}`,
      chain: [signal.served],
      intentKey: signal.intentKey,
      investigationHandoff: {
        action: signal.action,
        ...(signal.rejectReason ? { rejectReason: signal.rejectReason } : {}),
        ...(signal.handoff ? { handoff: signal.handoff } : {}),
        ...(signal.deliverable ? { deliverable: signal.deliverable } : {}),
        ...(signal.contextReasons?.length ? { contextReasons: signal.contextReasons } : {}),
      },
    };
    appendFileSync(path, serializeRecord(entry), 'utf8');
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
        provenance: decision.provenanceCounts,
      trajectoryFriction: decision.trajectoryFriction,
      contextPressure: decision.contextPressure,
      candidateDiagnostics: decision.candidateDiagnostics,
      ...(decision.executionContract
        ? { executionContract: { action: 'route' as const, meta: decision.executionContract } }
        : {}),
      ...(decision.workContext ? { workContext: decision.workContext } : {}),
      ...(decision.deliverable ? { deliverable: decision.deliverable } : {}),
      ...(decision.reasoningHandoff ? { reasoningHandoff: decision.reasoningHandoff } : {}),
      ...(decision.previousHandoffId
        ? { previousHandoffId: decision.previousHandoffId }
        : {}),
    };
    appendFileSync(path, serializeRecord(entry), 'utf8');
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
    appendFileSync(path, serializeRecord(entry), 'utf8');
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
    appendFileSync(path, serializeRecord(entry), 'utf8');
  } catch {
    // Best-effort logging only.
  }
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
