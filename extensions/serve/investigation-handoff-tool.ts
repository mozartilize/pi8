/**
 * `hand_off_investigation`: the model-facing side of the investigation →
 * planning/review handoff.
 *
 * Registered once and always active, like `commit_execution`: a changed tool
 * list rebuilds the prompt head and loses the prompt cache on most providers.
 * It declines without state changes whenever the handoff does not apply, and
 * every entry point fails open. Logs carry codes, rubric levels, counts and
 * model keys only: never findings, the question, or paths.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
  ToolResultEventResult,
} from '@earendil-works/pi-coding-agent';
import { Type, type Context, type UserMessage } from '@earendil-works/pi-ai';
import { AUTO_MODEL_ID, ROUTER_PROVIDER_ID, type ReasoningEvidence } from '../types.js';
import { appendInvestigationHandoffSignal } from '../host/decisionlog.js';
import { servedKey } from '../host/ui.js';
import { debugLog } from '../host/debuglog.js';
import { resolveToolPath } from '../routing/policy/execution-contract.js';
import {
  CONVERSATION_EVIDENCE,
  INVESTIGATION_HANDOFF_TOOL,
  MAX_EVIDENCE_PATHS,
  acceptInvestigationHandoff,
  evidencePaths,
  evidenceShape,
  investigationOwed,
  noteInvestigationRead,
  reasoningTarget,
} from '../routing/policy/investigation-handoff.js';
import {
  parseReasoningRubric,
  reasoningMinimum,
  reasoningRequirement,
} from '../routing/policy/execution-difficulty.js';
import type { WorkPhaseState } from '../routing/policy/work-phase.js';
import { observeFiles, type Exec } from './execution-contract-tool.js';
import type { RouterSession } from './router-session-state.js';

const DESCRIPTION =
  'Hand an investigation to a planning or review model. Call it once you have the evidence a plan or review ' +
  'needs, or when your findings show that something must be decided or changed. The router picks the planner or ' +
  'reviewer from the difficulty you describe and the files it rests on. Do not write the plan or review yourself, ' +
  'and do not call it to get a stronger model for reading or answering.';

const LEVELS = '1 (easiest) to 5 (hardest)';

/** Built at registration, not import, so importing the handlers needs no schema runtime. */
function investigationHandoffParameters() {
  const level = (description: string) => Type.Integer({ minimum: 1, maximum: 5, description });
  return Type.Object({
    findings: Type.String({ description: 'What the investigation established.' }),
    question: Type.String({ description: 'What the planner or reviewer must decide or judge.' }),
    files: Type.Optional(Type.Array(Type.String(), {
      maxItems: MAX_EVIDENCE_PATHS,
      description: 'Files the decision or review rests on. Leave empty when the evidence is in the conversation.',
    })),
    difficulty: Type.Object({
      alternatives: level(`Viable approaches, ${LEVELS}. 1: one obvious approach or a clear-cut review; 5: several viable designs with real trade-offs, or a judgement-heavy review.`),
      stakes: level(`Cost of a wrong call, ${LEVELS}. 1: local and easy to undo; 5: a public interface, data format, migration, or security.`),
      spread: level(`Where the effects land, ${LEVELS}. 1: one file; 5: across the codebase.`),
      knowledge: level(`Knowledge needed beyond the evidence, ${LEVELS}. 1: none; 5: invariants across modules or external systems.`),
      uncertainty: level(`Open facts, ${LEVELS}. 1: the findings answer every question; 5: key facts are unknown and need experiments.`),
    }, { description: 'The reasoning left, rated per criterion.' }),
  });
}

export interface InvestigationHandoffSubmission {
  accepted: boolean;
  text: string;
}

const REJECTIONS = {
  'not-router-auto': `${INVESTIGATION_HANDOFF_TOOL} has no effect: the session model is not router/auto.`,
  'no-task': 'Investigation not handed off: no routed task is in progress. Continue with the current model.',
  pinned: 'Investigation not handed off: a model is pinned with /router-manual. Continue with the current model.',
  'not-investigation': 'Investigation not handed off: the handoff applies only while investigating. Continue with the current model.',
  'already-handed-off': 'Investigation not handed off: this request was already handed off. Continue with the current model.',
  'missing-findings': 'Investigation not handed off: describe the findings and the question. Call it again with both.',
} as const;

type RejectCode = keyof typeof REJECTIONS;

export interface InvestigationParams {
  findings?: unknown;
  question?: unknown;
  files?: unknown;
  difficulty?: unknown;
}

type Submittable = { state: WorkPhaseState; served: string } | { reject: RejectCode; state?: WorkPhaseState; served?: string };

const filled = (value: unknown) => typeof value === 'string' && value.trim() !== '';

function submittable(
  ctx: Pick<ExtensionContext, 'model'> | undefined,
  session: RouterSession,
  params: InvestigationParams | undefined,
): Submittable {
  if (ctx?.model?.provider !== ROUTER_PROVIDER_ID || ctx.model.id !== AUTO_MODEL_ID) return { reject: 'not-router-auto' };
  const state = session.getWorkPhaseState();
  const last = session.getLastDecision();
  const lastServed = session.getLastServed();
  const served = lastServed ? servedKey(lastServed) : undefined;
  if (!state || !last || !served || last.intentKey !== state.intentKey) return { reject: 'no-task' };
  if (session.getManualModel() != null) return { reject: 'pinned', state, served };
  if (state.reasoningHandoff) return { reject: 'already-handed-off', state, served };
  if (last.dimension !== 'gather') return { reject: 'not-investigation', state, served };
  if (!filled(params?.findings) || !filled(params?.question)) return { reject: 'missing-findings', state, served };
  return { state, served };
}

/** Whether a submission can be accepted, checked before measuring its files. */
export function investigationSubmissionOpen(
  ctx: Pick<ExtensionContext, 'model'> | undefined,
  session: RouterSession,
  params: InvestigationParams | undefined,
): boolean {
  return !('reject' in submittable(ctx, session, params));
}


/** Declared files as absolute paths; anything that is not a non-empty string is ignored. */
export function declaredFiles(params: InvestigationParams | undefined, cwd: string): string[] {
  const files = Array.isArray(params?.files) ? params.files : [];
  return files
    .filter((file): file is string => typeof file === 'string' && file.trim() !== '')
    .slice(0, MAX_EVIDENCE_PATHS)
    .map((file) => resolveToolPath(cwd, file.trim()));
}

/**
 * Measure a handoff's evidence: the declared files, then the files the
 * investigation read. No files means the evidence is in the conversation; a
 * file that does not exist or cannot be sized counts as unmeasured.
 */
export async function measureEvidence(
  exec: Exec,
  cwd: string,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<ReasoningEvidence> {
  if (paths.length === 0) return CONVERSATION_EVIDENCE;
  const observed = await observeFiles(exec, cwd, paths, signal);
  return {
    ...evidenceShape(paths),
    ...(observed.existingLines != null && observed.missingTargets === 0 ? { existingLines: observed.existingLines } : {}),
    ...(observed.commits != null ? { commits: observed.commits } : {}),
    ...(observed.fixCommits != null ? { fixCommits: observed.fixCommits } : {}),
  };
}

/**
 * Validate and record one request. The requester is the model that served the
 * invocation that called the tool.
 */
export function submitInvestigationHandoff(
  params: InvestigationParams | undefined,
  ctx: Pick<ExtensionContext, 'model'> | undefined,
  session: RouterSession,
  evidence: ReasoningEvidence = CONVERSATION_EVIDENCE,
): InvestigationHandoffSubmission {
  const open = submittable(ctx, session, params);
  if ('reject' in open) {
    if (open.state && open.served) {
      appendInvestigationHandoffSignal({
        intentKey: open.state.intentKey,
        served: open.served,
        action: 'reject',
        rejectReason: open.reject,
      });
    }
    return { accepted: false, text: REJECTIONS[open.reject] };
  }
  const { state, served } = open;
  const rubric = parseReasoningRubric(params?.difficulty);
  const requirement = reasoningRequirement(rubric, evidence);
  const target = reasoningTarget(state.deliverable);
  const next = acceptInvestigationHandoff(state, {
    requester: served,
    target,
    minimum: reasoningMinimum(requirement),
    requirement,
    rubric,
    evidence,
  });
  session.commitWorkPhaseState(next);
  const handoff = next.reasoningHandoff!;
  appendInvestigationHandoffSignal({ intentKey: state.intentKey, served, action: 'accept', handoff });
  const role = target === 'plan' ? 'planning' : 'review';
  return {
    accepted: true,
    text: `Investigation handed off (${target}, minimum ${handoff.minimum.toFixed(2)}). A ${role} model chosen ` +
      'for this difficulty continues from the next step with your findings and question.',
  };
}

export function registerInvestigationHandoffTool(pi: ExtensionAPI, session: RouterSession): void {
  try {
    pi.registerTool({
      name: INVESTIGATION_HANDOFF_TOOL,
      label: 'Hand Off Investigation',
      description: DESCRIPTION,
      promptSnippet: 'Hand a finished investigation to a planning or review model the router picks.',
      parameters: investigationHandoffParameters(),
      execute: async (_id, params, signal, _onUpdate, ctx) => {
        let result: InvestigationHandoffSubmission;
        try {
          let evidence = CONVERSATION_EVIDENCE;
          if (investigationSubmissionOpen(ctx, session, params)) {
            const paths = evidencePaths(declaredFiles(params, ctx.cwd), session.getWorkPhaseState()?.readPaths);
            evidence = await measureEvidence((command, args, options) => pi.exec(command, args, options), ctx.cwd, paths, signal);
          }
          result = submitInvestigationHandoff(params, ctx, session, evidence);
        } catch {
          result = { accepted: false, text: 'Investigation not handed off: internal router error. Continue with the current model.' };
        }
        debugLog('investigation-handoff.submit', { accepted: result.accepted });
        return { content: [{ type: 'text' as const, text: result.text }], details: { accepted: result.accepted } };
      },
    });
  } catch {
    // Tool registration must never crash extension init.
  }
}

/** Remember the paths an investigation reads, for measuring its handoff. */
export function observeInvestigationRead(
  event: Pick<ToolCallEvent, 'toolName' | 'input'>,
  ctx: Pick<ExtensionContext, 'cwd'>,
  session: RouterSession,
): void {
  try {
    if (event.toolName !== 'read') return;
    const path = (event.input as { path?: unknown } | undefined)?.path;
    const state = session.getWorkPhaseState();
    if (!state || typeof path !== 'string' || path.trim() === '') return;
    const next = noteInvestigationRead(state, resolveToolPath(ctx.cwd, path.trim()));
    if (next !== state) session.commitWorkPhaseState(next);
  } catch {
    // Observation must never fail a tool call.
  }
}

const OWED_NOTES = {
  plan: 'this request needs a plan. Gather what you need, then call ' +
    `${INVESTIGATION_HANDOFF_TOOL}; do not write the plan yourself.`,
  review: 'this request needs a review. Gather what you need, then call ' +
    `${INVESTIGATION_HANDOFF_TOOL}; do not write the review yourself.`,
  implement: 'this request needs a decided plan before its change. Gather what you need, then call ' +
    `${INVESTIGATION_HANDOFF_TOOL}; do not write the plan or make the change yourself.`,
} as const;

function owedNote(state: WorkPhaseState): string {
  return state.deliverable === 'review' ? OWED_NOTES.review
    : state.deliverable === 'implement' ? OWED_NOTES.implement
      : OWED_NOTES.plan;
}

/**
 * The router's standing instruction to an investigation that owes a plan or
 * review. It depends only on the deliverable, so it is byte-identical across
 * the investigation's invocations.
 */
export function investigationNote(state: WorkPhaseState): string {
  return `Router: ${owedNote(state)}`;
}

/**
 * The delegated context of an owed investigation: the note appended as a
 * text block to the entry's user message (the last user message), in the
 * delegated request only, never in Pi's transcript. The note sits at that
 * fixed position with the same bytes on every invocation of the
 * investigation, so the prompt prefix — and its cache — stays identical, and
 * no later message is rewritten. A note at the tail would move on every
 * invocation and rewrite the history after its old position.
 */
export function withInvestigationNote(context: Context, note: string): Context {
  const messages = context.messages ?? [];
  let index = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      index = i;
      break;
    }
  }
  if (index < 0) return context;
  const entry = messages[index] as UserMessage;
  const blocks = typeof entry.content === 'string'
    ? [{ type: 'text' as const, text: entry.content }]
    : entry.content;
  const noted: UserMessage = { ...entry, content: [...blocks, { type: 'text', text: note }] };
  return { ...context, messages: [...messages.slice(0, index), noted, ...messages.slice(index + 1)] };
}

/** Appended once per `gather` entry that may turn into planning, to its first edit/write result. */
export const INVESTIGATION_NUDGE =
  `Router note: if your findings show that something must be decided or changed, call ` +
  `${INVESTIGATION_HANDOFF_TOOL} with them so a planning model decides it. Otherwise continue.`;

/**
 * Remind an investigation of the handoff once per entry, appended to a tool
 * result so the transcript prefix and prompt cache stay intact:
 * - an entry that owes a plan or review, or a `gather` entry whose final step
 *   needs a strong model: on its first tool result;
 * - any other `gather` entry: on its first native edit/write result.
 * Each reminder is logged as a `nudge`.
 */
export function nudgeInvestigation(
  event: Pick<ToolResultEvent, 'toolName' | 'content'>,
  session: RouterSession,
): ToolResultEventResult | undefined {
  try {
    if (event.toolName === INVESTIGATION_HANDOFF_TOOL) return undefined;
    const state = session.getWorkPhaseState();
    const last = session.getLastDecision();
    if (!state || !last || last.intentKey !== state.intentKey || last.dimension !== 'gather') return undefined;
    if (state.reasoningHandoff || state.investigationNudged || session.getManualModel() != null) return undefined;
    const owed = investigationOwed(state);
    const strongFinalStep = state.terminalBand === 'strong' || state.terminalBand === 'frontier';
    const anyResult = owed || strongFinalStep;
    if (!anyResult && event.toolName !== 'edit' && event.toolName !== 'write') return undefined;
    session.commitWorkPhaseState({ ...state, investigationNudged: true });
    const lastServed = session.getLastServed();
    appendInvestigationHandoffSignal({
      intentKey: state.intentKey,
      served: lastServed ? servedKey(lastServed) : 'unknown/unknown',
      action: 'nudge',
    });
    const text = owed ? `Router note: ${owedNote(state)}` : INVESTIGATION_NUDGE;
    return { content: [...(event.content ?? []), { type: 'text', text }] };
  } catch {
    // A reminder failure must never change the tool result.
    return undefined;
  }
}

/**
 * End the entry's investigation bookkeeping: an accepted handoff logs how its
 * phase went (`phase-end`); an owed investigation that never handed off logs
 * `no-handoff`. Logged once per entry.
 */
export function closeInvestigationEntry(state: WorkPhaseState, served: string | undefined): WorkPhaseState {
  if (state.investigationClosed) return state;
  const handoff = state.reasoningHandoff;
  if (handoff) {
    appendInvestigationHandoffSignal({
      intentKey: state.intentKey,
      served: handoff.owner ?? served ?? handoff.requester,
      action: 'phase-end',
      handoff,
    });
  } else if (state.investigated && investigationOwed(state)) {
    appendInvestigationHandoffSignal({
      intentKey: state.intentKey,
      served: served ?? 'unknown/unknown',
      action: 'no-handoff',
      ...(state.deliverable ? { deliverable: state.deliverable } : {}),
    });
  } else {
    return state;
  }
  return { ...state, investigationClosed: true };
}

/** Close the entry's investigation once Pi's run has settled, so the last entry of a session is logged too. */
export function closeInvestigationOnSettle(session: RouterSession): void {
  try {
    const state = session.getWorkPhaseState();
    if (!state) return;
    const lastServed = session.getLastServed();
    const next = closeInvestigationEntry(state, lastServed ? servedKey(lastServed) : undefined);
    if (next !== state) session.commitWorkPhaseState(next);
  } catch {
    // Investigation bookkeeping must never fail the end of a run.
  }
}
