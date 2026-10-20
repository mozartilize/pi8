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
  Dimension,
  ReasoningHandoffMeta,
  RoutingDecision,
  SourceEvidenceCounts,
} from '../types.js';
import type { AcquisitionReason, ContextStatus } from '../routing/policy/context-acquisition.js';
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
export const DECISION_LOG_SCHEMA_VERSION = 5;
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
  kind?: 'decision' | 'attempt-usage' | 'execution-contract' | 'investigation-handoff' | 'settle';
  dimension: string;
  /** Final chosen model; after fallback this is the served model. */
  chosen: string;
  /** Model that actually served the turn. */
  served: string;
  /** True when an earlier candidate failed before this model served. */
  viaFallback: boolean;
  /** 1-based rank of the served candidate in the chain (undefined if top pick). */
  fallbackRank?: number;
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
  /** Unified selection evidence: identities, codes and counts only. */
  unified?: RoutingDecision['unified'];
  /** Objective trajectory-friction evidence when it influenced the pick. */
  trajectoryFriction?: RoutingDecision['trajectoryFriction'];
  /** Set on `kind: 'attempt-usage'` records only. */
  attemptUsage?: AttemptUsageEvent;
  /** Intent cache key joining this entry's classification to later log records. */
  intentKey?: string;
  /** Set on `kind: 'investigation-handoff'` records only. */
  investigationHandoff?: {
    action: ContextHandoffSignal['action'];
    status?: ContextStatus;
    /** Router-authored reject code, never the findings. */
    rejectReason?: string;
    /** Tool name of a refused call. Set only on `deny`. No arguments. */
    deniedTool?: string;
    handoff?: ReasoningHandoffMeta;
    deliverable?: Dimension;
    /** Why the entry owed context, as categories. */
    contextReasons?: AcquisitionReason[];
    /** Codes and measurements of the declared facts, and the shadow requirement. */
    facts?: FactsLog;
    /** Verifier results before and after the handoff. */
    checks?: CheckVerdicts;
    /** What the router knew before it chose the next model. */
    evidence?: DecisionEvidenceV1;
    /** Referenced files that owed no read because they are above the grounding size limit. */
    oversizedArtifacts?: number;
    sourceEvidence?: SourceEvidenceCounts;
  };
  routingScope?: RoutingDecision['routingScope'];
  deliverable?: string;
  reasoningHandoff?: ReasoningHandoffMeta;
  /** Counts-only acquisition settlement diagnostics. */
  settle?: { action: SettleSignal['action']; deliverable?: Dimension; reminder?: SettleReminderKind };
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
  routingScope?: RoutingDecision['routingScope'];
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
      ...(signal.routingScope ? { routingScope: signal.routingScope } : {}),
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
    | 'accept' | 'reject' | 'reminder' | 'deny' | 'needs-user' | 'budget-exhausted'
    | 'served' | 'phase-end' | 'no-handoff' | 'source-settle-repair' | 'source-settle-exhausted';
  status?: ContextStatus;
  rejectReason?: string;
  /** Tool name of a refused call. Set only on `deny`. No arguments. */
  deniedTool?: string;
  handoff?: ReasoningHandoffMeta;
  deliverable?: Dimension;
  contextReasons?: AcquisitionReason[];
  facts?: FactsLog;
  checks?: CheckVerdicts;
  evidence?: DecisionEvidenceV1;
  /** Referenced files that owed no read because they are above the grounding size limit. */
  oversizedArtifacts?: number;
  sourceEvidence?: SourceEvidenceCounts;
  routingScope?: RoutingDecision['routingScope'];
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
      ...(signal.routingScope ? { routingScope: signal.routingScope } : {}),
      investigationHandoff: {
        action: signal.action,
        ...(signal.rejectReason ? { rejectReason: signal.rejectReason } : {}),
        ...(signal.status ? { status: signal.status } : {}),
        ...(signal.deniedTool ? { deniedTool: signal.deniedTool } : {}),
        ...(signal.handoff ? { handoff: signal.handoff } : {}),
        ...(signal.deliverable ? { deliverable: signal.deliverable } : {}),
        ...(signal.contextReasons?.length ? { contextReasons: signal.contextReasons } : {}),
        ...(signal.facts ? { facts: signal.facts } : {}),
        ...(signal.checks ? { checks: signal.checks } : {}),
        ...(signal.evidence ? { evidence: signal.evidence } : {}),
        ...(signal.oversizedArtifacts ? { oversizedArtifacts: signal.oversizedArtifacts } : {}),
        ...(signal.sourceEvidence ? { sourceEvidence: signal.sourceEvidence } : {}),
      },
    };
    appendFileSync(path, serializeRecord(entry), 'utf8');
  } catch {
    // A logging failure must never fail the user's turn.
  }
}

/** Acquisition reminder outcome. It has no completion or work identity. */
export interface SettleSignal {
  intentKey: string;
  served: string;
  action: 'settle-reminder' | 'settle-followed' | 'settle-ignored';
  deliverable?: Dimension;
  reminder?: SettleReminderKind;
  routingScope?: RoutingDecision['routingScope'];
}

export type SettleReminderKind = 'context';

export function resetModelEventSession(): void {
  ephemeralSessionGeneration += 1;
}

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

export function appendSettleSignal(signal: SettleSignal, storageBase?: string): void {
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
      kind: 'settle',
      dimension: signal.deliverable ?? 'gather',
      chosen: signal.served,
      served: signal.served,
      viaFallback: false,
      cause: 'investigation',
      reason: `acquisition ${signal.action}`,
      chain: [signal.served],
      intentKey: signal.intentKey,
      ...(signal.routingScope ? { routingScope: signal.routingScope } : {}),
      settle: {
        action: signal.action,
        ...(signal.deliverable ? { deliverable: signal.deliverable } : {}),
        ...(signal.reminder ? { reminder: signal.reminder } : {}),
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
      ...(decision.unified ? { unified: decision.unified } : {}),
      trajectoryFriction: decision.trajectoryFriction,
      ...(decision.executionContract
        ? { executionContract: { action: 'route' as const, meta: decision.executionContract } }
        : {}),
      ...(decision.routingScope ? { routingScope: decision.routingScope } : {}),
      ...(decision.deliverable ? { deliverable: decision.deliverable } : {}),
      ...(decision.reasoningHandoff ? { reasoningHandoff: decision.reasoningHandoff } : {}),
    };
    appendFileSync(path, serializeRecord(entry), 'utf8');
  } catch {
    // Logging is best-effort.
  }
}

/**
 * The accounting of one provider attempt. A turn record sums the attempts of a
 * turn. This record keeps each attempt apart, so a later report can price a
 * failed attempt, a retry, and a fallback on its own model.
 */
export function appendAttemptUsage(event: AttemptUsageEvent, intentKey?: string): void {
  try {
    const path = decisionLogPath();
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
