/**
 * One hidden reminder per entry and kind when the model settles without a
 * boundary that the entry's own evidence says it owes. A missing declaration
 * after the reminder leaves the entry as it is: context stays unresolved and
 * the item stays open.
 *
 * The reminder is a settle continuation, not a new user request: its text
 * starts with {@link ROUTER_SETTLE_PREFIX}, which turn classification always
 * ignores. An error or an abort is not a finished answer that forgot the tool.
 *
 * Pi computes `event.context.canContinue` before any entry is added, so it is
 * false right after a final assistant reply — exactly the case this handles.
 * Pi checks the context again after the entries are applied and refuses an
 * invalid continuation itself.
 */
import type { AgentBeforeSettleEvent, AgentBeforeSettleEventResult } from '@earendil-works/pi-coding-agent';
import { appendWorkLifecycleSignal, type SettleNudgeKind, type WorkLifecycleSignal } from '../host/decisionlog.js';
import { servedKey } from '../host/ui.js';
import { activeWorkItem } from '../routing/context/ledger.js';
import { ROUTER_SETTLE_PREFIX } from '../routing/policy/continuation.js';
import type { WorkPhaseState } from '../routing/policy/work-phase.js';
import type { RouterSession } from './router-session-state.js';

export const CONTEXT_SETTLE_TEXT = [
  'Router: you did not call hand_off_context for this request, and the router refused a call or a handoff from you.',
  'If the request needs changes or a decision, call hand_off_context now.',
  'If your reply fully answered a question, do not call it.',
].join('\n');

export const COMPLETION_SETTLE_TEXT = [
  'Router: this work item is still open.',
  'If the user\'s request is complete, call complete_work now.',
  'Your own suggestions and offers do not keep the work open.',
  'If a part of the request is not complete, or you need an answer from the user, do not call complete_work.',
].join('\n');

/**
 * A direct answer while collecting context is normal; only a refused attempt
 * to act shows that the model wanted a boundary it never declared. A declared
 * direct answer stays in collecting context but owes nothing more.
 */
function owesHandoff(state: WorkPhaseState): boolean {
  return state.contextStatus === 'acquiring' && !state.contextSettleNudged
    && state.contextAnswer === undefined && (state.contextDenials ?? 0) > 0;
}

/** Every accepted `hand_off_context` outcome: ready, a declared direct answer, or a question to the user. */
function declaredHandoff(state: WorkPhaseState): boolean {
  return state.handoffKey !== undefined || state.contextAnswer !== undefined || state.contextNeedsUser === true;
}

function logSettle(
  state: WorkPhaseState,
  session: RouterSession,
  action: Extract<WorkLifecycleSignal['action'], `settle-${string}`>,
  nudge: SettleNudgeKind,
): void {
  const served = session.getLastServed();
  const workItemId = nudge === 'completion'
    ? state.completion?.workItemId ?? session.context.getLedger().activeWorkItemId
    : undefined;
  appendWorkLifecycleSignal({
    intentKey: state.intentKey,
    served: served ? servedKey(served) : 'unknown/unknown',
    action,
    nudge,
    ...(workItemId ? { workItemId } : {}),
  });
}

/**
 * Work that spans entries is open by design, so only evidence that this
 * entry did the requested work earns a reminder: its plan ran, or it changed
 * files without a plan. A running or broken plan is not finished work.
 */
function owesCompletion(state: WorkPhaseState, session: RouterSession): boolean {
  if (state.completion || state.completionSettleNudged) return false;
  const status = state.contextStatus;
  if (status === 'acquiring' || status === 'clarification-only' || status === 'ready-pending') return false;
  const contract = state.contract?.status;
  const didWork = contract === 'executed' || (contract === undefined && state.observedMutationTools > 0);
  return didWork && activeWorkItem(session.context.getLedger()) !== undefined;
}

/** Collecting context comes first: no completion reminder while it is still owed. */
export function settleNudge(
  event: Pick<AgentBeforeSettleEvent, 'outcome' | 'entries'>,
  session: RouterSession,
): AgentBeforeSettleEventResult | undefined {
  if (event.outcome !== 'completed') return undefined;
  const state = session.getWorkPhaseState();
  if (!state) return undefined;
  let text: string;
  if (owesHandoff(state)) {
    session.commitWorkPhaseState({ ...state, contextSettleNudged: true });
    logSettle(state, session, 'settle-nudge', 'context');
    text = CONTEXT_SETTLE_TEXT;
  } else if (owesCompletion(state, session)) {
    session.commitWorkPhaseState({ ...state, completionSettleNudged: true });
    logSettle(state, session, 'settle-nudge', 'completion');
    text = COMPLETION_SETTLE_TEXT;
  } else {
    return undefined;
  }
  // A handler's entries replace the drafts of the handlers before it.
  return {
    continue: true,
    entries: [...(event.entries ?? []), {
      type: 'custom_message',
      customType: 'pi8-settle',
      content: `${ROUTER_SETTLE_PREFIX}\n${text}`,
      display: false,
    }],
  };
}

/**
 * When the run settles, record whether each reminder of the entry was
 * followed. Logged once per entry: a reminder's outcome is final at settle.
 */
export function logSettleOutcomes(session: RouterSession): void {
  try {
    const state = session.getWorkPhaseState();
    if (!state || state.settleOutcomeLogged || !(state.contextSettleNudged || state.completionSettleNudged)) return;
    if (state.contextSettleNudged) {
      logSettle(state, session, declaredHandoff(state) ? 'settle-followed' : 'settle-ignored', 'context');
    }
    if (state.completionSettleNudged) {
      logSettle(state, session, state.completion ? 'settle-followed' : 'settle-ignored', 'completion');
    }
    session.commitWorkPhaseState({ ...state, settleOutcomeLogged: true });
  } catch {
    // Logging must never fail the end of a run.
  }
}
