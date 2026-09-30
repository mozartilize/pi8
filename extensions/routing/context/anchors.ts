/**
 * Exact anchors in a user prompt: file paths, issue ids, and strings already
 * recorded as anchors in the ledger.
 *
 * Deterministic and cheap: no embeddings, no file access. A spurious anchor
 * is harmless — it only makes a prompt miss the fast path and reach a model
 * that reads the prompt — while a missed anchor can only lose the fast path
 * for a prompt that names its work, so extraction errs toward precision.
 */
import { isAbsolute, posix, relative, sep } from 'node:path';
import { resolveToolPath } from '../policy/execution-contract.js';
import { CONTEXT_LIMITS } from './ledger.js';
import type { AnchorKind, WorkItemAnchor } from './types.js';

export interface PromptAnchor {
  kind: AnchorKind;
  value: string;
  /** How the prompt named it: `@path`, a backtick span, plain text, or a string the ledger knows. */
  mention: 'at' | 'backtick' | 'bare' | 'known';
}

/** A prompt is scanned only this far: pasted logs repeat paths without naming work. */
const MAX_SCANNED_CHARS = 20_000;
const MAX_PROMPT_ANCHORS = CONTEXT_LIMITS.anchors;

const FILE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'md', 'mdx', 'json', 'jsonl', 'yaml', 'yml', 'toml',
  'txt', 'java', 'kt', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'rb', 'php', 'swift', 'sh', 'sql', 'html', 'css',
  'scss', 'vue', 'svelte', 'lock', 'cfg', 'ini', 'xml', 'proto', 'gradle', 'rst', 'adoc', 'csv',
]);

const TRAILING = /[.,;:!?)\]}>'"]+$/u;
const LEADING = /^[(\[{<'"]+/u;
const LINE_SUFFIX = /:\d+(?::\d+)?$/u;
const PATH_CHARS = /^[\w.@+~/-]+$/u;

function stripDecoration(raw: string): string {
  return raw.replace(LEADING, '').replace(TRAILING, '').replace(LINE_SUFFIX, '');
}

/**
 * A path relative to the working directory, with `/` separators; undefined
 * for anything outside it. Without a working directory the path is
 * normalized lexically and must already be relative.
 */
export function normalizeAnchorPath(raw: string, cwd?: string): string | undefined {
  const cleaned = stripDecoration(raw.trim().replace(/^@/u, ''));
  if (!cleaned || cleaned.includes('://')) return undefined;
  let rel: string;
  if (cwd) {
    rel = relative(cwd, resolveToolPath(cwd, cleaned)).split(sep).join('/');
    if (rel === '' || isAbsolute(rel)) return undefined;
  } else {
    if (cleaned.startsWith('/') || cleaned.startsWith('~')) return undefined;
    rel = posix.normalize(cleaned);
  }
  rel = rel.replace(/^\.\//u, '').replace(/\/+$/u, '');
  if (rel === '' || rel === '.' || rel === '..' || rel.startsWith('../')) return undefined;
  return rel.length <= CONTEXT_LIMITS.anchorValue ? rel : undefined;
}

const hasExtension = (segment: string) => {
  const dot = segment.lastIndexOf('.');
  return dot > 0 && FILE_EXTENSIONS.has(segment.slice(dot + 1).toLowerCase());
};

/**
 * Whether plain text reads as a path: a file name with a known extension,
 * or a slash path that ends in one, starts relative, or has two or more
 * separators. `and/or` and `TCP/IP` do not qualify.
 */
function looksLikePath(token: string): boolean {
  if (!PATH_CHARS.test(token) || token.includes('://') || /^www\./iu.test(token)) return false;
  const segments = token.split('/').filter(Boolean);
  const last = segments.at(-1) ?? '';
  if (!token.includes('/')) return hasExtension(token) && /\p{L}/u.test(token.slice(0, token.lastIndexOf('.')));
  if (hasExtension(last)) return true;
  if (/^(?:\.{1,2}\/|~\/)/u.test(token)) return true;
  return segments.length >= 3;
}

const ISSUE_REPO = /(?<![\w/.-])([\w.-]+\/[\w.-]+)#(\d{1,7})(?!\w)/gu;
const ISSUE_HASH = /(?<![\w/#&])#(\d{1,7})(?!\w)/gu;
const ISSUE_KEY = /(?<![\w-])([A-Z][A-Z0-9]{1,9}-\d{1,6})(?![\w-])/gu;
const BACKTICK = /`([^`\s]{1,512})`/gu;
const AT_MENTION = /(?:^|\s)@([^\s`<>|]+)/gu;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/**
 * Anchors named in a prompt, in order of first appearance, deduplicated by
 * kind and value. `known` anchors (symbols, requirement ids, and the like
 * already on a work item) match only as whole words.
 */
export function extractPromptAnchors(
  prompt: string,
  opts: { cwd?: string; known?: readonly Pick<WorkItemAnchor, 'kind' | 'value'>[] } = {},
): PromptAnchor[] {
  const text = prompt.slice(0, MAX_SCANNED_CHARS);
  const found: Array<PromptAnchor & { at: number }> = [];
  const add = (anchor: PromptAnchor, at: number) => {
    if (!found.some((a) => a.kind === anchor.kind && a.value === anchor.value)) found.push({ ...anchor, at });
  };
  const addPath = (raw: string, at: number, mention: PromptAnchor['mention']) => {
    const value = normalizeAnchorPath(raw, opts.cwd);
    if (value) add({ kind: 'path', value, mention }, at);
  };

  const issueSpans: Array<[number, number]> = [];
  for (const match of text.matchAll(ISSUE_REPO)) {
    add({ kind: 'issue', value: `${match[1]}#${match[2]}`, mention: 'bare' }, match.index);
    issueSpans.push([match.index, match.index + match[0].length]);
  }
  for (const match of text.matchAll(ISSUE_HASH)) {
    if (issueSpans.some(([start, end]) => match.index >= start && match.index < end)) continue;
    add({ kind: 'issue', value: `#${match[1]}`, mention: 'bare' }, match.index);
  }
  for (const match of text.matchAll(ISSUE_KEY)) add({ kind: 'issue', value: match[1]!, mention: 'bare' }, match.index);

  for (const match of text.matchAll(AT_MENTION)) addPath(match[1]!, match.index, 'at');
  for (const match of text.matchAll(BACKTICK)) {
    const span = stripDecoration(match[1]!);
    if (span.includes('/') || hasExtension(span)) addPath(span, match.index, 'backtick');
  }
  const withoutCode = text.replace(BACKTICK, (span) => ' '.repeat(span.length));
  for (const match of withoutCode.matchAll(/\S+/gu)) {
    const token = stripDecoration(match[0]);
    if (token.startsWith('@') || issueSpans.some(([start, end]) => match.index >= start && match.index < end)) continue;
    if (looksLikePath(token)) addPath(token, match.index, 'bare');
  }

  for (const anchor of opts.known ?? []) {
    if (anchor.kind === 'path' || anchor.kind === 'issue' || anchor.value.length < 3) continue;
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(anchor.value)}(?![\\p{L}\\p{N}_])`, 'u');
    const match = pattern.exec(text);
    if (match) add({ kind: anchor.kind, value: anchor.value, mention: 'known' }, match.index);
  }

  return found
    .sort((a, b) => a.at - b.at)
    .slice(0, MAX_PROMPT_ANCHORS)
    .map(({ at: _at, ...anchor }) => anchor);
}

/** Whether a work item carries an anchor, by kind and value. */
export function hasAnchor(item: { anchors: readonly WorkItemAnchor[] }, anchor: Pick<WorkItemAnchor, 'kind' | 'value'>): boolean {
  return item.anchors.some((a) => a.kind === anchor.kind && a.value === anchor.value);
}
