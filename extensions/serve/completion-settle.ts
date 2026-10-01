/**
 * One hidden reminder when an entry's plan has run and the model has not
 * called `complete_work`. A missing declaration leaves the item open.
 *
 * The reminder is a settle continuation, not a new user request: its text
 * starts with {@link ROUTER_SETTLE_PREFIX}, which turn classification always
 * ignores. An error or an abort is not a finished answer that forgot the tool.
 */
import type { AgentBeforeSettleEvent, AgentBeforeSettleEventResult } from '@earendil-works/pi-coding-agent';
import { activeWorkItem } from '../routing/context/ledger.js';
import { ROUTER_SETTLE_PREFIX } from '../routing/policy/continuation.js';
import type { RouterSession } from './router-session-state.js';

export const COMPLETION_SETTLE_TEXT = [
  'Router: this work item is still open.',
  'If the user\'s request is complete, call complete_work now.',
  'Your own suggestions and offers do not keep the work open.',
  'If a part of the request is not complete, or you need an answer from the user, do not call complete_work.',
].join('\n');

/**
 * The only settle continuation in v1. Collecting context and a pending handoff
 * are not this reminder: a missing `hand_off_context` does not continue the run.
 */
export function completionSettleNudge(
  event: Pick<AgentBeforeSettleEvent, 'outcome' | 'context'>,
  session: RouterSession,
): AgentBeforeSettleEventResult | undefined {
  if (event.outcome !== 'completed' || !event.context?.canContinue) return undefined;
  const state = session.getWorkPhaseState();
  if (!state || state.completion || state.completionSettleNudged) return undefined;
  const status = state.contextStatus;
  if (status === 'acquiring' || status === 'clarification-only' || status === 'ready-pending') return undefined;
  if (state.contract?.status !== 'executed') return undefined;
  if (!activeWorkItem(session.context.getLedger())) return undefined;

  session.commitWorkPhaseState({ ...state, completionSettleNudged: true });
  return {
    continue: true,
    entries: [{
      type: 'custom_message',
      customType: 'pi8-settle',
      content: `${ROUTER_SETTLE_PREFIX}\n${COMPLETION_SETTLE_TEXT}`,
      display: false,
    }],
  };
}
