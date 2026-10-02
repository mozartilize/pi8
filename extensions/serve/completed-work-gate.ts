/** Completed work is read-only until a model declares which work the request belongs to. */
import type { ToolCallEvent, ToolCallEventResult } from '@earendil-works/pi-coding-agent';
import { appendWorkLifecycleSignal } from '../host/decisionlog.js';
import { servedKey } from '../host/ui.js';
import { EXECUTION_CONTRACT_TOOL } from '../routing/policy/execution-contract.js';
import { isMutationCall } from '../routing/policy/mutation-detector.js';
import type { RouterSession } from './router-session-state.js';
import type { WorkPhaseState } from '../routing/policy/work-phase.js';
import { workChoiceNote } from './gathering-gate.js';

/** A completed item has no mutation authority, but its model still has the conversation. */
export function completedWorkNote(state: WorkPhaseState): string {
    return 'Router: the work item you most recently owned is complete. ' +
      'If this request only asks a question about completed work, answer it directly; do not reopen it. ' +
      'For more changes to that item, call reopen_work. ' +
      'For different work, call hand_off_context with the matching workItemId or NEW_WORK_ITEM. ' +
      'Do not change files or start a subagent before that boundary.' + workChoiceNote(state);
}

/**
 * User-requested work defines completion; optional suggestions never extend it.
 * The entry keeps these bytes after complete_work succeeds, so the cached
 * prefix holds; the text must stay true in that state too.
 */
export const activeWorkNote =
  'Router: call complete_work once, when the user\'s request for this work item is complete, ' +
  'before your final response. After it succeeds, give your final response. ' +
  'Your own suggestions, next steps, offers to do more, or reported limitations do not keep the work open. ' +
  'Leave it open only if part of the request is incomplete, you need the user\'s answer to finish, ' +
  'or a test or build you ran for the request failed and remains unfixed. ' +
  'For different work, call hand_off_context.';

/**
 * The entry after a completed item and the rest of an entry that completed it
 * have the same restriction. Refusals do not spend the acquisition budget:
 * the model may still answer a question about completed work directly.
 * Mutation detection has the same best-effort limits as the rest of routing.
 */
export function gateCompletedWorkToolCall(
  event: Pick<ToolCallEvent, 'toolName' | 'input'>,
  session: RouterSession,
): ToolCallEventResult | undefined {
  try {
    const state = session.getWorkPhaseState();
    if (!state || session.getLastDecision()?.intentKey !== state.intentKey) return undefined;
    const workItemId = state.completion?.workItemId ?? state.priorCompletion?.workItemId;
    if (!workItemId) return undefined;
    if (event.toolName !== EXECUTION_CONTRACT_TOOL && event.toolName !== 'subagent'
      && !isMutationCall(event.toolName, event.input)) return undefined;
    const served = session.getLastServed();
    appendWorkLifecycleSignal({
      intentKey: state.intentKey, served: served ? servedKey(served) : 'unknown/unknown',
      action: 'gate', workItemId,
    });
    return {
      block: true,
        reason: state.completion
          ? 'Router: this call was not made. This entry completed its work item. ' +
            'For more changes to it, call reopen_work first. Otherwise give your final reply.'
          : 'Router: this call was not made. The work item is complete. ' +
            'For more changes to it, call reopen_work. ' +
            'For different work, call hand_off_context. A question about completed work needs neither.',
    };
  } catch {
    // A gate error must never fail the user's turn.
    return undefined;
  }
}
