/**
 * Routing decision surfacing.
 *
 * Records the model that actually served each turn so we can answer "which
 * model handled this?" with a fact rather than a guess, and exposes it in
 * /router status and the per-session widget.
 */
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type {
  DecisionCause,
  ExecutionContractMeta,
  QualityExclusionReason,
  RoutingDecision,
  WorkContextMeta,
} from '../types.js';
import { activeWorkItem, ledgerTopics, type TopicLedger } from '../routing/context/ledger.js';
import type { BranchState, ContextReason } from '../routing/context/types.js';

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
}

/**
 * Canonical key of the model that served a turn, mirroring `candidateKey`'s
 * `registryId[:effort]` shape (thinkingLevel is the served analog of a
 * candidate's effort). Any caller that matches a served turn against the
 * candidate pool or persists its identity must go through this one encoding,
 * so a change to the key format cannot leave a hand-rolled copy behind.
 * Display code that hides a redundant `:off` is a separate concern and does
 * not use this (see `notifyRouting`).
 */
export function servedKey(served: Pick<ServedInfo, 'registryId' | 'thinkingLevel'>): string {
  return served.thinkingLevel ? `${served.registryId}:${served.thinkingLevel}` : served.registryId;
}

/** Compact one-line summary for the footer. */
export function formatStatus(
  decision: RoutingDecision | undefined,
  served: ServedInfo | undefined,
): string {
  if (!decision) return 'auto → waiting';
  if (!served) {
    return decision.fallbackChain.length === 0
      ? `auto:${decision.dimension} → unavailable (${decision.reason})`
      : 'auto → waiting';
  }
  const label = decision.cause === 'investigation'
    ? `auto:${decision.dimension} · collecting context`
    : decision.mutationObserved && decision.dimension !== 'implement'
      ? `auto:${decision.dimension} · editing` : `auto:${decision.dimension}`;
  const parts = [label, '→', servedKey(served)];
  if (served.viaFallback) {
    const rank = served.fallbackRank && served.fallbackRank > 1 ? ` #${served.fallbackRank}` : '';
    parts.push(`(fallback${rank})`);
  }
  if (decision.routedUp && decision.routedPickChanged) parts.push('(upgraded)');
  if (decision.routedDown && decision.routedPickChanged) parts.push('(downgraded)');
  if (decision.contextPressure) parts.push('(context nearly full)');
  return parts.join(' ');
}

/** Plain-language label for each decision cause; the log keeps the raw value. */
const CAUSE_LABELS: Readonly<Record<DecisionCause, string>> = {
  heuristic: 'keyword classifier',
  'continuation-context': 'a short follow-up kept at the previous request\'s task type while its work is unresolved',
  'router-consult': 'task type adopted from a context handoff',
  'execution-contract': 'routed by an accepted execution plan',
  investigation: 'collecting context, read-only, before the deliverable',
  'investigation-handoff': 'the next step started after collecting context',
  'error-fallback': 'a fallback model served after the top pick failed',
  'no-data': 'no benchmark data; ranked by price and context window',
  'capability-escalation': 'stronger model, picked by quality alone',
  'trajectory-escalation': 'stronger model, because the previous one struggled',
  'self-healing-gap': 'subagent tool gap',
  'manual-override': 'manual pin',
  resume: 'reused the route from before the pin',
  'semi-hold': 'kept the current model (semi mode)',
  incumbent: 'kept the model serving this session until a handoff',
  'work-context': 'a follow-up that carries on its resolved work item\'s task type',
};

const EXCLUSION_LABELS: Readonly<Record<QualityExclusionReason, [label: string, text: string]>> = {
  'below-intelligence-minimum': ['demoted', 'intelligence score below the minimum for this task type'],
  'below-coding-minimum': ['demoted', 'coding score below the minimum for this task type'],
  'below-agenticCoding-minimum': ['demoted', 'agentic coding score below the minimum for this task type'],
  'below-knowledge-minimum': ['demoted', 'states facts wrong more often than right'],
  'below-research-minimum': ['demoted', 'work from sources fails too many checks'],
  'below-longContext-minimum': ['demoted', 'long-context score below the minimum'],
  'below-visionReasoning-minimum': ['demoted', 'visual reasoning score below the minimum'],
  'unknown-quality': ['demoted', 'no benchmark data for this task'],
};

/** Plain-language context reason, as the user reads it. */
const CONTEXT_REASON_LABELS: Readonly<Record<ContextReason, string>> = {
  'identity-unresolved': 'which work it belongs to',
  'referenced-artifact': 'files it references',
  'reasoning-prep': 'preparing the plan or review',
  'carried-open-context': 'left open by an earlier request',
};

/** Multi-line detail for `/router-status`. */
export function formatDecisionDetail(
  decision: RoutingDecision | undefined,
  served: ServedInfo | undefined,
): string[] {
  if (!decision) {
    return ['Last routing decision: none yet (no turn has been routed in this session).'];
  }
  const servedModel = served ? servedKey(served) : 'unknown';
  const chain = decision.fallbackChain.slice(0, 5).join(' → ');
  return [
    `Last turn served by: ${servedModel}`,
    `  task type:  ${decision.dimension}`,
    `  top pick:   ${decision.chosen}`,
    `  thinking:   ${served?.thinkingLevel ?? 'off'}`,
    `  cause:      ${CAUSE_LABELS[decision.cause] ?? decision.cause}`,
    `  reason:     ${decision.reason}`,
    ...(decision.mutationObserved && decision.dimension !== 'implement' ? ['  phase:      editing'] : []),
    ...workContextLines(decision.workContext),
    ...routingNotes(decision, served),
    ...decision.candidateDiagnostics?.flatMap((diagnostic) => {
      if (!diagnostic.excludedReason) return [];
      const [label, text] = EXCLUSION_LABELS[diagnostic.excludedReason];
      return [`  ${`${label}:`.padEnd(11)} ${diagnostic.candidateKey} (${text})`];
    }) ?? [],
    ...handoffLine(decision),
    ...(decision.executionContract ? contractLines(decision.executionContract) : []),
    ...(decision.trajectoryFriction ? [trajectoryLine(decision.trajectoryFriction)] : []),
    ...(decision.switched ? ['  note:       switched models from the previous turn'] : []),
    ...(decision.contextPressure ? contextPressureLines(decision.contextPressure) : []),
    ...(chain ? [`  chain:      ${chain}`] : []),
  ];
}

const RESOLVER_LABELS: Readonly<Record<WorkContextMeta['resolver'], string>> = {
  deterministic: 'continues the active work, no model asked',
  'context-handoff': 'selected after collecting context',
  fallback: 'not recorded on this branch',
};

const LEGACY_LABEL = 'found in conversation from before tracking started';

/** The `/router-why` lines for the entry's work context: ids and plain language, no titles. */
function workContextLines(context: WorkContextMeta | undefined): string[] {
  if (!context) return [];
  const target = context.workItemId === 'NONE'
    ? 'a side question outside any work item'
    : context.workItemId === 'UNKNOWN'
      ? 'no work item'
      : `${context.relation === 'new' || context.relation === 'switch' ? 'new' : context.relation} work item ${context.workItemId}`;
  const reasons = context.contextReasons.map((reason) => CONTEXT_REASON_LABELS[reason]).join(', ');
  const status = !context.contextSatisfied ? 'still needed'
    : context.resolver === 'context-handoff' && reasons ? 'collected'
    : 'current';
  return [
    `  work:       ${target} (${context.legacy ? LEGACY_LABEL : RESOLVER_LABELS[context.resolver]})`,
    `  context:    ${status}${reasons ? ` (${reasons})` : ''}`,
  ];
}

const CONTRACT_BREAK_LABELS: Readonly<Record<NonNullable<ExecutionContractMeta['breakReason']>, string>> = {
  'undeclared-target': 'edited a file outside the plan',
  'unattributed-mutation': 'wrote files from a shell command',
  replan: 'asked to re-plan',
  struggle: 'struggled',
};

const CONTRACT_KEEP_LABELS: Readonly<Record<NonNullable<ExecutionContractMeta['keepReason']>, string>> = {
  size: 'too large to hand off',
  difficulty: 'too hard to hand off',
  excluded: 'earlier executors were excluded',
  'unknown-target': 'it edits a file that does not exist or could not be checked',
  delete: 'it deletes a file',
};

function contractPlanLine(contract: ExecutionContractMeta): string {
  const size = `${contract.targets} file${contract.targets === 1 ? '' : 's'}, ${contract.steps} step${contract.steps === 1 ? '' : 's'}`;
  switch (contract.status) {
    case 'active':
      return contract.release
        ? `accepted, ${contract.band} (${size}; executor minimum ${contract.minimum?.toFixed(2)}); an executor model runs it`
        : `accepted (${size}); ${contract.submitter} keeps running it: ${CONTRACT_KEEP_LABELS[contract.keepReason ?? 'difficulty']}`;
    case 'executed': {
      const how = contract.executedReason === 'budget' ? ' (step budget used up)' : '';
      return contract.release
        ? `executed${contract.executor ? ` by ${contract.executor}` : ''}${how}; ${contract.submitter} reviews it`
        : `executed by ${contract.submitter}${how}`;
    }
    case 'broken':
      return `broken: ${contract.breaker ?? 'the executor'} ${CONTRACT_BREAK_LABELS[contract.breakReason ?? 'struggle']}; back to ${contract.submitter}`;
  }
}

/** The `/router-why` line for collecting context and its handoff. */
function handoffLine(decision: RoutingDecision): string[] {
  const handoff = decision.reasoningHandoff;
  if (!handoff) {
    return decision.cause === 'investigation' && decision.deliverable
      ? [`  handoff:    collecting context (deliverable ${decision.deliverable})`]
      : [];
  }
  const role = handoff.target === 'plan' ? 'planning' : 'reviewing';
  const state = handoff.pending ? 'pending' : `owned by ${handoff.owner ?? 'unknown'}`;
  return [`  handoff:    ${role}, ${handoff.minimum !== undefined ? `minimum ${handoff.minimum.toFixed(2)}` : 'default minimum'}, ${state}`];
}

function contractLines(contract: ExecutionContractMeta): string[] {
  const lines = [`  plan:       ${contractPlanLine(contract)}`];
  if (contract.excludedExecutors?.length) {
    lines.push(`  excluded:   ${contract.excludedExecutors.join(', ')} (failed two plans)`);
  }
  return lines;
}

function routingNotes(decision: RoutingDecision, served: ServedInfo | undefined): string[] {
  const lines: string[] = [];
  if (served?.viaFallback) {
    const rank = served.fallbackRank && served.fallbackRank > 1
      ? ` (#${served.fallbackRank} in the fallback chain)`
      : '';
    lines.push(`  note:       top pick failed; a fallback model served${rank}`);
  }
  if (decision.routedUp) {
    lines.push(
      decision.routedPickChanged
        ? '  note:       task type raised, so a stronger model served (see cause)'
        : '  note:       task type raised (see cause), but no stronger model was available',
    );
  }
  if (decision.routedDown) {
    const lowerer = decision.cause === 'execution-contract'
      ? 'the accepted execution plan'
      : decision.cause === 'investigation' ? 'collecting context before it' : 'a later reading of the request';
    lines.push(
      decision.routedPickChanged
        ? `  note:       task type lowered by ${lowerer}, so a cheaper model served`
        : `  note:       task type lowered by ${lowerer}; the served model did not change`,
    );
  }
  return lines;
}

function trajectoryLine(tf: NonNullable<RoutingDecision['trajectoryFriction']>): string {
  if (tf.unavailable) return `  struggle:   score ${tf.tfi.toFixed(2)} on ${tf.fromModel}; no stronger model available`;
  const kinds = tf.signals.map((signal) => `${signal.severity} ${signal.kind.replaceAll('-', ' ')}`).join(', ');
  return `  struggle:   score ${tf.tfi.toFixed(2)} on ${tf.fromModel}${kinds ? ` (${kinds})` : ''}`;
}

function contextPressureLines(pressure: NonNullable<RoutingDecision['contextPressure']>): string[] {
  const pct = (pressure.usageRatio * 100).toFixed(0);
  return [
    `  note:       context ${pct}% full (advice starts at ${(pressure.threshold * 100).toFixed(0)}%)`,
    `  advice:     ${pressure.suggestion}`,
  ];
}

/**
 * The session's work context for `/router-status`: local, user-facing state,
 * so titles are shown; nothing here reaches the decision log.
 */
export function formatWorkContext(
  ledger: TopicLedger,
  branchState: BranchState,
): string[] {
  if (branchState === 'legacy-uninitialized') {
    return ['Work context: none yet; earlier requests that the router did not serve are searched when a message returns to their work'];
  }
  if (branchState === 'native-empty' || ledger.items.size === 0) {
    return ['Work context: none yet'];
  }
  const topics = ledgerTopics(ledger).length;
  const open = [...ledger.items.values()].filter((item) => item.status === 'active' || item.status === 'blocked').length;
  const counts = `${open} open of ${ledger.items.size} work item${ledger.items.size === 1 ? '' : 's'} in ${topics} topic${topics === 1 ? '' : 's'}`;
  const active = activeWorkItem(ledger);
  const lines = [
    active
      ? `Work context: ${active.title} (topic: ${active.topic.title}; ${counts})`
      : `Work context: no active work item (${counts})`,
  ];
  if (active) {
    const grounded = active.grounding.length;
    lines.push(`  work item:  ${active.id}, ${active.status}, ${active.anchors.length} anchor${active.anchors.length === 1 ? '' : 's'}, ${grounded} read and fingerprinted`);
    if (active.openContext?.length) {
      const reasons = active.openContext.map((reason) => CONTEXT_REASON_LABELS[reason]).join(', ');
      lines.push(`  context:    still needed before its next change (${reasons})`);
    }
  }
  return lines;
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
    if (decision?.routedUp && decision.routedPickChanged) parts.push('· upgraded');
    ctx?.ui?.notify?.(parts.join(' '), 'info');
  } catch {
    // Notifications are cosmetic; never break a turn.
  }
}
