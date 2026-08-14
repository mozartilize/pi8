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
  CandidateDiagnostic,
  DecisionCause,
  Dimension,
  RoutingAssessment,
  RoutingDecision,
} from './types.js';
import { resolveStoragePath } from './store.js';
import { sessionSidecarPath } from './sessionpaths.js';
import { ASSESSMENT_PROMPT_VERSION } from './assessment-prompt.js';
import { DIMENSION_STRENGTH } from './classifier-keywords.js';

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
  kind?: 'decision' | 'assessment-shadow' | 'mutation-gate';
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
  /** Intent cache key, so a detached shadow verdict can be joined offline. */
  intentKey?: string;
  assessmentMode?: string;
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
  /** Shadow-record fields: the heuristic the verdict is measured against. */
  heuristicDimension?: string;
  /** What `active` mode would have routed; absent when unavailable. */
  counterfactualDimension?: string;
  /** Strength difference counterfactual − heuristic. */
  dimensionDelta?: number;
  /** True when this shadow record was requested by the latch transition. */
  latchTransition?: boolean;
  /** True when the latch escalation would have been vetoed in `active`. */
  wouldVetoLatch?: boolean;
  /** Populated when an inline LLM consultation ran (adopted or not). */
  consult?: {
    model: string;
    ms: number;
    heuristicDimension: string;
    verdict?: string;
    adopted?: boolean;
  };
  /** Populated when the serving model escalated the conversation. */
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
    const servedModel = served.thinkingLevel
      ? `${served.registryId}:${served.thinkingLevel}`
      : served.registryId;
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
      intentKey: decision.intentKey,
      assessmentMode: decision.assessmentMode,
      fallbackReason: decision.fallbackReason,
      provenance: decision.provenanceCounts,
      assessment: serializeAssessment(decision.assessment),
      assessmentPromptVersion: decision.assessment ? ASSESSMENT_PROMPT_VERSION : undefined,
      escalation: decision.escalation,
      contextPressure: decision.contextPressure,
      candidateDiagnostics: decision.candidateDiagnostics,
    };
    appendFileSync(path, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // Logging is best-effort.
  }
}

/**
 * Append an immediate record of an accepted `route_up` escalation request. The
 * escalation also surfaces in the NEXT turn's decision entry (once a stronger
 * model actually serves), but logging it here gives a durable record at
 * request time — even if the session ends before the next turn. `chosen`/
 * `served` carry the model that was serving when it asked to escalate.
 */
export function appendEscalationSignal(
  event: {
    requestedDimension: string;
    heuristicDimension?: string;
    reason: string;
    servingModel?: string;
    cause: Extract<DecisionCause, 'model-escalation' | 'capability-escalation'>;
    routedUp: boolean;
  },
  storageBase?: string,
): void {
  try {
    const path = decisionLogPath(storageBase);
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const model = event.servingModel ?? 'unknown/unknown';
    const entry: DecisionLogEntry = {
      ts: Date.now(),
      dimension: event.requestedDimension,
      chosen: model,
      served: model,
      viaFallback: false,
      confidence: 1,
      routedUp: event.routedUp,
      cause: event.cause,
      reason: `route_up requested: ${event.reason}`,
      chain: [model],
      escalation: {
        requestedDimension: event.requestedDimension,
        heuristicDimension: event.heuristicDimension ?? event.requestedDimension,
        reason: event.reason,
      },
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
 * Shadow verdicts arrive after the decision they relate to, because the
 * assessment is detached so the turn pays no latency for it. Writing a
 * separate, joinable record keeps decision entries byte-identical to the
 * fully deterministic path while still collecting the §15 evidence.
 */
export function appendShadowAssessment(
  record: ShadowAssessmentRecord,
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
      kind: 'assessment-shadow',
      dimension: record.heuristicDimension,
      chosen: record.assessment?.model ?? 'unknown/unknown',
      served: record.assessment?.model ?? 'unknown/unknown',
      viaFallback: false,
      confidence: 1,
      routedUp: false,
      cause: 'heuristic',
      reason: 'shadow assessment',
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

/**
 * A counterfactual assessment record, joined to decisions by `intentKey`.
 */
export interface ShadowAssessmentRecord {
  /** Joins this counterfactual to the decisions taken for the same intent. */
  intentKey: string;
  heuristicDimension: Dimension;
  /** What `active` mode would have routed. Absent when unavailable. */
  counterfactualDimension?: Dimension;
  assessment?: RoutingAssessment;
  fallbackReason?: AssessmentFallbackReason;
  latchTransition?: boolean;
  /** True when a latch escalation would have been vetoed in `active`. */
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
