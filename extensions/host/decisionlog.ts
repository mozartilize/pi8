/**
 * Session sidecars preserve decision diagnostics. Global model preferences
 * read the separate counts-only event log, never transcript text.
 */
import { appendModelEvent, modelEntryId, type ModelEvent } from '../bench/model-history.js';
import { loadConfig } from '../config.js';
import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type {
  AttemptUsageEvent,
  ContractOutcome,
  ExecutionContractMeta,
  CandidateDiagnostic,
  Dimension,
  ReasoningHandoffMeta,
  RoutingDecision,
  WorkContextMeta,
} from '../types.js';
import type { ContextReason } from '../routing/context/types.js';
import type { CheckVerdicts, FactsLog } from '../routing/policy/change-facts.js';
import type { DecisionEvidenceV1 } from '../routing/policy/decision-evidence.js';
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
const ephemeralLogScope = randomUUID();
let ephemeralSessionGeneration = 0;

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
  kind?: 'decision' | 'subagent-spend' | 'attempt-usage' | 'execution-contract' | 'investigation-handoff' | 'work-lifecycle';
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
  /** Set only when an evaluation process runs the candidate policy. */
  policyVersion?: string;
  capabilityEvidence?: RoutingDecision['capabilityEvidence'];
  /** Objective trajectory-friction evidence when it influenced the pick. */
  trajectoryFriction?: RoutingDecision['trajectoryFriction'];
  /** Set on `kind: 'attempt-usage'` records only. */
  attemptUsage?: AttemptUsageEvent;
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
    action: ContextHandoffSignal['action'];
    /** Router-authored reject code, never the findings. */
    rejectReason?: string;
    handoff?: ReasoningHandoffMeta;
    deliverable?: Dimension;
    /** Why the entry owed context, as categories. */
    contextReasons?: ContextReason[];
    /** Codes and measurements of the declared facts, and the shadow requirement. */
    facts?: FactsLog;
    /** Verifier results before and after the handoff. */
    checks?: CheckVerdicts;
    /** What the router knew before it chose the next model. */
    evidence?: DecisionEvidenceV1;
    /** Referenced files that owed no read because they are above the grounding size limit. */
    oversizedArtifacts?: number;
  };
  /** The entry's work-context resolution: tier, ids, categories; never titles. */
  workContext?: WorkContextMeta;
  /** Routed phase records: the deliverable behind collecting context, and the join to the previous entry's handoff. */
  deliverable?: string;
  reasoningHandoff?: ReasoningHandoffMeta;
  previousHandoffId?: string;
  /** Set on `kind: 'work-lifecycle'` records only. */
  workLifecycle?: {
    action: WorkLifecycleSignal['action'];
    workItemId?: string;
    /** Router-authored reject code. */
    rejectReason?: string;
    status?: 'done' | 'superseded';
    deliverable?: Dimension;
    reminder?: SettleReminderKind;
    /** Referenced files that owed no read because they are above the grounding size limit. */
    oversizedArtifacts?: number;
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
    /** What the router knew before it chose the executor. */
    evidence?: DecisionEvidenceV1;
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
   * `reminder` marks a plan/review change attempted without a plan: a missed handoff.
   * `outcome` closes a contract with the label its features are fitted against.
   */
  action: 'accept' | 'reject' | 'break' | 'reminder' | 'execute' | 'outcome';
  rejectReason?: string;
  outcome?: ContractOutcome;
  meta?: ExecutionContractMeta;
  evidence?: DecisionEvidenceV1;
}

/** Append an execution-contract transition. Best-effort; never throws into the tool path. */
export function appendExecutionContractSignal(
  signal: ExecutionContractSignal,
  storageBase?: string,
): void {
  try {
    if (signal.action === 'reminder') recordProtocolEvent(signal.intentKey, signal.served, 'reminder', 'contract', undefined, storageBase);
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
        ...(signal.evidence ? { evidence: signal.evidence } : {}),
      },
    };
    appendFileSync(path, serializeRecord(entry), 'utf8');
  } catch {
    // A logging failure must never fail the user's turn.
  }
}

/**
 * One context handoff transition. Model keys, codes,
 * rubric levels and counts only: never the findings, the question, or paths.
 */
export interface ContextHandoffSignal {
  intentKey: string;
  /** Model that handed off, was declined, was reminded, or owns the phase. */
  served: string;
  /**
   * `reminder` marks a reminder to hand off; `deny` a call refused while
   * collecting context. `needs-user` and `budget-exhausted` mark collecting
   * context ending in a question to the user: the model asked for it, or the
   * entry spent its requests or refusals. `served` marks the first invocation
   * that served the next phase. At entry end, `phase-end` closes an accepted
   * handoff and `no-handoff` owed context that was never handed off.
   */
  action:
    | 'accept' | 'answer' | 'reject' | 'reminder' | 'deny' | 'needs-user' | 'budget-exhausted'
    | 'served' | 'phase-end' | 'no-handoff';
  rejectReason?: string;
  handoff?: ReasoningHandoffMeta;
  deliverable?: Dimension;
  contextReasons?: ContextReason[];
  facts?: FactsLog;
  checks?: CheckVerdicts;
  evidence?: DecisionEvidenceV1;
  /** Referenced files that owed no read because they are above the grounding size limit. */
  oversizedArtifacts?: number;
}

/** Append a context handoff transition. Best-effort; never throws into the tool path. */
export function appendContextHandoffSignal(
  signal: ContextHandoffSignal,
  storageBase?: string,
): void {
  try {
    if (signal.action === 'reminder') recordProtocolEvent(signal.intentKey, signal.served, 'reminder', 'context', signal.deliverable, storageBase);
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
      reason: `context handoff ${signal.action}`,
      chain: [signal.served],
      intentKey: signal.intentKey,
      investigationHandoff: {
        action: signal.action,
        ...(signal.rejectReason ? { rejectReason: signal.rejectReason } : {}),
        ...(signal.handoff ? { handoff: signal.handoff } : {}),
        ...(signal.deliverable ? { deliverable: signal.deliverable } : {}),
        ...(signal.contextReasons?.length ? { contextReasons: signal.contextReasons } : {}),
        ...(signal.facts ? { facts: signal.facts } : {}),
        ...(signal.checks ? { checks: signal.checks } : {}),
        ...(signal.evidence ? { evidence: signal.evidence } : {}),
        ...(signal.oversizedArtifacts ? { oversizedArtifacts: signal.oversizedArtifacts } : {}),
      },
    };
    appendFileSync(path, serializeRecord(entry), 'utf8');
  } catch {
    // A logging failure must never fail the user's turn.
  }
}

/**
 * One work item lifecycle transition the model declared or the router
 * enforced. Ids, codes and categories only: never titles or reply text.
 */
export interface WorkLifecycleSignal {
  intentKey: string;
  /** Model that served the invocation the transition belongs to. */
  served: string;
  /**
   * `complete-*` and `reopen-*` mark `complete_work` and `reopen_work`
   * calls; `prior-completion` an entry that a completed item's model served;
   * `gate` a change refused because the work item is complete.
   * `settle-reminder` marks a hidden settle reminder, and `reminder` names its kind; when the
   * run settles, `settle-followed` or `settle-ignored` records whether the
   * model then declared the boundary.
   */
  action:
    | 'complete-accept' | 'complete-reject' | 'reopen-accept' | 'reopen-reject' | 'prior-completion' | 'gate'
    | 'settle-reminder' | 'settle-followed' | 'settle-ignored';
  workItemId?: string;
  rejectReason?: string;
  status?: 'done' | 'superseded';
  deliverable?: Dimension;
  reminder?: SettleReminderKind;
  /** Referenced files that owed no read because they are above the grounding size limit. */
  oversizedArtifacts?: number;
}

/** The boundary a settle reminder asks for: `hand_off_context` or `complete_work`. */
export type SettleReminderKind = 'context' | 'completion';

/** Append a work lifecycle transition. Best-effort; never throws into the tool path. */
/** Opaque namespace for counts; the log path itself never leaves this process. */
/** Ephemeral sessions share a log file, not an entry namespace. */
export function resetModelEventSession(): void { ephemeralSessionGeneration++; }
export function modelEventSession(): string {
  const scope = decisionLogBaseOverride || sessionSidecarPath(DECISION_SIDECAR_SUFFIX)
    ? decisionLogPath() : `${ephemeralLogScope}:${ephemeralSessionGeneration}`;
  return modelEntryId(scope, 'session');
}
export function modelEventEntry(intentKey: string): string { return modelEntryId(modelEventSession(), intentKey); }

function recordProtocolEvent(
  intentKey: string, model: string, kind: ModelEvent['kind'], reminder: string,
  dimension: string | undefined, storageBase?: string,
): void {
  if (loadConfig().reputation === false) return;
  appendModelEvent({
    kind, model, entry: modelEventEntry(intentKey), session: modelEventSession(), reminder,
    ...(dimension ? { dimension } : {}),
  }, storageBase);
}

export function appendWorkLifecycleSignal(signal: WorkLifecycleSignal, storageBase?: string): void {
  try {
    const kind = signal.action === 'settle-reminder' ? 'reminder'
      : signal.action === 'settle-followed' ? 'followed'
        : signal.action === 'settle-ignored' ? 'ignored' : undefined;
    if (kind && signal.reminder) recordProtocolEvent(signal.intentKey, signal.served, kind, signal.reminder, signal.deliverable, storageBase);
    const path = decisionLogPath(storageBase);
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const entry: DecisionLogEntry = {
      ts: Date.now(),
      kind: 'work-lifecycle',
      dimension: signal.deliverable ?? 'gather',
      chosen: signal.served,
      served: signal.served,
      viaFallback: false,
      cause: 'incumbent',
      reason: `work ${signal.action}`,
      chain: [signal.served],
      intentKey: signal.intentKey,
      workLifecycle: {
        action: signal.action,
        ...(signal.workItemId ? { workItemId: signal.workItemId } : {}),
        ...(signal.rejectReason ? { rejectReason: signal.rejectReason } : {}),
        ...(signal.status ? { status: signal.status } : {}),
        ...(signal.deliverable ? { deliverable: signal.deliverable } : {}),
        ...(signal.reminder ? { reminder: signal.reminder } : {}),
        ...(signal.oversizedArtifacts ? { oversizedArtifacts: signal.oversizedArtifacts } : {}),
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
      ...(decision.policyVersion ? { policyVersion: decision.policyVersion } : {}),
      ...(decision.capabilityEvidence ? { capabilityEvidence: decision.capabilityEvidence } : {}),
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
 * The accounting of one provider attempt. A turn record sums the attempts of a
 * turn. This record keeps each attempt apart, so a later report can price a
 * failed attempt, a retry, and a fallback on its own model.
 */
export function appendAttemptUsage(event: AttemptUsageEvent, intentKey?: string, storageBase?: string): void {
  try {
    const path = decisionLogPath(storageBase);
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const entry: DecisionLogEntry = {
      ts: Date.now(),
      kind: 'attempt-usage',
      dimension: 'attempt',
      chosen: event.candidateKey,
      served: event.candidateKey,
      viaFallback: false,
      cause: 'heuristic',
      reason: event.served ? 'attempt served' : 'attempt failed',
      chain: [event.candidateKey],
      ...(intentKey ? { intentKey } : {}),
      attemptUsage: event,
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
