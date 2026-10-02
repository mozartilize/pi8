/**
 * `routing_context`: the model-facing side of the work ledger.
 *
 * Registered once and always active, like `commit_execution`: its schema and
 * description never change, whatever the ledger holds — a changed tool list
 * rebuilds the prompt head and loses the prompt cache on most providers — so
 * ids are validated here, never enumerated in the schema. It is sequential,
 * so tools after it in the same batch see its effect.
 *
 * The model may describe work (titles, summary, anchors); the router owns
 * every routing fact: which model serves, what context a request owes and
 * whether it is in hand, and which work an entry belongs to. A work item's
 * status changes only at a lifecycle boundary — hand_off_context,
 * complete_work, reopen_work — which records it. Every entry point fails
 * open, and a rejected call changes nothing.
 */
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import { AUTO_MODEL_ID, ROUTER_PROVIDER_ID } from '../types.js';
import { debugLog } from '../host/debuglog.js';
import { normalizeAnchorPath } from '../routing/context/anchors.js';
import { CONTEXT_LIMITS, activeWorkItem, getWorkItem } from '../routing/context/ledger.js';
import { RESERVED_IDS, type AnchorKind, type AnchorRole, type WorkItemAnchor, type WorkItemPatch } from '../routing/context/types.js';
import { currentSourceEntry } from './context-grounding.js';
import type { RouterSession } from './router-session-state.js';

export const ROUTING_CONTEXT_TOOL = 'routing_context';

const DESCRIPTION =
  'Keep the router\'s record of this session\'s work current. op="update": when you learn a better title, ' +
  'a short summary, or anchors (the files, symbols, or issues the work is about, with their role). ' +
  'To end the current work, call complete_work. It records metadata only: it never changes which model serves, ' +
  'and never stop other work to call it.';

const ANCHOR_KINDS: readonly AnchorKind[] = ['path', 'symbol', 'issue', 'requirement', 'other'];
const ANCHOR_ROLES: readonly AnchorRole[] = ['requirement', 'design', 'implementation', 'test', 'reference'];

/** Built at registration, not import, so importing the handlers needs no schema runtime. */
function routingContextParameters() {
  const literals = <T extends string>(values: readonly T[]) => Type.Union(values.map((value) => Type.Literal(value)));
  return Type.Object({
    op: literals(['update'] as const),
    topicId: Type.Optional(Type.String({ description: 'A topic id the router assigned; with only a title, renames that topic.' })),
    workItemId: Type.Optional(Type.String({ description: 'A work item id the router assigned. Defaults to the active work item.' })),
    title: Type.Optional(Type.String({ description: 'Short title of the work item (of the topic, when only topicId is given).' })),
    summary: Type.Optional(Type.String({ description: 'A few sentences on what the work is and where it stands.' })),
    anchors: Type.Optional(Type.Array(Type.Object({
      kind: literals(ANCHOR_KINDS),
      value: Type.String({ description: 'File path relative to the working directory, symbol, or issue id.' }),
      role: Type.Optional(literals(ANCHOR_ROLES)),
    }), { description: 'What the work is about.' })),
  });
}

export interface RoutingContextParams {
  op?: unknown;
  topicId?: unknown;
  workItemId?: unknown;
  relation?: unknown;
  deliverable?: unknown;
  /** Not in the schema: a model claiming what the request owes is refused, never read. */
  prerequisite?: unknown;
  title?: unknown;
  summary?: unknown;
  anchors?: unknown;
  /** Not in the schema: a status change is a lifecycle boundary, refused here. */
  status?: unknown;
}

export interface RoutingContextResult {
  accepted: boolean;
  text: string;
  details: Record<string, unknown>;
}

const reject = (text: string): RoutingContextResult => ({ accepted: false, text, details: { accepted: false } });

function isRouterAuto(ctx: Pick<ExtensionContext, 'model'> | undefined): boolean {
  return ctx?.model?.provider === ROUTER_PROVIDER_ID && ctx.model.id === AUTO_MODEL_ID;
}

const present = (value: unknown) => value !== undefined && value !== null;

function parseAnchors(raw: unknown, cwd: string | undefined): WorkItemAnchor[] | string {
  if (!Array.isArray(raw)) return 'anchors must be a list';
  if (raw.length > CONTEXT_LIMITS.anchors) return `at most ${CONTEXT_LIMITS.anchors} anchors`;
  const anchors: WorkItemAnchor[] = [];
  for (const entry of raw) {
    const anchor = entry as { kind?: unknown; value?: unknown; role?: unknown } | null;
    if (!anchor || !ANCHOR_KINDS.includes(anchor.kind as AnchorKind)) return 'each anchor needs a kind';
    if (typeof anchor.value !== 'string' || anchor.value.trim() === '') return 'each anchor needs a value';
    if (anchor.value.length > CONTEXT_LIMITS.anchorValue) return `anchor values are at most ${CONTEXT_LIMITS.anchorValue} characters`;
    if (present(anchor.role) && !ANCHOR_ROLES.includes(anchor.role as AnchorRole)) return `unknown anchor role ${String(anchor.role)}`;
    const value = anchor.kind === 'path' ? normalizeAnchorPath(anchor.value, cwd) : anchor.value.trim();
    if (!value) return `${anchor.value} is outside the working directory`;
    anchors.push({
      kind: anchor.kind as AnchorKind,
      value,
      ...(present(anchor.role) ? { role: anchor.role as AnchorRole } : {}),
      source: 'model',
    });
  }
  return anchors;
}

function text(value: unknown, max: number, field: string): string | undefined | { error: string } {
  if (!present(value)) return undefined;
  if (typeof value !== 'string' || value.trim() === '') return { error: `${field} must be non-empty text` };
  if (value.length > max) return { error: `${field} is at most ${max} characters` };
  return value.trim();
}

function update(params: RoutingContextParams, ctx: Pick<ExtensionContext, 'cwd' | 'sessionManager'>, session: RouterSession): RoutingContextResult {
  if (present(params.relation) || present(params.deliverable) || present(params.prerequisite)) {
    return reject('routing_context update cannot set relation, deliverable, or the context a request owes; the router resolves those for each request.');
  }
  if (present(params.status)) {
    return reject('routing_context update cannot change a status. To end the current work, call complete_work. Nothing changed.');
  }
  const ledger = session.context.getLedger();
  const topicOnly = typeof params.topicId === 'string' && !present(params.workItemId);
  const item = topicOnly
    ? [...ledger.items.values()].find((candidate) => candidate.topic.id === params.topicId)
    : present(params.workItemId)
      ? (typeof params.workItemId === 'string' && !RESERVED_IDS.has(params.workItemId) ? getWorkItem(ledger, params.workItemId) : undefined)
      : activeWorkItem(ledger);
  if (!item) return reject(`routing_context update: no such ${topicOnly ? 'topic' : 'work item'}. Nothing changed.`);

  const title = text(params.title, topicOnly ? CONTEXT_LIMITS.topicTitle : CONTEXT_LIMITS.workTitle, 'title');
  const summary = text(params.summary, CONTEXT_LIMITS.summary, 'summary');
  for (const field of [title, summary]) if (typeof field === 'object') return reject(`routing_context update: ${field.error}. Nothing changed.`);
  if (topicOnly && (present(params.summary) || present(params.anchors))) {
    return reject('routing_context update: a topic takes a title only. Nothing changed.');
  }
  const anchors = present(params.anchors) ? parseAnchors(params.anchors, ctx.cwd) : undefined;
  if (typeof anchors === 'string') return reject(`routing_context update: ${anchors}. Nothing changed.`);

  const patch: WorkItemPatch = topicOnly
    ? { ...(title ? { topicTitle: title as string } : {}) }
    : {
        ...(title ? { title: title as string } : {}),
        ...(summary ? { summary: summary as string } : {}),
        ...(anchors && anchors.length > 0 ? { anchors } : {}),
      };
  if (Object.keys(patch).length === 0) return reject('routing_context update: nothing to change.');
  const sourceEntryId = currentSourceEntry(ctx, session);
  if (!sourceEntryId) return reject('routing_context update: no request is in progress. Nothing changed.');
  if (!session.context.append({ v: 1, op: 'work-update', workItemId: item.id, patch, sourceEntryId })) {
    return reject('routing_context update: the session did not record it. Nothing changed.');
  }
  return { accepted: true, text: `Recorded (${topicOnly ? item.topic.id : item.id}).`, details: { accepted: true, workItemId: item.id } };
}

/** Validate and apply one call. */
export function submitRoutingContext(
  params: RoutingContextParams | undefined,
  ctx: Pick<ExtensionContext, 'model' | 'cwd' | 'sessionManager'> | undefined,
  session: RouterSession,
): RoutingContextResult {
  if (!ctx || !isRouterAuto(ctx)) return reject(`${ROUTING_CONTEXT_TOOL} has no effect: the session model is not router/auto.`);
  if (params?.op !== 'update') {
    return reject('routing_context: op is "update". To end the current work, call complete_work. Nothing changed.');
  }
  return update(params, ctx, session);
}

export function registerRoutingContextTool(pi: ExtensionAPI, session: RouterSession): void {
  try {
    pi.registerTool({
      name: ROUTING_CONTEXT_TOOL,
      label: 'Routing Context',
      description: DESCRIPTION,
      promptSnippet: 'Record what the current work is about.',
      parameters: routingContextParameters(),
      executionMode: 'sequential',
      execute: async (_id, params, _signal, _onUpdate, ctx) => {
        let result: RoutingContextResult;
        try {
          result = submitRoutingContext(params as RoutingContextParams, ctx, session);
        } catch {
          result = reject('routing_context: internal router error. Nothing changed; continue with the task.');
        }
        debugLog('routing-context.submit', { op: (params as RoutingContextParams)?.op, accepted: result.accepted });
        return { content: [{ type: 'text' as const, text: result.text }], details: result.details };
      },
    });
  } catch {
    // Tool registration must never crash extension init.
  }
}
