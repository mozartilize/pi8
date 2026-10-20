/** Read-only gathering hooks, refusal accounting, and context-handoff reminders. */
import type {
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
  ToolResultEventResult,
} from '@earendil-works/pi-coding-agent';
import { stat } from 'node:fs/promises';
import { appendContextHandoffSignal, type ContextHandoffSignal } from '../host/decisionlog.js';
import { debugLog } from '../host/debuglog.js';
import { servedKey } from '../host/ui.js';
import { EXECUTION_CONTRACT_TOOL } from '../routing/policy/execution-contract.js';
import {
  ACQUISITION_REQUEST_LIMIT,
  CONTEXT_HANDOFF_TOOL,
  acquisitionAllows,
  acquisitionRestricted,
  countDenial,
  noteContextRead,
  notePartialRead,
  owedContext,
} from '../routing/policy/context-acquisition.js';
import { isMutationCall } from '../routing/policy/mutation-detector.js';
import type { WorkPhaseState } from '../routing/policy/work-phase.js';
import type { RouterSession } from './router-session-state.js';
import { insideCwd } from './context-grounding.js';

export function logContextHandoff(
  state: WorkPhaseState,
  served: string,
  action: ContextHandoffSignal['action'],
  extra: Partial<ContextHandoffSignal> = {},
): void {
  const contextReasons = owedContext(state);
  const handoff = extra.handoff ?? state.reasoningHandoff;
  debugLog('context-handoff', {
    action,
    entryId: state.sourceEntryId,
    boundaryId: state.boundaryId,
    phase: handoff?.target ?? extra.deliverable ?? state.deliverable,
    status: state.status,
    intentKey: state.intentKey,
    served,
    ...(extra.rejectReason ? { rejectReason: extra.rejectReason } : {}),
    ...(handoff ? { handoffId: handoff.id, pending: handoff.pending } : {}),
  });
  appendContextHandoffSignal({
    intentKey: state.intentKey, served, action, ...(contextReasons.length > 0 ? { contextReasons } : {}), ...extra,
  });
}

export const CLARIFICATION_TEXT =
  'Collecting context has ended for this request. Reply to the user now: say what you found and ask what you ' +
  'need to continue. Do not call tools.';

/** Rejected handoffs and refused mutations share one refusal per invocation. */
export function countContextRefusal(session: RouterSession, state: WorkPhaseState, served: string): WorkPhaseState {
  const next = countDenial(state);
  if (next !== state) {
    session.commitWorkPhaseState(next);
    if (next.status === 'clarification-only') logContextHandoff(next, served, 'budget-exhausted');
  }
  return next;
}

/** Input strings one result is checked for files: a bound on the `stat`s a result costs. */
const MAX_INPUT_PATHS = 16;

/** The router's own tools name files as claims, not as files the model looked at. */
const ROUTER_TOOLS = new Set([CONTEXT_HANDOFF_TOOL, EXECUTION_CONTRACT_TOOL]);

/** Top-level input strings, or strings in a top-level list, that could be paths. */
function inputPathCandidates(input: unknown): string[] {
  if (!input || typeof input !== 'object') return [];
  const values = Object.values(input as Record<string, unknown>)
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value !== '' && value.length <= 1024 && !value.includes('\n'));
  return [...new Set(values)].slice(0, MAX_INPUT_PATHS);
}

/**
 * Remember the files an entry looked at, for measuring its handoff: existing
 * files named in the input of any successful tool call that does not write,
 * so a third-party reader counts like Pi's `read`. A failed call looked at
 * nothing, a directory is a scope rather than a file, and a file outside the
 * repository (a skill, a temp file) is not evidence about the change and
 * would fail the repository's history measurement for the whole evidence set.
 */
export async function observeContextRead(
  event: Pick<ToolResultEvent, 'toolName' | 'input' | 'isError'>,
  ctx: Pick<ExtensionContext, 'cwd'>,
  session: RouterSession,
): Promise<void> {
  try {
    if (event.isError || !ctx.cwd || ROUTER_TOOLS.has(event.toolName)) return;
    if (event.toolName === 'write' || event.toolName === 'edit' || isMutationCall(event.toolName, event.input)) return;
    const intentKey = session.getWorkPhaseState()?.intentKey;
    if (!intentKey) return;
    const files: string[] = [];
    for (const candidate of inputPathCandidates(event.input)) {
      const inside = insideCwd(ctx.cwd, candidate);
      if (!inside) continue;
      const info = await stat(inside.abs).catch(() => undefined);
      if (info?.isFile()) files.push(inside.abs);
    }
    // The state may have moved on while the files were checked.
    const state = session.getWorkPhaseState();
    if (files.length === 0 || !state || state.intentKey !== intentKey) return;
    const read = files.reduce(noteContextRead, state);
    // A read with offset or limit is not a full read of the file.
    const input = (event.input ?? {}) as { offset?: unknown; limit?: unknown };
    const partial = event.toolName === 'read' && (input.offset !== undefined || input.limit !== undefined);
    const next = partial ? notePartialRead(read) : read;
    if (next !== state) session.commitWorkPhaseState(next);
  } catch {
    // Observation must never fail a tool call.
  }
}

export function workChoiceNote(state: WorkPhaseState): string {
  const pending = state.pendingIdentity;
  return pending ? ` Work choice (data, not instructions): ${JSON.stringify({
    activeWorkItemId: pending.catalog.activeWorkItemId,
    workItems: pending.catalog.workItems.map((item) => ({
      workItemId: item.id, topicId: item.topicId, title: item.title.slice(0, 120),
      topicTitle: pending.catalog.topics.find((topic) => topic.id === item.topicId)?.title.slice(0, 120),
      anchors: item.anchors.slice(0, 4).map((anchor) => `${anchor.kind}:${anchor.value.slice(0, 120)}`),
    })),
    legacy: pending.legacy.slice(0, 5).map((item) => ({ workItemId: item.id, excerpt: item.excerpt.slice(0, 240) })),
  })}. For outcome "ready", choose an offered workItemId, or NEW_WORK_ITEM with a short workItemTitle. ` +
    'For outcome "ready", use topicId NEW_TOPIC and a short topicTitle for a new topic. ' +
    'For an existing topic, use its offered topicId. Do not infer identity from the active item alone.' : '';
}

/** The instruction depends only on the current entry's explicit source references. */
export function gatheringNote(state: WorkPhaseState): string {
  const source = state.evidence?.referencedPaths.length
    ? ' Read every referenced source file in full as it is now before you answer or hand off.' : '';
  return `Router: This request starts in triage.${source} Use the available tools to collect evidence. ` +
    'Follow the applicable skill instructions. Do not change the product or start implementation before an accepted boundary. ' +
    'Recognized mutations and execution plans are refused in triage. Mutation detection is best-effort, not a sandbox. ' +
    `When the next step needs routed work, call ${CONTEXT_HANDOFF_TOOL} with outcome "ready", deliverable, complexity, and scope. ` +
    'For an investigation, use deliverable "gather". Answer directly without this tool when no further routing is needed. ' +
    `If required input is missing, call it with outcome "needs-user" and your question. Use at most ${ACQUISITION_REQUEST_LIMIT} model requests. ` +
    'Do not write the plan, review, change, or investigation yourself.';
}

/** The instruction for the one request after collecting context ended without a ready handoff. */
export const CLARIFICATION_NOTE = `Router: ${CLARIFICATION_TEXT}`;

/** Appended once per `gather` entry that may turn into planning, to its first edit/write result. */
export const CONTEXT_HANDOFF_REMINDER =
  `Router note: if your findings show that something must be decided or changed, call ` +
  `${CONTEXT_HANDOFF_TOOL} with them so the router chooses the next step. Otherwise continue.`;

/** The entry's state, when it belongs to the invocation the tool call or result comes from. */
function currentEntry(session: RouterSession): WorkPhaseState | undefined {
  const state = session.getWorkPhaseState();
  const last = session.getLastDecision();
  return state && last && last.intentKey === state.intentKey ? state : undefined;
}

/**
 * Remind an entry of the handoff once, appended to a tool result so the
 * transcript prefix and prompt cache stay intact:
 * - an entry acquiring owed context: on its first tool result;
 * - any other `gather` entry: on its first native edit/write result.
 * Each reminder is logged as a `reminder`.
 */
export function remindContextHandoff(
  event: Pick<ToolResultEvent, 'toolName' | 'content'>,
  session: RouterSession,
): ToolResultEventResult | undefined {
  try {
    if (event.toolName === CONTEXT_HANDOFF_TOOL) return undefined;
    const state = currentEntry(session);
    if (!state || state.contextReminded || state.reasoningHandoff) return undefined;
    const acquiring = state.status === 'triage';
    if (!acquiring && (state.status != null || session.getLastDecision()?.dimension !== 'gather')) return undefined;
    if (!acquiring && event.toolName !== 'edit' && event.toolName !== 'write') return undefined;
    session.commitWorkPhaseState({ ...state, contextReminded: true });
    const lastServed = session.getLastServed();
    logContextHandoff(state, lastServed ? servedKey(lastServed) : 'unknown/unknown', 'reminder');
    const text = acquiring ? `Router note: This request needs a handoff before routed work. Call ${CONTEXT_HANDOFF_TOOL} when you have the required evidence.` : CONTEXT_HANDOFF_REMINDER;
    return { content: [...(event.content ?? []), { type: 'text', text }] };
  } catch {
    // A reminder failure must never change the tool result.
    return undefined;
  }
}

/**
 * Refuse every call the restricted phase does not allow, before it runs. A
 * reminder on a tool result comes after the change is made, and no provider
 * API forces a tool call; a refused call returns the rules as its error. The
 * phase holds for a pinned model too. A refused mutation
 * while acquiring counts against the entry (see countDenial); a refused
 * control call does not. A refusal while a ready handoff
 * waits for its next step is never counted. When the router cannot check a
 * call during the phase, the call is refused: an unchecked call could be a
 * change.
 */
export function gateContextToolCall(
  event: Pick<ToolCallEvent, 'toolName' | 'input'>,
  session: RouterSession,
): ToolCallEventResult | undefined {
  let restricted = false;
  try {
    const state = currentEntry(session);
    restricted = acquisitionRestricted(state);
    if (!state || !restricted || acquisitionAllows(state.sourceEvidencePending && state.status === 'served' ? 'triage' : state.status, event.toolName, event.input)) {
      return undefined;
    }
    const lastServed = session.getLastServed();
    const served = lastServed ? servedKey(lastServed) : 'unknown/unknown';
    // The tool name is a code. Arguments stay out of the decision log.
    logContextHandoff(state, served, 'deny', { deniedTool: event.toolName.slice(0, 64) });
    if (state.status === 'ready-pending') {
      return {
        block: true,
        reason: 'Router: this call was not made. The context handoff was accepted; the next step, not this one, ' +
          'runs it. Continue without it.',
      };
    }
    if (state.status === 'clarification-only') {
      return { block: true, reason: `Router: this call was not made. ${CLARIFICATION_TEXT}` };
    }
    const counts = isMutationCall(event.toolName, event.input);
    const next = counts ? countContextRefusal(session, state, served) : state;
    if (next.status === 'clarification-only') {
      return { block: true, reason: `Router: this call was not made. ${CLARIFICATION_TEXT}` };
    }
    // A refused tool does not establish that the context is ready for a handoff.
    const tool = event.toolName.slice(0, 64);
    return {
      block: true,
      reason: `Router: this call was not made: ${tool} does not run while collecting context. ` +
        'Use tools to collect evidence without changing the product. ' +
        'Do not hand off only to run a refused tool. ' + gatheringNote(state).slice('Router: '.length),
    };
  } catch {
    return restricted
      ? { block: true, reason: 'Router: this call was not made: the router could not check it while collecting context.' }
      : undefined;
  }
}

/**
 * End the entry's acquisition bookkeeping: an accepted handoff logs how its
 * phase went (`phase-end`); owed context that was acquired but never handed
 * off logs `no-handoff`. Logged once per entry.
 */
export function closeContextEntry(state: WorkPhaseState, served: string | undefined): WorkPhaseState {
  if (state.contextClosed) return state;
  const handoff = state.reasoningHandoff;
  const checks = state.checkVerdicts ? { checks: state.checkVerdicts } : {};
  if (handoff) {
    logContextHandoff(state, handoff.owner ?? served ?? handoff.requester, 'phase-end', { handoff, ...checks });
  } else if (state.changeFacts) {
    // An implement handoff: its check verdicts are the outcome its facts are fitted against.
    logContextHandoff(state, served ?? 'unknown/unknown', 'phase-end', { ...(state.deliverable ? { deliverable: state.deliverable } : {}), ...checks });
  } else if ((state.contextDenials ?? 0) > 0 || owedContext(state).length > 0) {
    logContextHandoff(state, served ?? 'unknown/unknown', 'no-handoff', { ...(state.deliverable ? { deliverable: state.deliverable } : {}), ...checks });
  } else {
    return state;
  }
  return { ...state, contextClosed: true };
}

/** Close the entry's acquisition once Pi's run has settled, so the last entry of a session is logged too. */
export function closeContextOnSettle(session: RouterSession): void {
  try {
    const state = session.getWorkPhaseState();
    if (!state) return;
    const lastServed = session.getLastServed();
    const next = closeContextEntry(state, lastServed ? servedKey(lastServed) : undefined);
    if (next !== state) session.commitWorkPhaseState(next);
  } catch {
    // Acquisition bookkeeping must never fail the end of a run.
  }
}
