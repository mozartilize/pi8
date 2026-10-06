/**
 * `hand_off_context`: validate and record the model's context handoff.
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
} from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import {
  AUTO_MODEL_ID,
  ROUTER_PROVIDER_ID,
  type ComplexityBand,
  type Dimension,
  type ReasoningEvidence,
  type TaskScope,
} from '../types.js';
import { servedKey } from '../host/ui.js';
import { debugLog } from '../host/debuglog.js';
import { resolveToolPath } from '../routing/policy/execution-contract.js';
import {
  CONTEXT_HANDOFF_TOOL,
  CONVERSATION_EVIDENCE,
  MAX_EVIDENCE_PATHS,
  acceptContextHandoff,
  contextOwed,
  evidencePaths,
  evidenceShape,
  owedContext,
} from '../routing/policy/context-acquisition.js';
import {
  parseReasoningRubric,
  reasoningMinimum,
  reasoningRequirement,
} from '../routing/policy/execution-difficulty.js';
import { terminalMinimum, withContinuedPenalties, withStrongerTerminal, type WorkPhaseState } from '../routing/policy/work-phase.js';
import { evaluationPolicyVersion } from '../routing/policy/policy-version.js';
import { observeFiles, type Exec } from './execution-contract-tool.js';
import type { RouterSession } from './router-session-state.js';
import { planPendingIdentity, publishSelectedWork } from './context-resolution.js';
import { readBranch } from '../routing/context/persistence.js';
import { promptAnchorsForItem, referencedArtifactPaths } from '../routing/context/resolve.js';
import type { ContextPlan } from '../routing/context/resolve.js';
import type { GroundedArtifact, RoutingContextEvent } from '../routing/context/types.js';
import { getWorkItem } from '../routing/context/ledger.js';
import { contextCheck } from '../routing/context/resolve.js';
import { unmetArtifactPaths } from '../routing/context/grounding.js';
import { CLARIFICATION_TEXT, countContextRefusal, logContextHandoff as log } from './gathering-gate.js';
import { decisionEvidence } from '../routing/policy/decision-evidence.js';
import { ROUTER_TOOLS_CONDITION } from './router-tools-note.js';
import { factsLog, parseDeclaredFacts, type ChangeMeasurements } from '../routing/policy/change-facts.js';
import { defaultRequirement } from '../routing/score/scorer.js';
import { changeFactsParameter } from './change-facts-schema.js';
import { measureChange } from './change-measurements.js';

const DESCRIPTION =
  `${ROUTER_TOOLS_CONDITION} ` +
  'Stop collecting context and give the request to the next step. Call it with outcome "ready" once you have ' +
  'what the next step needs: the task type the user wants, your findings, and what the next step must decide or ' +
  'do. Give the facts that you observed about the remaining work. For a plan or review, also rate the reasoning left. Call it with outcome "needs-user" when the request is ' +
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
    outcome: oneOf(['ready', 'answer', 'needs-user'], 'ready: hand off to a work phase. answer: answer directly as gather or lightweight. needs-user: ask the user first.'),
    question: Type.Optional(Type.String({
      description: 'Required for ready or needs-user: what the next step must do, or the question for the user.',
    })),
    findings: Type.Optional(Type.String({ description: 'ready: what you found.' })),
    deliverable: Type.Optional(oneOf(DIMENSIONS, 'Required for ready or answer: declare the task type. answer accepts only gather or lightweight.')),
    workItemId: Type.Optional(Type.String({ description: 'ready, when work is not yet selected: an offered work item or legacy id, NEW_WORK_ITEM, or NONE for a lightweight side question.' })),
    topicId: Type.Optional(Type.String({ description: 'ready: the offered topic id, or NEW_TOPIC. Required when creating work in an existing topic.' })),
    topicTitle: Type.Optional(Type.String({ description: 'ready: a short title when using NEW_TOPIC.' })),
    workItemTitle: Type.Optional(Type.String({ description: 'ready: a short title when using NEW_WORK_ITEM.' })),
    complexity: Type.Optional(oneOf(COMPLEXITIES, 'Required for ready or answer: how hard the task is.')),
    scope: Type.Optional(oneOf(SCOPES, 'Required for ready or answer: bounded or open-ended.')),
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
    facts: changeFactsParameter({
      changesAndCheck: true,
      description: 'ready: facts that you observed about the remaining work. The router checks them and uses them to ' +
        'choose the next model. Omit a fact that you did not observe.',
    }),
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
  'missing-findings': 'Context not handed off: a field is empty. Put what you found in findings. Put what the next step must do in question. Empty:',
  'missing-deliverable': 'Context not handed off: name the task type the user wants (deliverable). Call it again with it.',
  'missing-task-shape': 'Context not handed off: give complexity and scope for the declared task. Call it again with both.',
  'artifact-not-read': 'Context not handed off: the request rests on files not read in full as they are now. A read with ' +
    'offset or limit is not a full read. Read each file in one call without offset or limit, then call it again:',
  'no-next-step': 'Context not handed off: a gather entry hands off only to implement, review, or plan. Call it again with one of those, or continue.',
  'missing-work-choice': 'Context not handed off: choose a listed workItemId, NEW_WORK_ITEM, or NONE for a lightweight side question.',
  'invalid-work-choice': 'Context not handed off: the work and topic ids must be from this entry’s offered choices. Choose again.',
  'missing-work-title': 'Context not handed off: give a short workItemTitle for NEW_WORK_ITEM.',
  'missing-topic-title': 'Context not handed off: give a short topicTitle for NEW_TOPIC.',
  'stale-entry': 'Context not handed off: this request is no longer the active entry.',
  'use-reopen-work': 'Context not handed off: this is the completed work item you own. For more changes to it, call reopen_work.',
  'not-recorded': 'Context not handed off: the router could not record the handoff. Call it again.',
  internal: 'Context not handed off: internal router error. Call it again, or reply to the user.',
} as const;

type RejectCode = keyof typeof REJECTIONS;

/**
 * Rejections that count against acquisition: the model must collect more
 * context before a handoff can pass. A rejection of the payload shape does
 * not count: the model fixes it by calling again, and the request limit stops
 * a loop of them.
 */
const CONTEXT_REJECTIONS: ReadonlySet<RejectCode> = new Set(['artifact-not-read']);

/** The reason alone, for a rejection that ends acquisition: the model must not read or call again. */
const ENDING_REJECTIONS: Partial<Record<RejectCode, string>> = {
  'artifact-not-read': 'Context not handed off: the request rests on files not read in full as they are now:',
};

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
  facts?: unknown;
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
  // The incumbent changes phase by handing off; the router picks the next model.
  if (state.incumbentServes) return { state, served, acquiring: false };
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
    files, params?.difficulty ?? null, params?.facts ?? null,
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

/** Ready declares the next work phase; gather/lightweight answers use a separate outcome. */
function adoptedDeliverable(reported: Dimension): Dimension | undefined {
  return reported === 'implement' || reported === 'review' || reported === 'plan' ? reported : undefined;
}

/** I/O the submission needs, supplied by the caller so the decision itself stays synchronous. */
export interface HandoffFacts {
  evidence?: ReasoningEvidence;
  /** Router measurements of the declared change. */
  change?: ChangeMeasurements;
  /** Referenced files not read as they are now. */
  unmet?: string[];
  selectionError?: Extract<RejectCode, 'missing-work-choice' | 'invalid-work-choice' | 'missing-work-title' | 'missing-topic-title' | 'stale-entry'>;
  selection?: { plan: ContextPlan; key: string; generation: number; groundings: GroundedArtifact[] };
}

/**
 * A missing-context refusal counts against acquisition; reaching the limit
 * leaves only a question to the user, so that text gives only that instruction.
 */
function reject(
  session: RouterSession,
  code: RejectCode,
  state: WorkPhaseState | undefined,
  served: string | undefined,
  detail = '',
): ContextHandoffSubmission {
  if (state && served) {
    log(state, served, 'reject', { rejectReason: code });
    if (CONTEXT_REJECTIONS.has(code)) {
      const next = countContextRefusal(session, state, served);
      if (next !== state && next.contextStatus === 'clarification-only') {
        return { accepted: false, text: `${ENDING_REJECTIONS[code] ?? REJECTIONS[code]}${detail} ${CLARIFICATION_TEXT}` };
      }
    }
  }
  return { accepted: false, text: REJECTIONS[code] + detail };
}

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
    session.commitWorkPhaseState({ ...state, contextStatus: 'clarification-only', contextNeedsUser: true });
    log(state, served, 'needs-user', reason ? { rejectReason: reason } : {});
    return { accepted: true, text: `Context handed back to the user. ${CLARIFICATION_TEXT}` };
  }

  const reported = member(DIMENSIONS, params?.deliverable);
  if (!reported) return reject(session, 'missing-deliverable', state, served);
  if (params?.outcome === 'answer') {
    if (!opened.acquiring) return reject(session, 'not-acquiring', state, served);
    if (reported !== 'gather' && reported !== 'lightweight') return reject(session, 'no-next-step', state, served);
    const complexity = member(COMPLEXITIES, params.complexity);
    const scope = member(SCOPES, params.scope);
    if (!complexity || !scope) return reject(session, 'missing-task-shape', state, served);
    // A direct answer declares its type but creates neither work nor an incumbent.
    session.commitWorkPhaseState({ ...state, contextAnswer: reported, pendingIdentity: undefined, provisionalGrounding: undefined });
    log(state, served, 'answer', { deliverable: reported });
    return { accepted: true, text: `Declared ${reported}. Answer the user directly; do not make changes.` };
  }
  if (!filled(params?.findings) || !filled(params?.question)) {
    // Name each empty field: a model that put the question into findings must see which field to fill.
    const empty = [filled(params?.findings) ? '' : 'findings', filled(params?.question) ? '' : 'question'].filter(Boolean);
    return reject(session, 'missing-findings', state, served, ` ${empty.join(', ')}. Call it again with both fields.`);
  }
  const complexity = member(COMPLEXITIES, params?.complexity);
  const scope = member(SCOPES, params?.scope);
  const deliverable = adoptedDeliverable(reported);
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
  // The completed item this model owns has one reopen protocol, reopen_work;
  // a handoff still reopens any other done item.
  const owned = state.priorCompletion?.workItemId ?? state.completion?.workItemId;
  if (owned && selection?.plan.workItemId === owned && selection.plan.resolution.relation === 'reopen') {
    return reject(session, 'use-reopen-work', state, served);
  }
  if (!complexity || !scope) return reject(session, 'missing-task-shape', state, served);
  const policyVersion = evaluationPolicyVersion();
  const terminal = withStrongerTerminal(state, { kind: deliverable, complexity, scope }, policyVersion);

  let reasoning;
  if (deliverable === 'plan' || deliverable === 'review') {
    const rubric = parseReasoningRubric(params?.difficulty);
    const evidence = facts.evidence ?? CONVERSATION_EVIDENCE;
    // Without a rubric the default minimums of the task type apply.
    const requirement = rubric ? reasoningRequirement(rubric, evidence) : undefined;
    // The final step's band only raises the rubric's minimum; see withStrongerTerminal.
    const raised = terminalMinimum(terminal, deliverable, policyVersion);
    const minimum = requirement !== undefined ? Math.max(reasoningMinimum(requirement), raised ?? 0) : raised;
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
    return reject(session, 'not-recorded', state, served);
  }
  const selected = plan ? publishSelectedWork(session, plan) : undefined;
  const materialized = selected
    ? withContinuedPenalties({ ...terminal, pendingIdentity: undefined, provisionalGrounding: undefined,
      contextResolution: selected.resolution, workItemId: selected.workItemId,
      contextReasons: selected.resolution.contextReasons, contextSatisfied: true },
    selected.workItemId, selected.resolution.relation)
    : terminal;
  if (selected) {
    const cached = session.getCachedIntent();
    if (cached?.key === state.intentKey) session.setCachedIntent({ ...cached, context: selected, dimension: deliverable });
  }
  const declared = parseDeclaredFacts(params?.facts);
  // The shadow requirement is logged next to the one routing uses; it does not route.
  const changeFacts = {
    ...(declared ? { declared } : {}),
    log: factsLog(deliverable, declared, facts.change ?? {}, reasoning?.minimum ?? defaultRequirement(deliverable), policyVersion),
  };
  const next = acceptContextHandoff(materialized, { deliverable, key, ...(reasoning ? { reasoning } : {}) });
  session.commitWorkPhaseState({ ...next, changeFacts, priorCompletion: undefined, completion: undefined });
  log(state, served, 'accept', {
    ...(next.reasoningHandoff ? { handoff: next.reasoningHandoff } : {}),
    deliverable,
    facts: changeFacts.log,
    evidence: decisionEvidence(deliverable, changeFacts.log, state.checkVerdicts, {
      partialReadCount: state.partialReadCount ?? 0,
      trajectorySignals: session.trajectorySignals(),
    }),
  });
  if (next.reasoningHandoff) {
    const role = deliverable === 'plan' ? 'planning' : 'review';
    return {
      accepted: true,
      text: `Context handed off (${deliverable}, ${next.reasoningHandoff.minimum !== undefined ? `minimum ${next.reasoningHandoff.minimum.toFixed(2)}` : 'default minimum'}). A ${role} model ` +
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
  tools?: readonly string[],
): Promise<HandoffFacts> {
  if (params?.outcome !== 'ready') return {};
  const opened = openFor(ctx, session);
  const reported = member(DIMENSIONS, params.deliverable);
  if ('reject' in opened || !reported || !filled(params.findings) || !filled(params.question)) return {};
  const facts: HandoffFacts = {};
  const deliverable = adoptedDeliverable(reported);
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
    // Entry-local reads supersede stored hashes of the same files.
    const grounding = [...groundings, ...(existing?.grounding ?? []).filter(
      (artifact) => !groundings.some((fresh) => fresh.anchorValue === artifact.anchorValue),
    )];
    facts.unmet = await unmetArtifactPaths(ctx.cwd, { grounding, openContext: [] }, required);
    if (facts.unmet.length > 0) return facts;
    facts.selection = { plan, key: handoffKey(params), generation: pending.generation, groundings };
  } else if (opened.acquiring && owedContext({ ...opened.state, deliverable }).includes('referenced-artifact')) {
    const item = getWorkItem(session.context.getLedger(), opened.state.workItemId);
    const check = contextCheck(['referenced-artifact'], item);
    if (item && 'freshPaths' in check) {
      // This handoff is the accepted context handoff that closes a directory reference.
      facts.unmet = await unmetArtifactPaths(ctx.cwd, { ...item, openContext: [] }, check.freshPaths);
      if (facts.unmet.length > 0) return facts;
    }
  }
  const declared = parseDeclaredFacts(params.facts);
  const change = measureChange(exec, ctx.cwd, {
    ...(declared?.modify || declared?.create ? { targets: { modify: declared.modify ?? [], create: declared.create ?? [] } } : {}),
    ...(declared?.precedent ? { precedent: declared.precedent } : {}),
    ...(tools ? { tools } : {}),
    scoutFiles: opened.state.readPaths?.length ?? 0,
    scoutRequests: opened.state.contextRequests ?? 0,
  }, signal);
  if (deliverable === 'plan' || deliverable === 'review') {
    const paths = evidencePaths(declaredFiles(params, ctx.cwd), opened.state.readPaths);
    facts.evidence = await measureEvidence(exec, ctx.cwd, paths, signal);
  }
  facts.change = await change;
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
          const tools = typeof pi.getActiveTools === 'function' ? pi.getActiveTools() : undefined;
          const facts = await prepareHandoffFacts(params, ctx, session, exec, signal, tools);
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

