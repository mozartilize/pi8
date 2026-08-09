/**
 * Routing decision surfacing.
 *
 * Records the model that actually served each turn so we can answer "which
 * model handled this?" with a fact rather than a guess, and exposes it in
 * /router status and the per-session widget.
 */
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { RoutingDecision, ServedCapabilityMeta } from './types.js';
import type { EmbeddingStats } from './router-session-state.js';

export interface ServedInfo {
  /** The model that actually produced the turn, after any fallback. */
  registryId: string;
  /** The effective thinking level used by the turn, when known. */
  thinkingLevel?: string;
  /** True when the top-ranked pick failed and a later candidate served it. */
  viaFallback: boolean;
  /** 1-based rank of the served candidate within the fallback chain
   *  (1 = top pick, 2 = first fallback, ...). Present only when viaFallback. */
  fallbackRank?: number;
  /** Session cost accumulated across routed turns, in USD. */
  accumulatedCost: number;
  /** Terminal capability evidence for the candidate that actually served, when known. */
  capability?: ServedCapabilityMeta;
}

function formatServedModel(served: ServedInfo): string {
  return served.registryId;
}

/** Compact one-line summary for the footer. */
export function formatStatus(
  decision: RoutingDecision | undefined,
  served: ServedInfo | undefined,
): string {
  if (!decision || !served) return 'auto → waiting';
  const parts = [`auto:${decision.dimension}`, '→', formatServedModel(served)];
  if (served.viaFallback) {
    const rank = served.fallbackRank && served.fallbackRank > 1 ? ` ${served.fallbackRank}` : '';
    parts.push(`(FALLBACK${rank}!)`);
  }
  if (decision.routedUp && decision.routedPickChanged) parts.push('(routed-up)');
  if (decision.routedDown && decision.routedPickChanged) parts.push('(routed-down)');
  if (decision.contextPressure) parts.push('(context-pressure)');
  return parts.join(' ');
}

/** Multi-line detail for `/router-status`. */
export function formatDecisionDetail(
  decision: RoutingDecision | undefined,
  served: ServedInfo | undefined,
): string[] {
  if (!decision) {
    return ['Last routing decision: none yet (no turn has been routed in this session).'];
  }
  const servedModel = served?.registryId ?? 'unknown';
  const lines = [
    `Last turn served by: ${servedModel}`,
    `  dimension:  ${decision.dimension} (confidence ${decision.confidence.toFixed(2)})`,
    `  top pick:   ${decision.chosen}`,
    `  thinking:   ${served?.thinkingLevel ?? 'off'}`,
    `  reason:     ${decision.reason}`,
  ];
  if (served?.viaFallback) {
    const rank = served.fallbackRank && served.fallbackRank > 1
      ? ` (served by rank ${served.fallbackRank} in the fallback chain)`
      : '';
    lines.push(`  note:       top pick failed; served by a fallback candidate${rank}`);
  }
  if (decision.routedUp) {
    lines.push(
      decision.routedPickChanged
        ? '  note:       routed up (dimension raised and a stronger model was served; see cause)'
        : '  note:       dimension raised (see cause), but the served model was already the top pick — no stronger model available',
    );
  }
  if (decision.routedDown) {
    lines.push(
      decision.routedPickChanged
        ? '  note:       routed down (dimension lowered and a cheaper model was served; see assessment)'
        : '  note:       dimension lowered (see assessment), but the served model was unchanged',
    );
  }
  if (decision.assessment) {
    const a = decision.assessment;
    lines.push(
      `  assessment: ${a.kind}/${a.complexity}/${a.scope}, ` +
      `compound=${a.compound ? 'yes' : 'no'}, ${a.confidence} (${a.model}, ${a.ms}ms, $${a.costUsd.toFixed(5)})`,
    );
    lines.push(`  rationale:  ${a.reasoning}`);
    if (a.vetoedLatch) {
      lines.push('  note:       depth escalation vetoed by a bounded high-confidence assessment');
    }
  }
  if (decision.fallbackReason) {
    lines.push(`  note:       assessment unavailable (${decision.fallbackReason}); heuristic retained`);
  }
  if (decision.cause === 'no-data') {
    lines.push('  note:       no-data (no routable candidate had benchmark data)');
  }
  for (const diagnostic of decision.candidateDiagnostics ?? []) {
    if (diagnostic.excludedReason) {
      lines.push(`  gate:       ${diagnostic.candidateKey} ${diagnostic.excludedReason}`);
    }
  }
  if (decision.multiWork) {
    const mw = decision.multiWork;
    lines.push(
      `  terminal:   ${mw.terminal.kind}/${mw.terminal.complexity}, ${mw.terminalBand} band, phase ${mw.phase} (invocation ${mw.providerInvocation})`,
    );
    if (mw.servedCapability) {
      const ratio = mw.servedCapability.taskRatio != null ? mw.servedCapability.taskRatio.toFixed(2) : 'unknown';
      lines.push(`  served-cap: ratio ${ratio}, clears floor: ${mw.servedCapability.clearsTerminalFloor}`);
    }
    if (mw.mutationGateEscaped) {
      const degraded = mw.capabilityDegraded ? ' (capability degraded)' : '';
      lines.push(`  gate:       blocked invocation ${mw.gateBlockedInvocation}, escaped${degraded}`);
    } else if (mw.gateBlockedInvocation !== undefined) {
      lines.push(`  gate:       mutation blocked at invocation ${mw.gateBlockedInvocation}, awaiting terminal capability`);
    } else if (mw.capabilityDegraded) {
      lines.push('  gate:       mutation allowed with degraded capability');
    }
  }
  if (decision.switched) {
    lines.push('  note:       switched model from the previous turn');
  }
  if (decision.contextPressure) {
    const pct = (decision.contextPressure.usageRatio * 100).toFixed(0);
    lines.push(`  note:       context pressure ${pct}% >= ${(decision.contextPressure.threshold * 100).toFixed(0)}%`);
    lines.push(`  advice:     ${decision.contextPressure.suggestion}`);
  }
  const chain = decision.fallbackChain.slice(0, 5).join(' → ');
  if (chain) lines.push(`  chain:      ${chain}`);
  return lines;
}

/**
 * Assessment spend, shown next to routed spend so the routing tax is visible.
 */
export function formatAssessmentSpend(costUsd: number): string {
  return `assessment spend: $${costUsd.toFixed(4)}`;
}

/** One-line embedding-classifier tally for `/router-status`. */
export function formatEmbeddingStats(s: EmbeddingStats): string {
  const kept = s.fired - s.promoted - s.abstainedLowConf;
  return `embedding: fired ${s.fired} (promoted ${s.promoted}, kept ${kept}, abstained-lowconf ${s.abstainedLowConf}), degraded ${s.degraded}`;
}

/**
 * Push the current decision into the footer. Safe to call with a stale or
 * partially-initialised context; UI updates must never break a turn.
 */
export function renderRouterStatus(
  ctx: ExtensionContext | undefined,
  decision: RoutingDecision | undefined,
  served: ServedInfo | undefined,
): void {
  try {
    ctx?.ui?.setStatus?.('router', `🚥 ${formatStatus(decision, served)}`);
  } catch {
    // A detached or torn-down session must not surface as a routing error.
  }
}

/** Remove the router footer entry when the user selects a concrete model. */
export function clearRouterStatus(ctx: ExtensionContext | undefined): void {
  try {
    ctx?.ui?.setStatus?.('router', undefined);
  } catch {
    // Status cleanup is best-effort and must never affect model selection.
  }
}

/**
 * One-shot TUI notification when the router picks a model for a turn or
 * switches models between turns. Gated by the `prompt` config option and fired
 * at most once per turn by the caller. Best-effort: a torn-down session or a
 * host without `notify` must never surface as a routing error.
 */
export function notifyRouting(
  ctx: ExtensionContext | undefined,
  decision: RoutingDecision | undefined,
  served: ServedInfo | undefined,
): void {
  if (!served) return;
  try {
    const level = served.thinkingLevel && served.thinkingLevel !== 'off' ? `:${served.thinkingLevel}` : '';
    const parts = [`🚥 pi8 → ${served.registryId}${level}`];
    if (decision) parts.push(`(${decision.dimension})`);
    if (served.viaFallback) parts.push('· fallback');
    if (decision?.routedUp && decision.routedPickChanged) parts.push('· routed-up');
    ctx?.ui?.notify?.(parts.join(' '), 'info');
  } catch {
    // Notifications are cosmetic; never break a turn.
  }
}

/**
 * TUI notification when a serving model's `route_up` call is accepted. Distinct
 * from {@link notifyRouting}: this fires on the escalation request itself, one
 * turn before the stronger model actually serves. Best-effort.
 */
export function notifyEscalation(
  ctx: ExtensionContext | undefined,
  dimension: string,
  reason: string | undefined,
): void {
  try {
    const text = `⏫ route_up → ${dimension}${reason ? `: ${reason}` : ''} · next turn uses a stronger model`;
    ctx?.ui?.notify?.(text, 'info');
  } catch {
    // Notifications are cosmetic; never break a turn.
  }
}
