/**
 * Record grounding from tool results: results whose text, together, shows
 * every line of an anchored file, and the model's own `write` or `edit` of
 * one.
 *
 * Any tool's text counts when its lines match the file: Pi's `read` is placed
 * by its offset, and every other result by where its lines sit in the file,
 * so a third-party reader needs no support of its own and a summary of a file
 * grounds nothing. Only files that are anchors of the active work item count;
 * other reads say nothing about the work's referenced artifacts. A self-edit
 * keeps an anchor grounded — otherwise every implementation edit would make
 * the item's own files stale — but an `edit` of a file the model never read in
 * full shows it only part of the file, so it refreshes existing grounding and
 * never creates it. Every entry point fails open.
 */
import type { ExtensionContext, ToolResultEvent } from '@earendil-works/pi-coding-agent';
import { basename, isAbsolute, relative, sep } from 'node:path';
import { resolveToolPath } from '../routing/policy/execution-contract.js';
import { activeWorkItem } from '../routing/context/ledger.js';
import { hasAnchor } from '../routing/context/anchors.js';
import {
  contentLineCount,
  fingerprintFile,
  matchedLineRanges,
  readLineRange,
  resultText,
  type LineRange,
} from '../routing/context/grounding.js';
import { latestGenuineUserEntry, readBranch } from '../routing/context/persistence.js';
import type { WorkItem } from '../routing/context/types.js';
import type { RouterSession } from './router-session-state.js';

/** Working-directory-relative path with `/` separators, or undefined outside it. */
export function insideCwd(cwd: string, path: string): { abs: string; rel: string } | undefined {
  const abs = resolveToolPath(cwd, path.trim());
  const rel = relative(cwd, abs);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return { abs, rel: rel.split(sep).join('/') };
}

/** The genuine user entry the current tool loop belongs to. */
export function currentSourceEntry(
  ctx: Pick<ExtensionContext, 'sessionManager'> | undefined,
  session: RouterSession,
): string | undefined {
  return latestGenuineUserEntry(readBranch(ctx?.sessionManager))
    ?? session.getCachedIntent()?.key;
}

/** Anchored files one result is checked against: a bound on the hashing a result costs. */
const MAX_MATCHED_ANCHORS = 8;

/** Every text block of a tool result, in order. */
function allResultText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && typeof b === 'object' && (b as { type?: unknown }).type === 'text')
    .map((b) => (b as { text?: unknown }).text)
    .filter((t): t is string => typeof t === 'string')
    .join('\n');
}

export async function observeContextGrounding(
  event: Pick<ToolResultEvent, 'toolName' | 'input' | 'content' | 'details' | 'isError'>,
  ctx: Pick<ExtensionContext, 'cwd' | 'sessionManager'>,
  session: RouterSession,
): Promise<void> {
  try {
    if (event.isError || !ctx.cwd) return;
    const item = activeWorkItem(session.context.getLedger());
    if (!item) return;
    const tool = event.toolName;
    if (tool === 'read' || tool === 'write' || tool === 'edit') {
      await observeNativeFileTool(tool, event, ctx, session, item);
    } else {
      await observeFileContent(event, ctx, session, item);
    }
  } catch {
    // Grounding is evidence, never a reason to fail a tool result.
  }
}

/** Pi's own file tools name their file, so it is checked directly. */
async function observeNativeFileTool(
  tool: 'read' | 'write' | 'edit',
  event: Pick<ToolResultEvent, 'input' | 'content' | 'details'>,
  ctx: Pick<ExtensionContext, 'cwd' | 'sessionManager'>,
  session: RouterSession,
  item: WorkItem,
): Promise<void> {
  const raw = (event.input as { path?: unknown } | undefined)?.path;
  if (typeof raw !== 'string' || raw.trim() === '') return;
  const path = insideCwd(ctx.cwd, raw);
  if (!path || !hasAnchor(item, { kind: 'path', value: path.rel })) return;
  if (tool === 'edit' && !item.grounding.some((g) => g.anchorValue === path.rel)) return;
  const generation = session.getSessionGeneration();
  const file = await fingerprintFile(path.abs);
  if (!file || session.getSessionGeneration() !== generation) return;
  if (tool === 'read') {
    const range = readLineRange(event.input as { offset?: unknown }, event.details, resultText(event.content), file.text);
    if (!range || !noteRanges(session, item, path.rel, file, [range])) return;
  }
  recordGrounding(ctx, session, item, path.rel, file.sha256, tool === 'read' ? 'read' : 'self-edit');
}

/**
 * Any other result: check it against the anchored files it could be about,
 * those whose name appears in its input or text. A name is only a filter;
 * the lines themselves are the evidence.
 */
async function observeFileContent(
  event: Pick<ToolResultEvent, 'input' | 'content'>,
  ctx: Pick<ExtensionContext, 'cwd' | 'sessionManager'>,
  session: RouterSession,
  item: WorkItem,
): Promise<void> {
  const text = allResultText(event.content);
  if (text === '') return;
  const haystack = `${JSON.stringify(event.input ?? null)}\n${text}`;
  const candidates = item.anchors
    .filter((anchor) => anchor.kind === 'path' && haystack.includes(basename(anchor.value)))
    .slice(0, MAX_MATCHED_ANCHORS);
  for (const anchor of candidates) {
    const path = insideCwd(ctx.cwd, anchor.value);
    if (!path) continue;
    const generation = session.getSessionGeneration();
    const file = await fingerprintFile(path.abs);
    if (!file || session.getSessionGeneration() !== generation) return;
    const ranges = matchedLineRanges(text, file.text);
    if (ranges.length === 0 || !noteRanges(session, item, path.rel, file, ranges)) continue;
    recordGrounding(ctx, session, item, path.rel, file.sha256, 'read');
  }
}

/** Add the lines one result showed; true once every line of this version has been shown. */
function noteRanges(
  session: RouterSession,
  item: WorkItem,
  rel: string,
  file: { sha256: string; text: string },
  ranges: readonly LineRange[],
): boolean {
  const version = { sha256: file.sha256, lineCount: contentLineCount(file.text) };
  // Coverage is dropped once complete, so stop there rather than start it over.
  return ranges.some((range) => session.context.noteRead(item.id, rel, version, range));
}

function recordGrounding(
  ctx: Pick<ExtensionContext, 'sessionManager'>,
  session: RouterSession,
  item: WorkItem,
  rel: string,
  sha256: string,
  observedBy: 'read' | 'self-edit',
): void {
  const sourceEntryId = currentSourceEntry(ctx, session);
  if (!sourceEntryId) return;
  session.context.append({
    v: 1,
    op: 'grounding-upsert',
    workItemId: item.id,
    artifact: { anchorValue: rel, sha256, observedAtEntryId: sourceEntryId, observedBy },
    sourceEntryId,
  });
}
