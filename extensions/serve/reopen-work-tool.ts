/**
 * `reopen_work`: continue the one completed work item this entry already has.
 *
 * The model does not choose an id. The item is the completed incumbent's, or
 * the item this entry just completed. Another item goes through
 * `hand_off_context`. Acceptance is one phase boundary: the reopen transition
 * is one branch record, then the router may pick the next model once.
 *
 * Registered once and always active: a changed tool list rebuilds the prompt
 * head and loses the prompt cache on most providers. It declines without
 * state changes whenever reopening does not apply.
 */
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import { AUTO_MODEL_ID, ROUTER_PROVIDER_ID, type ComplexityBand, type TaskScope } from '../types.js';
import { servedKey } from '../host/ui.js';
import { debugLog } from '../host/debuglog.js';
import { appendWorkLifecycleSignal } from '../host/decisionlog.js';
import { oversizedArtifactCount, unmetArtifactPaths } from '../routing/context/grounding.js';
import { readBranch } from '../routing/context/persistence.js';
import { contextCheck, promptAnchorsForItem, referencedArtifactPaths, reopenEvents } from '../routing/context/resolve.js';
import type { EntryResolution, GroundedArtifact, WorkItem } from '../routing/context/types.js';
import { CONVERSATION_EVIDENCE, acceptContextHandoff } from '../routing/policy/context-acquisition.js';
import { declaredRequirement } from '../routing/policy/execution-difficulty.js';
import { REOPEN_WORK_TOOL, completedIncumbent } from '../routing/policy/work-completion.js';
import { handoffMinimum, withContinuedPenalties, withStrongerTerminal, type WorkPhaseState } from '../routing/policy/work-phase.js';
import { evaluationPolicyVersion } from '../routing/policy/policy-version.js';
import type { PendingIdentity } from './context-resolution.js';
import { CONTRACT_REMINDER, closeContractEntry } from './execution-contract-tool.js';
import type { RouterSession } from './router-session-state.js';
import { ROUTER_TOOLS_CONDITION } from './router-tools-note.js';
import { difficultyParameter, remainingWorkParameter } from './rubric-schema.js';

const DESCRIPTION = [
  ROUTER_TOOLS_CONDITION,
  'Call this tool to continue the completed work item you already own.',
  'The router knows that work item. Do not give an id, a title, or a topic.',
  'Call hand_off_context instead when the request is different work.',
  'Give the task type, the complexity, and the scope of this request.',
  'For a plan or a review, also give difficulty.',
  'For an implementation, rate only the remaining work that your evidence supports.',
  'Each rating is 1 (easiest) to 5 (hardest).',
  'Read every file this request refers to, as the file is now, before you call this tool.',
  'After this tool accepts, make no changes until the next step starts.',
].join('\n');

const DELIVERABLES = ['gather', 'plan', 'implement', 'review'] as const;
type ReopenDeliverable = (typeof DELIVERABLES)[number];
const COMPLEXITIES: readonly ComplexityBand[] = ['trivial', 'routine', 'moderate', 'hard', 'frontier'];
const SCOPES: readonly TaskScope[] = ['bounded', 'open-ended'];

function reopenWorkParameters() {
  const oneOf = (values: readonly string[], description: string) =>
    Type.Union(values.map((value) => Type.Literal(value)), { description });
  return Type.Object({
    deliverable: oneOf(DELIVERABLES, 'The task type of this request: gather, plan, implement, or review.'),
    complexity: oneOf(COMPLEXITIES, 'How hard this request is.'),
    scope: oneOf(SCOPES, 'bounded: the change is local. open-ended: the size is not known yet.'),
    difficulty: Type.Optional(difficultyParameter('For a plan or a review: the reasoning left, rated per criterion.')),
    remainingWork: Type.Optional(remainingWorkParameter('For an implementation: the work left, rated per criterion.')),
  });
}

const REJECTIONS = {
  'not-router-auto': `${REOPEN_WORK_TOOL} has no effect: the session model is not router/auto.`,
  'no-task': 'Work not reopened: no routed request is in progress. Continue.',
  'missing-deliverable': 'Work not reopened: name the task type (gather, plan, implement, or review). Call it again with it.',
  'missing-task-shape': 'Work not reopened: give complexity and scope. Call it again with both.',
  'no-completed-work': 'Work not reopened: this request has no completed work item to continue. Call hand_off_context to choose work.',
  'missing': 'Work not reopened: the completed work item is not on this branch.',
  'superseded': 'Work not reopened: superseded work stays closed. Call hand_off_context for different work.',
  'active-work': 'Work not reopened: a work item is already active. Continue with it, or call hand_off_context for different work.',
  'incumbent-mismatch': 'Work not reopened: the completed work item is not the one this model owns. Call hand_off_context for other work.',
  'stale-entry': 'Work not reopened: this request is no longer the active entry.',
  'already-handed-off': 'Work not reopened: this request already has a next step. Continue with it.',
  'collecting-context': 'Work not reopened: this request is still collecting context. Call hand_off_context.',
  'artifact-not-read': 'Work not reopened: the request rests on files not read in full as they are now. Read every line ' +
    'of each file. Reads in parts count when together they show every line. Then call it again:',
  'not-recorded': 'Work not reopened: the router could not record it. Call it again.',
  internal: 'Work not reopened: internal router error. Continue, and reply to the user.',
} as const;

type RejectCode = keyof typeof REJECTIONS;

export interface ReopenWorkParams {
  deliverable?: unknown;
  complexity?: unknown;
  scope?: unknown;
  difficulty?: unknown;
  remainingWork?: unknown;
}

export interface ReopenWorkSubmission {
  accepted: boolean;
  text: string;
  workItemId?: string;
}

/** Files the caller measured. The decision itself stays synchronous. */
export interface ReopenFacts {
  stale?: boolean;
  unmet?: string[];
  groundings?: GroundedArtifact[];
  /** Referenced files that owe no read because they are above the grounding size limit. */
  oversized?: number;
}

const member = <T extends string>(values: readonly T[], value: unknown): T | undefined =>
  values.includes(value as T) ? value as T : undefined;

type Target = { item: WorkItem } | { code: RejectCode };

/**
 * The one item this tool can reopen. An active item, including one this
 * entry already reopened, is not it. After completion, it must be the completed
 * incumbent's item. Work this entry itself completed is that item.
 */
function reopenTarget(session: RouterSession, state: WorkPhaseState): Target {
  const ledger = session.context.getLedger();
  if (ledger.activeWorkItemId) return { code: 'active-work' };
  const completedHere = state.completion;
  if (completedHere?.status === 'superseded') return { code: 'superseded' };
  if (completedHere?.status === 'done') {
    const item = ledger.items.get(completedHere.workItemId);
    if (!item) return { code: 'missing' };
    if (item.status === 'superseded') return { code: 'superseded' };
    if (item.status !== 'done') return { code: 'active-work' };
    return { item };
  }
  const looked = state.priorCompletion?.workItemId;
  if (!looked) return { code: 'no-completed-work' };
  const held = completedIncumbent(ledger);
  if (held?.workItem.id === looked) return { item: held.workItem };
  const item = ledger.items.get(looked);
  if (!item) return { code: 'missing' };
  if (item.status === 'superseded') return { code: 'superseded' };
  if (item.status !== 'done') return { code: 'active-work' };
  return { code: 'incumbent-mismatch' };
}

function entryIsCurrent(session: RouterSession, pending: PendingIdentity, sessionManager: ExtensionContext['sessionManager'] | undefined): boolean {
  if (session.getSessionGeneration() !== pending.generation) return false;
  const branch = sessionManager ? readBranch(sessionManager) : undefined;
  if (!branch?.length) return true;
  return branch.some((entry) => entry && typeof entry === 'object'
    && (entry as { id?: unknown }).id === pending.base.sourceEntryId
    && (entry as { type?: unknown }).type === 'message'
    && (entry as { message?: { role?: unknown } }).message?.role === 'user');
}

/**
 * Ground the union of the item's files and the current prompt's files.
 * A served entry can still carry that prompt identity: the incumbent served
 * it without a handoff. Same checks as `hand_off_context`.
 */
export async function prepareReopenFacts(
  ctx: Pick<ExtensionContext, 'cwd'> & Partial<Pick<ExtensionContext, 'sessionManager'>>,
  session: RouterSession,
): Promise<ReopenFacts> {
  const state = session.getWorkPhaseState();
  if (!state) return {};
  const target = reopenTarget(session, state);
  if (!('item' in target)) return {};
  const pending = state.pendingIdentity;
  if (pending && !entryIsCurrent(session, pending, ctx.sessionManager)) return { stale: true };
  let required: string[] = [];
  if (pending) {
    required = referencedArtifactPaths({ anchors: [...target.item.anchors, ...promptAnchorsForItem(pending.base.anchors)] });
  } else if (state.contextSatisfied === false && state.contextReasons?.includes('referenced-artifact')) {
    const check = contextCheck(['referenced-artifact'], target.item);
    if ('freshPaths' in check) required = [...check.freshPaths];
  }
  if (required.length === 0) return {};
  const fresh = (state.provisionalGrounding ?? []).filter((artifact) => required.includes(artifact.anchorValue));
  const grounding = [...fresh, ...target.item.grounding.filter((artifact) => !fresh.some((read) => read.anchorValue === artifact.anchorValue))];
  return {
    groundings: fresh,
    unmet: await unmetArtifactPaths(ctx.cwd, { grounding, openContext: [] }, required),
    oversized: await oversizedArtifactCount(ctx.cwd, required),
  };
}

function reject(state: WorkPhaseState | undefined, served: string | undefined, code: RejectCode, detail = ''): ReopenWorkSubmission {
  if (state && served) {
    appendWorkLifecycleSignal({ intentKey: state.intentKey, served, action: 'reopen-reject', rejectReason: code });
  }
  return { accepted: false, text: REJECTIONS[code] + detail };
}

function acceptedText(deliverable: ReopenDeliverable, minimum: number | undefined): string {
  if ((deliverable === 'plan' || deliverable === 'review') && minimum != null) {
    const role = deliverable === 'plan' ? 'planning' : 'review';
    return `Work item reopened (${deliverable}, minimum ${minimum.toFixed(2)}). A ${role} model continues from the next step. Make no changes now.`;
  }
  return `Work item reopened (${deliverable}). The next step continues this work. Make no changes now.` +
    (deliverable === 'implement' ? `\nFor the next implementation step:\n${CONTRACT_REMINDER}` : '');
}

/**
 * `acceptContextHandoff` leaves a served entry unchanged. This entry's
 * previous boundary is already served; the reopen is a new one, so that
 * status has to be gone before the pending boundary is recorded.
 */
function openForRepick(state: WorkPhaseState): WorkPhaseState {
  const open: WorkPhaseState = { ...state };
  delete open.contextStatus;
  delete open.reasoningHandoff;
  delete open.handoffKey;
  delete open.priorCompletion;
  delete open.completion;
  delete open.pendingIdentity;
  delete open.provisionalGrounding;
  return open;
}

function handoffKey(params: ReopenWorkParams | undefined): string {
  return JSON.stringify([params?.deliverable, params?.complexity, params?.scope, params?.difficulty ?? null, params?.remainingWork ?? null]);
}

/**
 * Validate and record one reopen. The caller is the model that served the
 * invocation that called the tool. The item becomes active, with its
 * `work-reopen` boundary, in one branch record before any runtime state changes.
 */
export function submitReopenWork(
  params: ReopenWorkParams | undefined,
  ctx: Pick<ExtensionContext, 'model'> | undefined,
  session: RouterSession,
  facts: ReopenFacts = {},
): ReopenWorkSubmission {
  if (ctx?.model?.provider !== ROUTER_PROVIDER_ID || ctx.model.id !== AUTO_MODEL_ID) return reject(undefined, undefined, 'not-router-auto');
  const state = session.getWorkPhaseState();
  const last = session.getLastDecision();
  const lastServed = session.getLastServed();
  const served = lastServed ? servedKey(lastServed) : undefined;
  if (!state || !last || !served || !lastServed || last.intentKey !== state.intentKey) return reject(undefined, undefined, 'no-task');
  const status = state.contextStatus;
  if (status === 'acquiring' || status === 'clarification-only') return reject(state, served, 'collecting-context');
  if (status === 'ready-pending') return reject(state, served, 'already-handed-off');
  const deliverable = member(DELIVERABLES, params?.deliverable);
  if (!deliverable) return reject(state, served, 'missing-deliverable');
  const complexity = member(COMPLEXITIES, params?.complexity);
  const scope = member(SCOPES, params?.scope);
  if (!complexity || !scope) return reject(state, served, 'missing-task-shape');
  const target = reopenTarget(session, state);
  if (!('item' in target)) return reject(state, served, target.code);
  if (facts.stale || (state.pendingIdentity && session.getSessionGeneration() !== state.pendingIdentity.generation)) {
    return reject(state, served, 'stale-entry');
  }
  if (facts.unmet && facts.unmet.length > 0) {
    return reject(state, served, 'artifact-not-read', ` ${facts.unmet.join(', ')}.`);
  }

  const item = target.item;
  const sourceEntryId = session.context.getEntrySource() ?? state.intentKey;
  const recorded = session.context.appendCommit([
    ...reopenEvents(item, sourceEntryId, { lastDeliverable: deliverable }),
    ...(facts.groundings ?? []).map((artifact) => ({
      v: 1 as const, op: 'grounding-upsert' as const, workItemId: item.id, artifact, sourceEntryId,
    })),
  ]);
  if (!recorded) return reject(state, served, 'not-recorded');

  const continued = withContinuedPenalties(
    withStrongerTerminal(state, { kind: deliverable, complexity, scope }, evaluationPolicyVersion()),
    item.id,
    'reopen',
  );
  const closed = closeContractEntry(continued, served);
  let minimum: number | undefined;
  let reasoning;
  if (deliverable === 'plan' || deliverable === 'review' || deliverable === 'implement') {
    // Without a rubric the default minimums of the task type apply. The final step only raises them.
    const { rubric, requirement } = declaredRequirement(deliverable, params, CONVERSATION_EVIDENCE);
    minimum = handoffMinimum(continued, deliverable, requirement, evaluationPolicyVersion());
    reasoning = { requester: served, target: deliverable, minimum, requirement, rubric, evidence: CONVERSATION_EVIDENCE };
  }
  const resolution: EntryResolution = {
    sourceEntryId,
    topicId: item.topic.id,
    workItemId: item.id,
    relation: 'reopen',
    deliverable,
    contextReasons: state.contextReasons ?? [],
    resolver: 'context-handoff',
  };
  const next = acceptContextHandoff(openForRepick(closed), {
    deliverable, key: handoffKey(params), ...(reasoning ? { reasoning } : {}),
  });
  session.commitWorkPhaseState({
    ...next,
    contextResolution: resolution,
    workItemId: item.id,
    contextReasons: resolution.contextReasons,
    contextSatisfied: true,
  });
  const owner = session.context.getIncumbent() ?? lastServed;
  session.context.recordIncumbent(
    { registryId: owner.registryId, ...(owner.thinkingLevel ? { thinkingLevel: owner.thinkingLevel } : {}) },
    deliverable,
    sourceEntryId,
    item.id,
  );
  const cached = session.getCachedIntent();
  if (cached?.key === state.intentKey) {
    session.setCachedIntent({
      ...cached,
      dimension: deliverable,
      context: {
        createdTopic: false,
        createdWorkItem: false,
        ...cached.context,
        workItemId: item.id,
        contextSatisfied: true,
        resolution,
      },
    });
  }
  appendWorkLifecycleSignal({
    intentKey: state.intentKey, served, action: 'reopen-accept', workItemId: item.id, deliverable,
    ...(facts.oversized ? { oversizedArtifacts: facts.oversized } : {}),
  });
  return { accepted: true, text: acceptedText(deliverable, minimum), workItemId: item.id };
}

export function registerReopenWorkTool(pi: ExtensionAPI, session: RouterSession): void {
  try {
    pi.registerTool({
      name: REOPEN_WORK_TOOL,
      label: 'Reopen Work',
      description: DESCRIPTION,
      promptSnippet: 'Continue the completed work item this model already owns.',
      parameters: reopenWorkParameters(),
      // Later calls in the same batch see the reopened item.
      executionMode: 'sequential',
      execute: async (_id, params, _signal, _onUpdate, ctx) => {
        let result: ReopenWorkSubmission;
        try {
          const facts = await prepareReopenFacts(ctx, session);
          result = submitReopenWork(params as ReopenWorkParams, ctx, session, facts);
        } catch {
          result = { accepted: false, text: REJECTIONS.internal };
        }
        debugLog('reopen-work.submit', { accepted: result.accepted });
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
