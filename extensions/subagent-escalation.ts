import { stripThinkingSuffix } from './subagents.js';
import type { Role } from './types.js';

/** Exact, line-leading signal a router-owned child may use to request one retry. */
export const SUBAGENT_ESCALATION_MARKER = '[router-escalate]';

const MAX_REASON_LENGTH = 500;
const MAX_MARKER_LINE_LENGTH = 1_024;
const ESCALATION_CONTRACT = [
  'Router escalation contract:',
  'If the current model cannot complete this task reliably because it lacks the required capability, return only the following line, with a brief reason:',
  `${SUBAGENT_ESCALATION_MARKER}{"reason":"brief capability limitation"}`,
  'Do not request a particular model. Do not emit this marker for ordinary task errors.',
].join('\n');

/** Add the bounded self-report contract without duplicating an existing append. */
export function appendSubagentEscalationContract(task: string): string {
  if (task.includes(ESCALATION_CONTRACT)) return task;
  return `${task}\n\n${ESCALATION_CONTRACT}`;
}

/**
 * Parse a self-report only when the complete trimmed result is the exact
 * marker followed immediately by a single-property JSON object. This keeps
 * the marker-only child contract strict while allowing surrounding whitespace.
 */
export function parseSubagentEscalation(text: string): { reason: string } | undefined {
  const line = text.trim();
  if (line.includes('\n') || line.includes('\r')) return undefined;
  if (line.length > MAX_MARKER_LINE_LENGTH || !line.startsWith(SUBAGENT_ESCALATION_MARKER)) {
    return undefined;
  }

  const payload = line.slice(SUBAGENT_ESCALATION_MARKER.length);
  // Exact shape deliberately rejects extra keys, whitespace, duplicate keys,
  // trailing text, and non-string values before JSON parsing.
  if (!/^\{"reason":"(?:[^"\\\u0000-\u001f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"\}$/.test(payload)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(payload) as { reason: unknown };
    if (typeof parsed.reason !== 'string') return undefined;
    const reason = parsed.reason.trim();
    if (
      reason.length === 0 ||
      reason.length > MAX_REASON_LENGTH ||
      /[\r\n\u2028\u2029]/.test(reason)
    ) {
      return undefined;
    }
    return { reason };
  } catch {
    return undefined;
  }
}

/** Select the next entry only from the role's already-filtered ranked chain. */
export function nextRoleFallback(
  role: Role,
  currentModel: string,
  roleFallbacks: ReadonlyMap<Role, string[]>,
): string | undefined {
  const chain = roleFallbacks.get(role);
  if (!chain) return undefined;
  const currentIndex = chain.indexOf(currentModel);
  return currentIndex >= 0 ? chain[currentIndex + 1] : undefined;
}

export interface SubagentRetryDirective {
  role: Role;
  model: string;
  directive: string;
}

interface PendingOverride {
  currentModel: string;
  nextModel: string;
  taskKey?: string;
  occurrenceKey: string;
  pairKey: string;
}

/**
 * Extension-lifetime, in-memory one-shot state. It has no I/O and is kept as a
 * small testable helper so hook handlers only coordinate parsing and patches.
 */
export class SubagentEscalationState {
  private readonly pending = new Map<Role, PendingOverride[]>();
  private readonly issuedPairs = new Set<string>();

  schedule(
    role: Role,
    currentModel: string,
    nextModel: string,
    reason: string,
    taskKey?: string,
    occurrenceKey?: string,
  ): SubagentRetryDirective | undefined {
    const safeOccurrence = (occurrenceKey ?? role).replace(/[\r\n\u2028\u2029\u0000]/g, ' ');
    const pairKey = `${role}\u0000${currentModel}\u0000${safeOccurrence}`;
    if (this.issuedPairs.has(pairKey)) return undefined;

    const queue = this.pending.get(role) ?? [];
    queue.push({ currentModel, nextModel, taskKey, occurrenceKey: safeOccurrence, pairKey });
    this.pending.set(role, queue);
    this.issuedPairs.add(pairKey);
    const safeReason = reason
      .replace(/[\r\n\u2028\u2029]/g, ' ')
      .trim()
      .slice(0, MAX_REASON_LENGTH) || 'the child could not complete the task';
    const quotedModel = JSON.stringify(nextModel);
    const where = occurrenceKey ? ` at ${safeOccurrence}` : '';
    return {
      role,
      model: nextModel,
      directive: `Router retry: retry ${role} task${where} once without an explicit model; the router will inject ${quotedModel}. Reason: ${safeReason}`,
    };
  }

  /**
   * Consume the role's pending model exactly once at router-owned injection.
   * A pending target can become dead between result and retry, so selection is
   * revalidated against the current role chain and live runtime blacklist.
   */
  consume(
    role: Role,
    task: string | undefined,
    roleFallbacks: ReadonlyMap<Role, string[]>,
    isBlacklisted: (registryId: string) => boolean,
    selectedFallbackChain?: readonly string[],
  ): string | undefined {
    const queue = this.pending.get(role);
    if (!queue) return undefined;
    const index = queue.findIndex((item) => item.taskKey === undefined || item.taskKey === task);
    if (index < 0) return undefined;
    const [override] = queue.splice(index, 1);
    if (!override) return undefined;
    if (queue.length === 0) this.pending.delete(role);
    this.issuedPairs.delete(override.pairKey);

    const chain = selectedFallbackChain ?? roleFallbacks.get(role);
    if (!chain) return undefined;
    const targetIndex = chain.indexOf(override.nextModel);
    const currentIndex = chain.indexOf(override.currentModel);
    const candidates = targetIndex >= 0
      ? chain.slice(targetIndex)
      : currentIndex >= 0
        ? chain.slice(currentIndex + 1)
        : chain;
    return candidates.find((model) =>
      model !== override.currentModel && !isBlacklisted(stripThinkingSuffix(model)));
  }

  reset(): void {
    this.pending.clear();
    this.issuedPairs.clear();
  }
}

export type SubagentOutcomeKind = 'self-report' | 'hard-failure';

export interface PlannedSubagentOutcome {
  blacklistCurrent: boolean;
  retry?: SubagentRetryDirective;
}

/**
 * A hard failure blacklists the bare provider/model, so sibling effort entries
 * cannot be valid retry targets. Keep the exact failed entry in the chain so
 * `nextRoleFallback` can advance past it to a different model. Self-reports do
 * not blacklist and therefore retain the full effort-aware chain.
 */
function hardFailureFallbacks(
  role: Role,
  currentModel: string,
  roleFallbacks: ReadonlyMap<Role, string[]>,
): ReadonlyMap<Role, string[]> {
  const chain = roleFallbacks.get(role);
  if (!chain) return roleFallbacks;
  const failedBare = stripThinkingSuffix(currentModel);
  return new Map([
    [
      role,
      chain.filter((model) =>
        model === currentModel || stripThinkingSuffix(model) !== failedBare,
      ),
    ],
  ]);
}

/** Plan blacklist/retry behavior without touching global router state. */
export function planSubagentOutcome(
  state: SubagentEscalationState,
  kind: SubagentOutcomeKind,
  role: Role,
  currentModel: string,
  roleFallbacks: ReadonlyMap<Role, string[]>,
  reason: string,
  taskKey?: string,
  occurrenceKey?: string,
): PlannedSubagentOutcome {
  const blacklistCurrent = kind === 'hard-failure';
  const eligibleFallbacks = blacklistCurrent
    ? hardFailureFallbacks(role, currentModel, roleFallbacks)
    : roleFallbacks;
  const nextModel = nextRoleFallback(role, currentModel, eligibleFallbacks);
  if (!nextModel) return { blacklistCurrent };
  const retry = state.schedule(role, currentModel, nextModel, reason, taskKey, occurrenceKey);
  return retry ? { blacklistCurrent, retry } : { blacklistCurrent };
}
