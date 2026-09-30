/**
 * `hand_off_context`: the model-facing side of collecting context, and the
 * gate that keeps the phase read-only.
 *
 * Registered once and always active, like `commit_execution`: a changed tool
 * list rebuilds the prompt head and loses the prompt cache on most providers.
 * It declines without state changes whenever the handoff does not apply.
 * Logs carry codes, rubric levels, counts and model keys only: never
 * findings, the question, or paths.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
  ToolResultEventResult,
} from '@earendil-works/pi-coding-agent';
import { stat } from 'node:fs/promises';
import { Type, type Context, type UserMessage } from '@earendil-works/pi-ai';
import {
  AUTO_MODEL_ID,
  ROUTER_PROVIDER_ID,
  type ComplexityBand,
  type Dimension,
  type ReasoningEvidence,
  type TaskScope,
} from '../types.js';
import { appendInvestigationHandoffSignal, type InvestigationHandoffSignal } from '../host/decisionlog.js';
import { servedKey } from '../host/ui.js';
import { debugLog } from '../host/debuglog.js';
import { EXECUTION_CONTRACT_TOOL, resolveToolPath } from '../routing/policy/execution-contract.js';
import {
  ACQUISITION_READ_TOOLS,
  ACQUISITION_REQUEST_LIMIT,
  CONTEXT_HANDOFF_TOOL,
  CONVERSATION_EVIDENCE,
  MAX_EVIDENCE_PATHS,
  QUESTION_TOOL,
  acceptContextHandoff,
  acquisitionAllows,
  acquisitionRestricted,
  contextOwed,
  countDenial,
  evidencePaths,
  evidenceShape,
  noteInvestigationRead,
  owedContext,
} from '../routing/policy/context-acquisition.js';
import {
  parseReasoningRubric,
  reasoningMinimum,
  reasoningRequirement,
} from '../routing/policy/execution-difficulty.js';
import { isMutationCall } from '../routing/policy/mutation-detector.js';
import { floorForBand, withStrongerTerminal, type WorkPhaseState } from '../routing/policy/work-phase.js';
import { adoptAssessment } from '../routing/policy/assessment-adoption.js';
import { observeFiles, type Exec } from './execution-contract-tool.js';
import type { RouterSession } from './router-session-state.js';
import { planPendingIdentity, publishSelectedWork, recordHandoffMissed } from './context-resolution.js';
import { readBranch } from '../routing/context/persistence.js';
import { promptAnchorsForItem, referencedArtifactPaths } from '../routing/context/resolve.js';
import type { ContextPlan } from '../routing/context/resolve.js';
import type { ContextReason, GroundedArtifact, RoutingContextEvent } from '../routing/context/types.js';
import { getWorkItem } from '../routing/context/ledger.js';
import { contextCheck } from '../routing/context/resolve.js';
import { unmetArtifactPaths } from '../routing/context/grounding.js';
import { insideCwd } from './context-grounding.js';
import { ROUTING_CONTEXT_TOOL } from './routing-context-tool.js';

const DESCRIPTION =
  'Stop collecting context and give the request to the next step. Call it with outcome "ready" once you have ' +
  'what the next step needs: the task type the user wants, your findings, and what the next step must decide or ' +
  'do. For a plan or review, also rate the reasoning left. Call it with outcome "needs-user" when the request is ' +
  'unclear or what it rests on cannot be read, with the question to ask. The router picks the next model. Do not ' +
  'write the plan, review, or change yourself.';

const LEVELS = '1 (easiest) to 5 (hardest)';
const DIMENSIONS: readonly Dimension[] = ['lightweight', 'gather', 'implement', 'review', 'plan'];
const COMPLEXITIES: readonly ComplexityBand[] = ['trivial', 'routine', 'moderate', 'hard', 'frontier'];
const SCOPES: readonly TaskScope[] = ['bounded', 'open-ended'];
const NEEDS_USER_REASONS = ['ambiguous-request', 'missing-artifact', 'unavailable-tool', 'insufficient-evidence'] as const;

/** Built at registration, not import, so importing the handlers needs no schema runtime. */
function contextHandoffParameters() {
  const level = (description: string) => Type.Integer({ minimum: 1, maximum: 5, description });
  const oneOf = (values: readonly string[], description: string) =>
    Type.Union(values.map((value) => Type.Literal(value)), { description });
  return Type.Object({
    outcome: oneOf(['ready', 'needs-user'], 'ready: the next step can start. needs-user: ask the user first.'),
    question: Type.String({
      description: 'ready: what the next step must decide, judge, or do. needs-user: the question for the user.',
    }),
    findings: Type.Optional(Type.String({ description: 'ready: what you found.' })),
    deliverable: Type.Optional(oneOf(DIMENSIONS, 'ready: the task type the user wants now.')),
    workItemId: Type.Optional(Type.String({ description: 'ready, when work is not yet selected: an offered work item or legacy id, NEW_WORK_ITEM, or NONE for a lightweight side question.' })),
    topicId: Type.Optional(Type.String({ description: 'ready: the offered topic id, or NEW_TOPIC. Required when creating work in an existing topic.' })),
    topicTitle: Type.Optional(Type.String({ description: 'ready: a short title when using NEW_TOPIC.' })),
    workItemTitle: Type.Optional(Type.String({ description: 'ready: a short title when using NEW_WORK_ITEM.' })),
    complexity: Type.Optional(oneOf(COMPLEXITIES, 'ready: how hard that task is.')),
    scope: Type.Optional(oneOf(SCOPES, 'ready: whether the task is bounded or open-ended.')),
    files: Type.Optional(Type.Array(Type.String(), {
      maxItems: MAX_EVIDENCE_PATHS,
      description: 'ready: files the next step rests on. Leave empty when the evidence is in the conversation.',
    })),
    difficulty: Type.Optional(Type.Object({
      alternatives: level(`Viable approaches, ${LEVELS}. 1: one obvious approach or a clear-cut review; 5: several viable designs with real trade-offs, or a judgement-heavy review.`),
      stakes: level(`Cost of a wrong call, ${LEVELS}. 1: local and easy to undo; 5: a public interface, data format, migration, or security.`),
      spread: level(`Where the effects land, ${LEVELS}. 1: one file; 5: across the codebase.`),
      knowledge: level(`Knowledge needed beyond the evidence, ${LEVELS}. 1: none; 5: invariants across modules or external systems.`),
      uncertainty: level(`Open facts, ${LEVELS}. 1: the findings answer every question; 5: key facts are unknown and need experiments.`),
    }, { description: 'ready, for a plan or review: the reasoning left, rated per criterion.' })),
    reason: Type.Optional(oneOf(NEEDS_USER_REASONS, 'needs-user: why the user must answer first.')),
  });
}

export interface ContextHandoffSubmission {
  accepted: boolean;
  text: string;
}

const REJECTIONS = {
  'not-router-auto': `${CONTEXT_HANDOFF_TOOL} has no effect: the session model is not router/auto.`,
  'no-task': 'Context not handed off: no routed task is in progress. Continue with the current model.',
  'not-acquiring': 'Context not handed off: the handoff applies only while collecting context. Continue with the current model.',
  'already-handed-off': 'Context not handed off: this request was already handed off. Continue with the next step.',
  'clarification-only': 'Collecting context has ended for this request. Reply to the user with your question, without calling tools.',
  'missing-question': 'Context not handed off: give the question for the user. Call it again with outcome "needs-user" and a question.',
  'missing-findings': 'Context not handed off: describe the findings and the question. Call it again with both.',
  'missing-deliverable': 'Context not handed off: name the task type the user wants (deliverable). Call it again with it.',
  'artifact-not-read': 'Context not handed off: the request rests on files not read as they are now. Read them in full, then call it again:',
  'no-next-step': 'Context not handed off: a gather entry hands off only to implement, review, or plan. Call it again with one of those, or continue.',
  'missing-work-choice': 'Context not handed off: choose a listed workItemId, NEW_WORK_ITEM, or NONE for a lightweight side question.',
  'invalid-work-choice': 'Context not handed off: the work and topic ids must be from this entry’s offered choices. Choose again.',
  'missing-work-title': 'Context not handed off: give a short workItemTitle for NEW_WORK_ITEM.',
  'missing-topic-title': 'Context not handed off: give a short topicTitle for NEW_TOPIC.',
  'stale-entry': 'Context not handed off: this request is no longer the active entry.',
  'not-recorded': 'Context not handed off: the router could not record the handoff. Call it again.',
  internal: 'Context not handed off: internal router error. Call it again, or reply to the user.',
} as const;

type RejectCode = keyof typeof REJECTIONS;

export interface ContextHandoffParams {
  outcome?: unknown;
  question?: unknown;
  findings?: unknown;
  deliverable?: unknown;
  workItemId?: unknown;
  topicId?: unknown;
  topicTitle?: unknown;
  workItemTitle?: unknown;
  complexity?: unknown;
  scope?: unknown;
  files?: unknown;
  difficulty?: unknown;
  reason?: unknown;
}

const filled = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const member = <T extends string>(values: readonly T[], value: unknown): T | undefined =>
  values.includes(value as T) ? value as T : undefined;

type Open = { state: WorkPhaseState; served: string; acquiring: boolean };
type Opened = Open | { reject: RejectCode; state?: WorkPhaseState; served?: string };

/**
 * Whether the entry takes a handoff: while acquiring owed context, or a
 * `gather` entry escalating to implement, review, or plan.
 */
function openFor(ctx: Pick<ExtensionContext, 'model'> | undefined, session: RouterSession): Opened {
  if (ctx?.model?.provider !== ROUTER_PROVIDER_ID || ctx.model.id !== AUTO_MODEL_ID) return { reject: 'not-router-auto' };
  const state = session.getWorkPhaseState();
  const last = session.getLastDecision();
  const lastServed = session.getLastServed();
  const served = lastServed ? servedKey(lastServed) : undefined;
  if (!state || !last || !served || last.intentKey !== state.intentKey) return { reject: 'no-task' };
  if (state.contextStatus === 'clarification-only') return { reject: 'clarification-only', state, served };
  if (state.contextStatus === 'ready-pending' || state.contextStatus === 'served' || state.reasoningHandoff) {
    return { reject: 'already-handed-off', state, served };
  }
  if (state.contextStatus === 'acquiring') return { state, served, acquiring: true };
  if (last.dimension === 'gather' && !contextOwed(state)) return { state, served, acquiring: false };
  return { reject: 'not-acquiring', state, served };
}

/** A ready payload in canonical form: the same handoff again is idempotent. */
function handoffKey(params: ContextHandoffParams | undefined): string {
  const files = Array.isArray(params?.files) ? params.files.filter((f) => typeof f === 'string') : [];
  return JSON.stringify([
    params?.deliverable, params?.complexity, params?.scope,
    params?.workItemId, params?.topicId, params?.topicTitle, params?.workItemTitle,
    typeof params?.findings === 'string' ? params.findings.trim() : '',
    typeof params?.question === 'string' ? params.question.trim() : '',
    files, params?.difficulty ?? null,
  ]);
}

/** Declared files as absolute paths; anything that is not a non-empty string is ignored. */
export function declaredFiles(params: ContextHandoffParams | undefined, cwd: string): string[] {
  const files = Array.isArray(params?.files) ? params.files : [];
  return files
    .filter((file): file is string => typeof file === 'string' && file.trim() !== '')
    .slice(0, MAX_EVIDENCE_PATHS)
    .map((file) => resolveToolPath(cwd, file.trim()));
}

/**
 * Measure a handoff's evidence: the declared files, then the files the
 * acquisition read. No files means the evidence is in the conversation; a
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
 * The task type a ready handoff moves the entry to. An owed acquisition
 * adopts under the bounded rules. A gather entry that owes no context keeps
 * implement, review, or plan as reported, and has no next step otherwise.
 */
function adoptedDeliverable(open: Open, reported: Dimension, scope: TaskScope | undefined): Dimension | undefined {
  if (!open.acquiring) {
    return reported === 'implement' || reported === 'review' || reported === 'plan' ? reported : undefined;
  }
  const current = open.state.deliverable ?? 'gather';
  // A missing scope is open-ended: it can raise the entry, never lower it.
  return adoptAssessment({ heuristic: current, assessment: { kind: reported, scope: scope ?? 'open-ended' } }).dimension;
}

/** I/O the submission needs, supplied by the caller so the decision itself stays synchronous. */
export interface HandoffFacts {
  evidence?: ReasoningEvidence;
  /** Referenced files not read as they are now. */
  unmet?: string[];
  selectionError?: Extract<RejectCode, 'missing-work-choice' | 'invalid-work-choice' | 'missing-work-title' | 'missing-topic-title' | 'stale-entry'>;
  selection?: { plan: ContextPlan; key: string; generation: number; groundings: GroundedArtifact[] };
}

function log(
  state: WorkPhaseState,
  served: string,
  action: InvestigationHandoffSignal['action'],
  extra: Partial<InvestigationHandoffSignal> = {},
): void {
  const contextReasons = owedContext(state);
  appendInvestigationHandoffSignal({
    intentKey: state.intentKey, served, action, ...(contextReasons.length > 0 ? { contextReasons } : {}), ...extra,
  });
}

/** The refusal counts against acquisition; reaching the limit leaves only a question to the user. */
function reject(
  session: RouterSession,
  code: RejectCode,
  state: WorkPhaseState | undefined,
  served: string | undefined,
  detail = '',
): ContextHandoffSubmission {
  let text: string = REJECTIONS[code] + detail;
  if (state && served) {
    log(state, served, 'reject', { rejectReason: code });
    if (code !== 'not-recorded' && code !== 'internal' && code !== 'already-handed-off') {
      const next = countDenial(state);
      if (next !== state) {
        session.commitWorkPhaseState(next);
        if (next.contextStatus === 'clarification-only') {
          log(next, served, 'budget-exhausted');
          text += ` ${CLARIFICATION_TEXT}`;
        }
      }
    }
  }
  return { accepted: false, text };
}

const CLARIFICATION_TEXT =
  'Collecting context has ended for this request. Reply to the user now: say what you found and ask what you ' +
  'need to continue. Do not call tools.';

/**
 * Validate and record one handoff. The requester is the model that served
 * the invocation that called the tool. `facts` holds what the caller
 * measured for a ready outcome; see {@link prepareHandoffFacts}.
 */
export function submitContextHandoff(
  params: ContextHandoffParams | undefined,
  ctx: Pick<ExtensionContext, 'model'> | undefined,
  session: RouterSession,
  facts: HandoffFacts = {},
): ContextHandoffSubmission {
  const opened = openFor(ctx, session);
  if ('reject' in opened) {
    const repeat = opened.reject === 'already-handed-off' && params?.outcome === 'ready'
      && opened.state?.handoffKey === handoffKey(params);
    if (repeat) return { accepted: true, text: 'Context already handed off. Continue with the next step.' };
    return reject(session, opened.reject, opened.state, opened.served);
  }
  const { state, served } = opened;

  if (params?.outcome === 'needs-user') {
    if (!opened.acquiring) return reject(session, 'not-acquiring', state, served);
    if (!filled(params.question)) return reject(session, 'missing-question', state, served);
    const reason = member(NEEDS_USER_REASONS, params.reason);
    session.commitWorkPhaseState({ ...state, contextStatus: 'clarification-only' });
    log(state, served, 'needs-user', reason ? { rejectReason: reason } : {});
    return { accepted: true, text: `Context handed back to the user. ${CLARIFICATION_TEXT}` };
  }

  const reported = member(DIMENSIONS, params?.deliverable);
  if (!reported) return reject(session, 'missing-deliverable', state, served);
  if (!filled(params?.findings) || !filled(params?.question)) return reject(session, 'missing-findings', state, served);
  const complexity = member(COMPLEXITIES, params?.complexity);
  const scope = member(SCOPES, params?.scope);
  const deliverable = adoptedDeliverable(opened, reported, scope);
  if (!deliverable) return reject(session, 'no-next-step', state, served);
  if (facts.selectionError) return reject(session, facts.selectionError, state, served);
  if (facts.unmet && facts.unmet.length > 0) {
    return reject(session, 'artifact-not-read', state, served, ` ${facts.unmet.join(', ')}.`);
  }
  const selection = state.pendingIdentity ? facts.selection : undefined;
  if (state.pendingIdentity && (!selection || selection.key !== handoffKey(params))) {
    return reject(session, 'missing-work-choice', state, served);
  }
  if (selection && session.getSessionGeneration() !== selection.generation) {
    return reject(session, 'stale-entry', state, served);
  }
  const terminal = complexity && scope ? withStrongerTerminal(state, { kind: deliverable, complexity, scope }) : state;

  let reasoning;
  if (deliverable === 'plan' || deliverable === 'review') {
    const rubric = parseReasoningRubric(params?.difficulty);
    const evidence = facts.evidence ?? CONVERSATION_EVIDENCE;
    const requirement = reasoningRequirement(rubric, evidence);
    // The final step's band only raises the rubric's minimum; see withStrongerTerminal.
    // A recovery entry keeps its deliverable's ordinary minimum.
    const minimum = Math.max(
      reasoningMinimum(requirement),
      floorForBand(terminal.terminalBand) ?? 0,
      state.recoveryMinimum ? reasoningMinimum(1) : 0,
    );
    reasoning = { requester: served, target: deliverable, minimum, requirement, rubric, evidence };
  }
  const key = handoffKey(params);
  const plan = selection?.plan;
  const workItemId = plan?.workItemId ?? state.workItemId;
  const sourceEntryId = plan?.resolution.sourceEntryId ?? session.context.getEntrySource() ?? state.intentKey;
  const events: RoutingContextEvent[] = [...(plan?.events ?? [])];
  if (plan?.workItemId) {
    for (const artifact of selection?.groundings ?? []) {
      events.push({ v: 1, op: 'grounding-upsert', workItemId: plan.workItemId, artifact, sourceEntryId });
    }
  }
  const itemIsPresent = getWorkItem(session.context.getLedger(), workItemId)
    || events.some((event) => event.op === 'work-create' && event.workItem.id === workItemId);
  if (workItemId && itemIsPresent) {
    events.push({ v: 1, op: 'boundary', workItemId, boundary: 'investigation-handoff',
      handoffId: state.intentKey, sourceEntryId });
  }
  // One append-only branch record must include the selection and the releasing boundary.
  if (events.length > 0 && !session.context.appendCommit(events)) {
    session.context.setFastPathBlocked(true);
    return reject(session, 'not-recorded', state, served);
  }
  const selected = plan ? publishSelectedWork(session, plan) : undefined;
  const materialized = selected
    ? { ...terminal, pendingIdentity: undefined, provisionalGrounding: undefined,
      contextResolution: selected.resolution, workItemId: selected.workItemId,
      createdTopic: selected.createdTopic, createdWorkItem: selected.createdWorkItem,
      contextReasons: selected.resolution.contextReasons, contextSatisfied: true }
    : terminal;
  if (selected) {
    const cached = session.getCachedIntent();
    if (cached?.key === state.intentKey) session.setCachedIntent({ ...cached, context: selected, dimension: deliverable });
  }
  const next = acceptContextHandoff(materialized, { deliverable, key, ...(reasoning ? { reasoning } : {}) });
  session.commitWorkPhaseState(next);
  log(state, served, 'accept', {
    ...(next.reasoningHandoff ? { handoff: next.reasoningHandoff } : {}),
    deliverable,
  });
  if (next.reasoningHandoff) {
    const role = deliverable === 'plan' ? 'planning' : 'review';
    return {
      accepted: true,
      text: `Context handed off (${deliverable}, minimum ${next.reasoningHandoff.minimum.toFixed(2)}). A ${role} model ` +
        'chosen for this difficulty continues from the next step with your findings and question. Make no changes now.',
    };
  }
  return {
    accepted: true,
    text: `Context handed off (${deliverable}). The next step continues with your findings; make no changes now.`,
  };
}

/**
 * Measure what a ready handoff rests on, before {@link submitContextHandoff}:
 * the evidence of a planning or review target, and the referenced files not
 * read as they are now. Nothing is measured for a handoff that will be
 * declined.
 */
export async function prepareHandoffFacts(
  params: ContextHandoffParams | undefined,
  ctx: Pick<ExtensionContext, 'model' | 'cwd'> & Partial<Pick<ExtensionContext, 'sessionManager'>>,
  session: RouterSession,
  exec: Exec,
  signal?: AbortSignal,
): Promise<HandoffFacts> {
  if (params?.outcome !== 'ready') return {};
  const opened = openFor(ctx, session);
  const reported = member(DIMENSIONS, params.deliverable);
  if ('reject' in opened || !reported || !filled(params.findings) || !filled(params.question)) return {};
  const facts: HandoffFacts = {};
  const deliverable = adoptedDeliverable(opened, reported, member(SCOPES, params.scope));
  if (!deliverable) return {};
  const pending = opened.state.pendingIdentity;
  if (pending) {
    const branch = ctx.sessionManager ? readBranch(ctx.sessionManager) : undefined;
    if (session.getSessionGeneration() !== pending.generation
      || (branch?.length && !branch.some((entry) => entry && typeof entry === 'object'
        && (entry as { id?: unknown; type?: unknown; message?: { role?: unknown } }).id === pending.base.sourceEntryId
        && (entry as { type?: unknown; message?: { role?: unknown } }).type === 'message'
        && (entry as { message?: { role?: unknown } }).message?.role === 'user'))) {
      facts.selectionError = 'stale-entry';
      return facts;
    }
    const workItemId = filled(params.workItemId) ? params.workItemId.trim() : undefined;
    if (!workItemId) { facts.selectionError = 'missing-work-choice'; return facts; }
    const listed = pending.catalog.workItems.find((item) => item.id === workItemId);
    const legacy = pending.legacy.find((item) => item.id === workItemId);
    const topicId = filled(params.topicId) ? params.topicId.trim()
      : listed?.topicId ?? 'NEW_TOPIC';
    const shortTitle = (value: unknown) => filled(value) && value.trim().length <= 120;
    if (workItemId === 'NEW_WORK_ITEM' && !shortTitle(params.workItemTitle)) {
      facts.selectionError = 'missing-work-title'; return facts;
    }
    if (topicId === 'NEW_TOPIC' && workItemId !== 'NONE' && !shortTitle(params.topicTitle)) {
      facts.selectionError = 'missing-topic-title'; return facts;
    }
    if (workItemId === 'NONE' && deliverable !== 'lightweight') {
      facts.selectionError = 'invalid-work-choice'; return facts;
    }
    if (workItemId !== 'NEW_WORK_ITEM' && workItemId !== 'NONE' && !listed && !legacy) {
      facts.selectionError = 'invalid-work-choice'; return facts;
    }
    const plan = planPendingIdentity(session, pending, { workItemId, topicId }, deliverable, {
      ...(shortTitle(params.topicTitle) ? { topicTitle: (params.topicTitle as string).trim() } : {}),
      ...(shortTitle(params.workItemTitle) ? { workItemTitle: (params.workItemTitle as string).trim() } : {}),
    });
    if (!plan) { facts.selectionError = 'invalid-work-choice'; return facts; }
    const created = plan.events.find((event) => event.op === 'work-create');
    const existing = getWorkItem(session.context.getLedger(), plan.workItemId);
    const anchors = [...(existing?.anchors ?? created?.workItem.anchors ?? []), ...promptAnchorsForItem(pending.base.anchors)];
    const required = referencedArtifactPaths({ anchors });
    const groundings = (opened.state.provisionalGrounding ?? []).filter((artifact) => required.includes(artifact.anchorValue));
    const grounding = [...(existing?.grounding ?? []), ...groundings];
    facts.unmet = await unmetArtifactPaths(ctx.cwd, { grounding, openContext: [] }, required);
    if (facts.unmet.length > 0) return facts;
    facts.selection = { plan, key: handoffKey(params), generation: pending.generation, groundings };
  } else if (opened.acquiring && owedContext({ ...opened.state, deliverable }).includes('referenced-artifact')) {
    const item = getWorkItem(session.context.getLedger(), opened.state.workItemId);
    const check = contextCheck(['referenced-artifact'], item);
    if (item && 'freshPaths' in check) {
      // This handoff is the accepted investigation that closes a directory reference.
      facts.unmet = await unmetArtifactPaths(ctx.cwd, { ...item, openContext: [] }, check.freshPaths);
      if (facts.unmet.length > 0) return facts;
    }
  }
  if (deliverable === 'plan' || deliverable === 'review') {
    const paths = evidencePaths(declaredFiles(params, ctx.cwd), opened.state.readPaths);
    facts.evidence = await measureEvidence(exec, ctx.cwd, paths, signal);
  }
  return facts;
}

export function registerContextHandoffTool(pi: ExtensionAPI, session: RouterSession): void {
  try {
    pi.registerTool({
      name: CONTEXT_HANDOFF_TOOL,
      label: 'Hand Off Context',
      description: DESCRIPTION,
      promptSnippet: 'Stop collecting context. Give the request to the next step, or give it back to the user.',
      parameters: contextHandoffParameters(),
      // Later calls in the same batch see the handoff's outcome.
      executionMode: 'sequential',
      execute: async (_id, params, signal, _onUpdate, ctx) => {
        let result: ContextHandoffSubmission;
        try {
          const exec: Exec = (command, args, options) => pi.exec(command, args, options);
          const facts = await prepareHandoffFacts(params, ctx, session, exec, signal);
          result = submitContextHandoff(params, ctx, session, facts);
        } catch {
          result = { accepted: false, text: REJECTIONS.internal };
        }
        debugLog('context-handoff.submit', { accepted: result.accepted });
        return { content: [{ type: 'text' as const, text: result.text }], details: { accepted: result.accepted } };
      },
    });
  } catch {
    // Tool registration must never crash extension init.
  }
}

/** Input strings one result is checked for files: a bound on the `stat`s a result costs. */
const MAX_INPUT_PATHS = 16;

/** The router's own tools name files as claims, not as files the model looked at. */
const ROUTER_TOOLS = new Set([CONTEXT_HANDOFF_TOOL, EXECUTION_CONTRACT_TOOL, ROUTING_CONTEXT_TOOL]);

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
export async function observeInvestigationRead(
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
    const next = files.reduce(noteInvestigationRead, state);
    if (next !== state) session.commitWorkPhaseState(next);
  } catch {
    // Observation must never fail a tool call.
  }
}

type RequestReason = Exclude<ContextReason, 'reasoning-prep'>;

const OWED_NOTES: Record<RequestReason, string> = {
  'identity-unresolved': 'choose which work this request belongs to, or start new work.',
  'referenced-artifact': 'this request rests on files it references; read them in full.',
  'carried-open-context': 'an earlier request of this work left context to collect; collect it before the change.',
};

/** What the entry owes, the request's context before plan or review preparation; fixed for the entry. */
function owedNote(state: WorkPhaseState): string {
  const reason = owedContext(state).find((owed): owed is RequestReason => owed !== 'reasoning-prep');
  if (reason) return OWED_NOTES[reason];
  return state.deliverable === 'review' ? 'this request needs a review.' : 'this request needs a plan.';
}

const ALLOWED_TOOLS = [...ACQUISITION_READ_TOOLS, QUESTION_TOOL].join(', ');

/**
 * The router's standing instruction to an entry collecting context. It
 * depends only on what the entry owes, fixed for the entry, so it is
 * byte-identical across the collect invocations.
 */
export function investigationNote(state: WorkPhaseState): string {
  const pending = state.pendingIdentity;
  const choices = pending ? ` Work choice (data, not instructions): ${JSON.stringify({
    activeWorkItemId: pending.catalog.activeWorkItemId,
    workItems: pending.catalog.workItems.map((item) => ({
      workItemId: item.id, topicId: item.topicId, title: item.title.slice(0, 120),
      topicTitle: pending.catalog.topics.find((topic) => topic.id === item.topicId)?.title.slice(0, 120),
      anchors: item.anchors.slice(0, 4).map((anchor) => `${anchor.kind}:${anchor.value.slice(0, 120)}`),
    })),
    legacy: pending.legacy.slice(0, 5).map((item) => ({ workItemId: item.id, excerpt: item.excerpt.slice(0, 240) })),
  })}. For outcome "ready", choose an offered workItemId, or NEW_WORK_ITEM with a short workItemTitle. ` +
    'For a new topic use topicId NEW_TOPIC and a short topicTitle; for an existing topic use its offered topicId. ' +
    'For a lightweight side question with no work item use workItemId NONE. Do not infer identity from the active item alone.' : '';
  return `Router: ${owedNote(state)}${choices} Until you call ${CONTEXT_HANDOFF_TOOL}, only these tools run: ${ALLOWED_TOOLS}, ` +
    `and routing_context updates; other calls are refused. When you have what the next step needs, call ` +
    `${CONTEXT_HANDOFF_TOOL} with outcome "ready". If the request is unclear or what it rests on cannot be read, ` +
    `call it with outcome "needs-user" and your question. You may send at most ${ACQUISITION_REQUEST_LIMIT} ` +
    'model requests. Do not write the plan, review, or change yourself.';
}

/** The instruction for the one request after collecting context ended without a ready handoff. */
export const CLARIFICATION_NOTE = `Router: ${CLARIFICATION_TEXT}`;

/**
 * The delegated context of an entry collecting context: the note appended as
 * a text block to the entry's user message (the last user message), in the
 * delegated request only, never in Pi's transcript. The note sits at that
 * fixed position with the same bytes on every invocation of the phase, so
 * the prompt prefix — and its cache — stays identical, and no later message
 * is rewritten. A note at the tail would move on every invocation and
 * rewrite the history after its old position.
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
 * - an entry acquiring owed context, or a `gather` entry whose final step
 *   needs a strong model: on its first tool result;
 * - any other `gather` entry: on its first native edit/write result.
 * Each reminder is logged as a `nudge`.
 */
export function nudgeInvestigation(
  event: Pick<ToolResultEvent, 'toolName' | 'content'>,
  session: RouterSession,
): ToolResultEventResult | undefined {
  try {
    if (event.toolName === CONTEXT_HANDOFF_TOOL) return undefined;
    const state = currentEntry(session);
    if (!state || state.contextNudged || state.reasoningHandoff) return undefined;
    const acquiring = state.contextStatus === 'acquiring';
    if (!acquiring && (state.contextStatus != null || session.getLastDecision()?.dimension !== 'gather')) return undefined;
    const strongFinalStep = state.terminalBand === 'strong' || state.terminalBand === 'frontier';
    const anyResult = acquiring || strongFinalStep;
    if (!anyResult && event.toolName !== 'edit' && event.toolName !== 'write') return undefined;
    session.commitWorkPhaseState({ ...state, contextNudged: true });
    const lastServed = session.getLastServed();
    log(state, lastServed ? servedKey(lastServed) : 'unknown/unknown', 'nudge');
    const text = acquiring ? `Router note: ${owedNote(state)} Call ${CONTEXT_HANDOFF_TOOL} when you have it.` : INVESTIGATION_NUDGE;
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
 * phase holds for a pinned model too. A refused mutation or subagent spawn
 * while acquiring counts against the entry (see countDenial); a refused
 * reader, shell, or unknown tool does not. A refusal while a ready handoff
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
    if (!state || !restricted || acquisitionAllows(state.contextStatus, event.toolName, event.input)) {
      return undefined;
    }
    const lastServed = session.getLastServed();
    const served = lastServed ? servedKey(lastServed) : 'unknown/unknown';
    log(state, served, 'deny');
    if (state.contextStatus === 'ready-pending') {
      return {
        block: true,
        reason: 'Router: this call was not made. The context handoff was accepted; the next step, not this one, ' +
          'runs it. Continue without it.',
      };
    }
    if (state.contextStatus === 'clarification-only') {
      return { block: true, reason: `Router: this call was not made. ${CLARIFICATION_TEXT}` };
    }
    const counts = event.toolName === 'subagent' || isMutationCall(event.toolName, event.input);
    const next = counts ? countDenial(state) : state;
    if (next !== state) session.commitWorkPhaseState(next);
    if (next.contextStatus === 'clarification-only') {
      log(next, served, 'budget-exhausted');
      return { block: true, reason: `Router: this call was not made. ${CLARIFICATION_TEXT}` };
    }
    return { block: true, reason: `Router: this call was not made. ${investigationNote(state).slice('Router: '.length)}` };
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
export function closeInvestigationEntry(state: WorkPhaseState, served: string | undefined): WorkPhaseState {
  if (state.contextClosed) return state;
  const handoff = state.reasoningHandoff;
  if (handoff) {
    log(state, handoff.owner ?? served ?? handoff.requester, 'phase-end', { handoff });
  } else if (state.contextStatus === 'acquiring' || state.contextStatus === 'clarification-only') {
    log(state, served ?? 'unknown/unknown', 'no-handoff', state.deliverable ? { deliverable: state.deliverable } : {});
  } else {
    return state;
  }
  return { ...state, contextClosed: true };
}

/**
 * Before an entry's acquisition closes: a plan or review acquisition that
 * ended still acquiring answered in the reasoning model's place. Its work
 * item remembers that, so the item's next plan or review entry is served at
 * its deliverable. An entry that asked the user, or was placed on no work
 * item, records nothing.
 */
export function noteMissedHandoff(session: RouterSession, state: WorkPhaseState): void {
  const missed = !state.contextClosed && !state.reasoningHandoff && state.contextStatus === 'acquiring'
    && (state.deliverable === 'plan' || state.deliverable === 'review');
  if (missed) recordHandoffMissed(session, state, true);
}

/** Close the entry's acquisition once Pi's run has settled, so the last entry of a session is logged too. */
export function closeInvestigationOnSettle(session: RouterSession): void {
  try {
    const state = session.getWorkPhaseState();
    if (!state) return;
    noteMissedHandoff(session, state);
    const lastServed = session.getLastServed();
    const next = closeInvestigationEntry(state, lastServed ? servedKey(lastServed) : undefined);
    if (next !== state) session.commitWorkPhaseState(next);
  } catch {
    // Acquisition bookkeeping must never fail the end of a run.
  }
}

/**
 * Start a missed-handoff recovery: a plan or review entry on an item whose
 * previous acquisition answered in the reasoning model's place. The entry's
 * preparation is waived, since the same acquisition is not trusted to hand
 * off; any other owed context (a file, an investigation) is still acquired,
 * but by a model scored at the deliverable. Every phase of the entry keeps
 * that strength. The item's flag is cleared only once a qualifying model
 * serves the entry (see consumeRecovery). Logged as `waived`.
 */
export function waiveMissedInvestigation(
  session: RouterSession,
  state: WorkPhaseState | undefined,
): WorkPhaseState | undefined {
  try {
    if (!state || state.recoveryMinimum || state.contextStatus != null || state.reasoningHandoff) return state;
    if (state.deliverable !== 'plan' && state.deliverable !== 'review') return state;
    if (!getWorkItem(session.context.getLedger(), state.workItemId)?.handoffMissed) return state;
    const next: WorkPhaseState = { ...state, contextWaived: true, recoveryMinimum: true };
    session.commitWorkPhaseState(next);
    const lastServed = session.getLastServed();
    log(state, lastServed ? servedKey(lastServed) : 'unknown/unknown', 'waived', { deliverable: state.deliverable });
    return next;
  } catch {
    return state;
  }
}

/** A qualifying model served the recovery entry: its item's flag is used. */
export function consumeRecovery(session: RouterSession): void {
  try {
    const state = session.getWorkPhaseState();
    if (state?.recoveryMinimum) recordHandoffMissed(session, state, false);
  } catch {
    // The flag only strengthens a later entry; keeping it is the safe side.
  }
}
