/**
 * `complete_work`: the model declares that the user's request for the active
 * work item is complete, whatever its last task type was.
 *
 * Only the user's request decides completion; the model's own suggestions
 * never keep work open, and a later follow-up reopens the same item. The
 * router closes the item and keeps its model as the incumbent, so the next
 * request is read first by the model that has the conversation.
 *
 * Registered once and always active: a changed tool list rebuilds the prompt
 * head and loses the prompt cache on most providers. It declines without
 * state changes whenever completion does not apply.
 */
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import { AUTO_MODEL_ID, ROUTER_PROVIDER_ID } from '../types.js';
import { servedKey } from '../host/ui.js';
import { debugLog } from '../host/debuglog.js';
import { appendWorkLifecycleSignal } from '../host/decisionlog.js';
import { activeWorkItem } from '../routing/context/ledger.js';
import { COMPLETE_WORK_TOOL } from '../routing/policy/work-completion.js';
import type { WorkPhaseState } from '../routing/policy/work-phase.js';
import type { RouterSession } from './router-session-state.js';

const DESCRIPTION = [
  'Call this tool when the work that the user requested is complete.',
  'The user\'s request decides what "complete" means. Your own ideas do not change it.',
  'These items do NOT keep the work open:',
  '- A suggestion that you made, such as an optional improvement, a refactor, or more tests.',
  '- A "next steps" list that you wrote.',
  '- An offer to do more work, such as "Do you want me to also change X?"',
  '- A risk or limitation that you reported, if the user did not ask you to fix it.',
  'The work stays open only in these conditions:',
  '- A part of the user\'s request is not complete.',
  '- You cannot complete the request without an answer from the user.',
  '- A test or build that you ran for this request failed, and you did not fix the failure.',
  'If the user later accepts one of your suggestions, the router reopens this work item.',
  'Thus this tool does not lose the work item.',
  'Call this tool before your final response.',
  'Do not use outcome "done" while an execution plan has steps that are not complete.',
  'Outcome "superseded" closes abandoned work even if its plan is not complete.',
  'Use outcome "done" when the request is complete.',
  'Use outcome "superseded" when the user abandoned the request or replaced it with a different request.',
].join('\n');

const OUTCOMES = ['done', 'superseded'] as const;
type Outcome = (typeof OUTCOMES)[number];

/** Built at registration, not import, so importing the handlers needs no schema runtime. */
function completeWorkParameters() {
  return Type.Object({
    outcome: Type.Union(OUTCOMES.map((value) => Type.Literal(value)), {
      description: 'done: the user\'s request is complete. superseded: the user abandoned or replaced the request.',
    }),
  });
}

const REJECTIONS = {
  'not-router-auto': `${COMPLETE_WORK_TOOL} has no effect: the session model is not router/auto.`,
  'no-task': 'Work not completed: no routed request is in progress. Continue.',
  'missing-outcome': 'Work not completed: give outcome "done" or "superseded". Call it again.',
  'no-active-work': 'Work not completed: no work item is active for this request. Continue without this tool.',
  'collecting-context': 'Work not completed: this request is still collecting context. Call hand_off_context first.',
  'handoff-pending': 'Work not completed: the next step of this request has not run yet. Continue with it.',
  'plan-unfinished': 'Work not completed: the execution plan has steps that are not complete. Complete them first.',
  'plan-broken': 'Work not completed: a broken execution plan returns to the model that submitted it. Continue with that step.',
  'already-complete': 'Work not completed: this request already completed its work item with another outcome.',
  'not-recorded': 'Work not completed: the router could not record it. Call it again.',
  internal: 'Work not completed: internal router error. Continue, and reply to the user.',
} as const;

type RejectCode = keyof typeof REJECTIONS;

export interface CompleteWorkParams {
  outcome?: unknown;
}

export interface CompleteWorkSubmission {
  accepted: boolean;
  text: string;
  workItemId?: string;
}

function reject(state: WorkPhaseState | undefined, served: string | undefined, code: RejectCode): CompleteWorkSubmission {
  if (state && served) {
    appendWorkLifecycleSignal({ intentKey: state.intentKey, served, action: 'complete-reject', rejectReason: code });
  }
  return { accepted: false, text: REJECTIONS[code] };
}

function acceptedText(status: Outcome): string {
  return status === 'done'
      ? 'Work item complete. Give your final reply to the user now. Do not change files. ' +
        'For more work on it, call reopen_work.'
    : 'Work item closed as superseded. Give your final reply to the user now. Do not change files.';
}

/**
 * Validate and record one completion. The caller is the model that served
 * the invocation that called the tool. Only the active work item completes;
 * the item and its boundary are appended in one branch record before any
 * runtime state changes.
 */
export function submitCompleteWork(
  params: CompleteWorkParams | undefined,
  ctx: Pick<ExtensionContext, 'model'> | undefined,
  session: RouterSession,
): CompleteWorkSubmission {
  if (ctx?.model?.provider !== ROUTER_PROVIDER_ID || ctx.model.id !== AUTO_MODEL_ID) return reject(undefined, undefined, 'not-router-auto');
  const state = session.getWorkPhaseState();
  const last = session.getLastDecision();
  const lastServed = session.getLastServed();
  const served = lastServed ? servedKey(lastServed) : undefined;
  if (!state || !last || !served || last.intentKey !== state.intentKey) return reject(undefined, undefined, 'no-task');
  const outcome = OUTCOMES.find((value) => value === params?.outcome);
  if (!outcome) return reject(state, served, 'missing-outcome');
  if (state.completion) {
    return state.completion.status === outcome
      ? { accepted: true, text: acceptedText(outcome), workItemId: state.completion.workItemId }
      : reject(state, served, 'already-complete');
  }
  const status = state.contextStatus;
  if (status === 'acquiring' || status === 'clarification-only') return reject(state, served, 'collecting-context');
  if (status === 'ready-pending') return reject(state, served, 'handoff-pending');
  const item = activeWorkItem(session.context.getLedger());
  if (!item) return reject(state, served, 'no-active-work');
  if (outcome === 'done' && state.contract?.status === 'active') return reject(state, served, 'plan-unfinished');
  if (outcome === 'done' && state.contract?.status === 'broken') return reject(state, served, 'plan-broken');

  const sourceEntryId = session.context.getEntrySource() ?? state.intentKey;
  const recorded = session.context.appendCommit([
    { v: 1, op: 'work-close', workItemId: item.id, status: outcome, sourceEntryId },
    { v: 1, op: 'boundary', workItemId: item.id, boundary: 'work-complete', handoffId: state.intentKey, sourceEntryId },
  ]);
  if (!recorded) return reject(state, served, 'not-recorded');
  session.commitWorkPhaseState({ ...state, completion: { workItemId: item.id, status: outcome } });
  appendWorkLifecycleSignal({
    intentKey: state.intentKey, served, action: 'complete-accept', workItemId: item.id, status: outcome,
    ...(item.lastDeliverable ? { deliverable: item.lastDeliverable } : {}),
  });
  return { accepted: true, text: acceptedText(outcome), workItemId: item.id };
}

export function registerCompleteWorkTool(pi: ExtensionAPI, session: RouterSession): void {
  try {
    pi.registerTool({
      name: COMPLETE_WORK_TOOL,
      label: 'Complete Work',
      description: DESCRIPTION,
      promptSnippet: 'Declare that the user\'s request for the current work is complete.',
      parameters: completeWorkParameters(),
      // Later calls in the same batch see the completion.
      executionMode: 'sequential',
      execute: async (_id, params, _signal, _onUpdate, ctx) => {
        let result: CompleteWorkSubmission;
        try {
          result = submitCompleteWork(params as CompleteWorkParams, ctx, session);
        } catch {
          result = { accepted: false, text: REJECTIONS.internal };
        }
        debugLog('complete-work.submit', { accepted: result.accepted });
        return {
          content: [{ type: 'text' as const, text: result.text }],
          details: { accepted: result.accepted, ...(result.workItemId ? { workItemId: result.workItemId } : {}) },
        };
      },
    });
  } catch {
    // Tool registration must never crash extension init.
  }
}
