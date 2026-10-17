/** Readers of work-context events for tests. */
import { applyEvent, emptyLedger, parseContextEvent, type TopicLedger } from '../routing/context/ledger.js';
import { CONTEXT_ENTRY_TYPE } from '../routing/context/persistence.js';
import type { RoutingContextEvent } from '../routing/context/types.js';

/** Apply events in order to a ledger. */
export function foldEvents(events: readonly RoutingContextEvent[], from: TopicLedger = emptyLedger()): TopicLedger {
  return events.reduce(applyEvent, from);
}

/**
 * The valid work-context events that a branch holds, in entry order. A
 * `context-commit` entry gives its subevents. This reads the records only;
 * it does not apply them.
 */
export function persistedContextEvents(branch: readonly { type: string; customType?: string; data?: unknown }[]): RoutingContextEvent[] {
  return branch.flatMap((entry) => {
    if (entry.type !== 'custom' || entry.customType !== CONTEXT_ENTRY_TYPE) return [];
    const event = parseContextEvent(entry.data);
    if (!event) return [];
    return event.op === 'context-commit' ? event.events : [event];
  });
}
