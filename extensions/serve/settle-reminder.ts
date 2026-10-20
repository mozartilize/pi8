/**
 * One hidden reminder per entry and kind when the model settles without a
 * boundary that the entry's own evidence says it owes. A missing declaration
 * after the reminder leaves the entry in triage.
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
import { appendWorkLifecycleSignal, type SettleReminderKind, type WorkLifecycleSignal } from '../host/decisionlog.js';
import { servedKey } from '../host/ui.js';
import { ROUTER_SETTLE_PREFIX } from '../routing/policy/continuation.js';
import type { WorkPhaseState } from '../routing/policy/work-phase.js';
import { refreshSourceEvidence, sourceEvidenceCounts } from './entry-evidence.js';
import { logContextHandoff } from './gathering-gate.js';
import { ACQUISITION_DENIAL_LIMIT } from '../routing/policy/context-acquisition.js';
import type { RouterSession } from './router-session-state.js';

export const CONTEXT_SETTLE_TEXT = [
  'Router: you did not call hand_off_context for this request.',
  'If the request needs changes, a plan, a review, or a decision, call hand_off_context now.',
  'If your reply fully answered a question, do not call it.',
].join('\n');

/**
 * A direct answer while collecting context is normal only for a request typed
 * `gather`. Any other type, or a refused attempt to act,
 * shows a boundary the model never declared: a plan, review, or change written
 * by the gathering model skips that type's minimum.
 */
function owesHandoff(state: WorkPhaseState): boolean {
  if (state.status !== 'triage' || state.contextSettleReminded) return false;
  const directAnswer = state.deliverable === 'gather';
  return !directAnswer || (state.contextDenials ?? 0) > 0;
}

/** Every accepted `hand_off_context` outcome: ready, or a question to the user. */
function declaredHandoff(state: WorkPhaseState): boolean {
  return state.handoffKey !== undefined || state.contextNeedsUser === true;
}

function logSettle(
  state: WorkPhaseState,
  session: RouterSession,
  action: Extract<WorkLifecycleSignal['action'], `settle-${string}`>,
  reminder: SettleReminderKind,
): void {
  const served = session.getLastServed();
  appendWorkLifecycleSignal({
    intentKey: state.intentKey,
    served: served ? servedKey(served) : 'unknown/unknown',
    action,
    reminder,
    ...(state.deliverable ? { deliverable: state.deliverable } : {}),
  });
}

/** Remind a triage entry that tried to act without an accepted handoff. */
export async function settleReminder(
  event: Pick<AgentBeforeSettleEvent, 'outcome' | 'entries'>,
  session: RouterSession,
): Promise<AgentBeforeSettleEventResult | undefined> {
  if (event.outcome !== 'completed') return undefined;
  const before = session.getWorkPhaseState();
  const source = await refreshSourceEvidence(session);
  const state = session.getWorkPhaseState();
  if (!state || before?.intentKey !== state.intentKey || before?.evidence !== state.evidence) return undefined;
  if (state.sourceEvidencePending && state.status !== 'clarification-only') {
    const sourceSettleAttempts = (state.sourceSettleAttempts ?? 0) + 1;
    const exhausted = sourceSettleAttempts >= ACQUISITION_DENIAL_LIMIT;
    const served = session.getLastServed();
    logContextHandoff(state, served ? servedKey(served) : 'unknown/unknown',
      exhausted ? 'source-settle-exhausted' : 'source-settle-repair',
      source ? { sourceEvidence: sourceEvidenceCounts(source) } : {});
    session.commitWorkPhaseState({ ...state, sourceSettleAttempts,
      ...(exhausted ? { status: 'clarification-only' as const } : {}) });
    const instruction = exhausted
      ? 'Router: The referenced source could not be verified. Tell the user this limitation. Ask for the missing source or input. Do not call tools.'
      : 'Router: Read the referenced source in full as it is now before you answer. Continue this same request without changing the product.';
    return { continue: true, entries: [...(event.entries ?? []), {
      type: 'custom_message', customType: 'pi8-settle',
      content: `${ROUTER_SETTLE_PREFIX}\n${instruction}`, display: false,
    }] };
  }
  if (state.status === 'clarification-only' || !owesHandoff(state)) return undefined;
  session.commitWorkPhaseState({ ...state, contextSettleReminded: true });
  logSettle(state, session, 'settle-reminder', 'context');
  const text = CONTEXT_SETTLE_TEXT;
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
    if (!state || state.settleOutcomeLogged || !state.contextSettleReminded) return;
    logSettle(state, session, declaredHandoff(state) ? 'settle-followed' : 'settle-ignored', 'context');
    session.commitWorkPhaseState({ ...state, settleOutcomeLogged: true });
  } catch {
    // Logging must never fail the end of a run.
  }
}
