/**
 * Deterministic action/observation fingerprints. Equivalence is the detector
 * input; raw tool payloads never leave this module.
 */
import { createHash } from 'node:crypto';
import { diffLines } from 'diff';

export type ToolFamily = 'read' | 'search' | 'shell' | 'mutation' | 'other';
export type CommandClass = 'test' | 'typecheck' | 'lint' | 'build' | 'inspect' | 'other';

export interface ActionFingerprint {
  family: ToolFamily;
  key: string;
  commandClass?: CommandClass;
  path?: string;
  /**
   * True when a mutation fingerprint includes patch or content identity, not
   * just tool name + path. Unverified mutations must not count as AOR evidence.
   */
  mutationVerified?: boolean;
  /** False for unknown tools or arguments omitted from the action identity. */
  equivalenceVerified?: boolean;
}

export interface ToolCycleInput {
  toolName: string;
  toolCallId: string;
  input?: unknown;
  content?: unknown;
  details?: unknown;
  isError?: boolean;
}

export interface ObservedCycle {
  invocation: number;
  action: ActionFingerprint;
  observationKey: string;
  /** False when the complete observation cannot be compared within bounds. */
  observationVerified: boolean;
  progressHint: {
    isError: boolean;
    failureSignature?: string;
    isNewEvidence: boolean;
    mutationPath?: string;
    /** Full file body after a write, or a read snapshot. */
    fileBody?: string;
    mutationOldText?: string;
    mutationNewText?: string;
  };
  evidenceId: string;
}

export function fingerprint(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16);
}

export function normalizeText(raw: string): string {
  return raw
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, '')
    .replace(/\b\d+(?:\.\d+)?(?:ms|s|sec|seconds)\b/gi, '')
    .replace(/\bpid[= ]?\d+\b/gi, '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '')
    .replace(/\/tmp\/[A-Za-z0-9._-]+/g, '/tmp/*')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (part && typeof part === 'object' && 'text' in part) {
        const text = (part as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      }
      return '';
    })
    .join('\n');
}

export function classifyShell(command: string): CommandClass {
  const c = command.toLowerCase();
  if (/\b(pytest|vitest|npm test|npm run test|npx vitest|cargo test|go test|jest)\b/.test(c)) {
    return 'test';
  }
  if (/\b(tsc|npm run tsc|npx tsc|mypy|pyright)\b/.test(c)) return 'typecheck';
  if (/\b(eslint|lint|ruff|clippy)\b/.test(c)) return 'lint';
  if (/\b(npm run build|cargo build|compile)\b/.test(c)) return 'build';
  if (/\b(ls|cat|head|tail|git (?:status|diff|log)|rg |grep )\b/.test(c)) return 'inspect';
  return 'other';
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function mutationIdentity(
  name: string,
  args: Record<string, unknown>,
): { hash: string; kind: 'patch' | 'content' | 'unverified' } {
  if (name === 'write') {
    const content = typeof args.content === 'string' ? args.content : '';
    if (!content) return { hash: '', kind: 'unverified' };
    return { hash: fingerprint(['write-body', content]), kind: 'content' };
  }
  const parts: string[] = [];
  if (Array.isArray(args.edits)) {
    for (const edit of args.edits) {
      if (!edit || typeof edit !== 'object') continue;
      const rec = edit as Record<string, unknown>;
      if (typeof rec.oldText === 'string' && typeof rec.newText === 'string') {
        parts.push(`${rec.oldText}\0${rec.newText}`);
      }
    }
  }
  if (typeof args.oldText === 'string' && typeof args.newText === 'string') {
    parts.push(`${args.oldText}\0${args.newText}`);
  }
  if (parts.length === 0) return { hash: '', kind: 'unverified' };
  return { hash: fingerprint(['edit-body', ...parts]), kind: 'patch' };
}

export function actionFromTool(toolName: string, input: unknown): ActionFingerprint {
  const name = toolName.toLowerCase();
  const args = asRecord(input);
  if (name === 'read') {
    const filePath = String(args.path ?? '');
    const range = `${args.offset ?? ''}:${args.limit ?? ''}`;
    return {
      family: 'read', path: filePath, key: fingerprint(['read', filePath, range]),
      equivalenceVerified: Object.keys(args).every((key) => ['path', 'offset', 'limit'].includes(key)),
    };
  }
  if (name === 'grep' || name === 'find') {
    const query = String(args.pattern ?? args.query ?? '');
    const scope = String(args.path ?? '');
    return {
      family: 'search', key: fingerprint(['search', name, query, scope]),
      equivalenceVerified: Object.keys(args).every((key) => ['pattern', 'query', 'path'].includes(key)),
    };
  }
  if (name === 'edit' || name === 'write') {
    const filePath = String(args.path ?? '');
    const identity = mutationIdentity(name, args);
    return {
      family: 'mutation',
      path: filePath,
      mutationVerified: identity.kind !== 'unverified',
      key: fingerprint(['mutation', name, filePath, identity.hash]),
    };
  }
  if (name === 'bash') {
    const command = String(args.command ?? '');
    const commandClass = classifyShell(command);
    return {
      family: 'shell',
      commandClass,
      key: fingerprint(['shell', command]),
      equivalenceVerified: Object.keys(args).every((key) => ['command', 'timeout'].includes(key)),
    };
  }
  return { family: 'other', key: fingerprint(['other', name]), equivalenceVerified: false };
}

export function extractFailureSignature(
  text: string,
  commandClass: CommandClass,
): string | undefined {
  const normalized = normalizeText(text);
  if (!normalized) return undefined;
  const pytest = normalized.match(/([a-z0-9_./-]+\.py(?:::[a-z0-9_]+)+)/);
  if (pytest) return fingerprint(['fail', commandClass, pytest[1]]);
  const fileFail = normalized.match(
    /(?:fail(?:ed)?|error)\s+([a-z0-9_./-]+\.(?:ts|js|tsx|py|rs|go))/,
  );
  if (fileFail) return fingerprint(['fail', commandClass, fileFail[1]]);
  const named = normalized.match(
    /\b((?:assertionerror|typeerror|error|fail):.{0,80})/,
  );
  if (named) return fingerprint(['fail', commandClass, named[1].slice(0, 80)]);
  return fingerprint(['fail', commandClass, normalized.slice(0, 120)]);
}

/** Combined UTF-16 character count above which comparison is refused before scanning. */
export const MAX_DIFF_CHARS = 2_000_000;
/** Combined line count above which an exact distance is refused outright. */
export const MAX_DIFF_LINES = 50_000;
/** Largest edit script the router will pay for before giving up. */
export const MAX_DIFF_EDIT_LENGTH = 2_000;
/** Wall-clock ceiling per comparison; observations share this deadline. */
export const MAX_DIFF_MS = 100;

export type LineDistanceResult =
  | { available: true; added: number; deleted: number }
  | { available: false; reason: 'too-large' | 'budget-exhausted' };

/**
 * Line-level added+deleted displacement between two snapshots, or an explicit
 * unavailable result.
 *
 * This runs synchronously inside trajectory observation, so character and line
 * ceilings reject oversized inputs before diffing; jsdiff returns `undefined`
 * once the edit script passes `maxEditLength` or the deadline expires. An
 * exhausted budget must surface as unavailable — never as an approximation,
 * which could manufacture backtracking evidence out of declined work.
 * A caller may pass an absolute deadline to share the budget across comparisons.
 */
export function lineDistance(
  from: string,
  to: string,
  deadline = Date.now() + MAX_DIFF_MS,
): LineDistanceResult {
  if (Date.now() >= deadline) return { available: false, reason: 'budget-exhausted' };
  if (from.length + to.length > MAX_DIFF_CHARS) {
    return { available: false, reason: 'too-large' };
  }
  if (from === to) return { available: true, added: 0, deleted: 0 };
  const fromLines = countLines(from, deadline);
  const toLines = countLines(to, deadline);
  if (fromLines === undefined || toLines === undefined) {
    return { available: false, reason: 'budget-exhausted' };
  }
  if (fromLines + toLines > MAX_DIFF_LINES) {
    return { available: false, reason: 'too-large' };
  }
  const remaining = Math.min(MAX_DIFF_MS, deadline - Date.now());
  if (remaining <= 0) return { available: false, reason: 'budget-exhausted' };
  const changes = diffLines(from, to, {
    // A file that gained a trailing newline did not rewrite its last line.
    ignoreNewlineAtEof: true,
    maxEditLength: MAX_DIFF_EDIT_LENGTH,
    timeout: remaining,
  });
  if (!changes) return { available: false, reason: 'budget-exhausted' };
  let added = 0;
  let deleted = 0;
  for (const change of changes) {
    if (change.added) added += change.count ?? 0;
    else if (change.removed) deleted += change.count ?? 0;
  }
  return { available: true, added, deleted };
}

function countLines(text: string, deadline: number): number | undefined {
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (i % 4096 === 0 && Date.now() >= deadline) return undefined;
    if (text.charCodeAt(i) === 10) lines += 1;
    if (lines > MAX_DIFF_LINES) return lines;
  }
  return lines;
}

export function applyReplacement(content: string, oldText: string, newText: string): string | undefined {
  const at = content.indexOf(oldText);
  if (at < 0) return undefined;
  return content.slice(0, at) + newText + content.slice(at + oldText.length);
}

/** Match identities hashed into one search observation. */
const MAX_MATCH_IDENTITIES = 64;
const MAX_OBSERVATION_CHARS = 1_000_000;

function matchIdentity(match: Record<string, unknown>): string {
  const path = String(match.path ?? '');
  if (!path) return '';
  const line = String(match.line ?? match.startLine ?? '');
  const column = String(match.column ?? match.startColumn ?? '');
  const text = String(match.text ?? match.snippet ?? '');
  return fingerprint([path, line, column, text]);
}

function observationKey(action: ActionFingerprint, event: ToolCycleInput): { key: string; verified: boolean } {
  const content = event.content;
  if (typeof content === 'string' && content.length > MAX_OBSERVATION_CHARS) {
    return { key: '', verified: false };
  }
  if (Array.isArray(content)) {
    if (content.length > 256) return { key: '', verified: false };
    let size = 0;
    for (const part of content) {
      if (!part || typeof part !== 'object' || part.type !== 'text' || typeof part.text !== 'string') {
        return { key: '', verified: false };
      }
      size += part.text.length + 1;
      if (size > MAX_OBSERVATION_CHARS) return { key: '', verified: false };
    }
  }
  const details = asRecord(event.details);
  if (action.family === 'search' && Array.isArray(details.matches)) {
    // Paths alone make "same files, moved/changed hits" look like a repeated
    // observation, which is exactly what an agent chasing a moving target
    // through a file produces. Location and matched text carry the difference.
    if (details.matches.length > MAX_MATCH_IDENTITIES) return { key: '', verified: false };
    let size = 0;
    for (const match of details.matches) {
      if (!match || typeof match !== 'object' || typeof match.path !== 'string' || !match.path) {
        return { key: '', verified: false };
      }
      size += match.path.length + String(match.line ?? match.startLine ?? '').length
        + String(match.column ?? match.startColumn ?? '').length
        + String(match.text ?? match.snippet ?? '').length;
      if (size > MAX_OBSERVATION_CHARS) return { key: '', verified: false };
    }
    const ids = details.matches.map((match) => matchIdentity(match as Record<string, unknown>)).sort();
    const text = contentText(event.content);
    if (text.length > MAX_OBSERVATION_CHARS) return { key: '', verified: false };
    return { key: fingerprint(['obs', action.key, text, ...ids]), verified: true };
  }
  const text = contentText(event.content);
  if (text.length > MAX_OBSERVATION_CHARS) return { key: '', verified: false };
  return { key: fingerprint(['obs', action.key, text]), verified: true };
}

export function cycleFromToolResult(event: ToolCycleInput, invocation: number): ObservedCycle {
  const action = actionFromTool(event.toolName, event.input);
  const observation = observationKey(action, event);
  const text = contentText(event.content);
  const isError = event.isError === true;
  const verifier = action.family === 'shell'
    && (action.commandClass === 'test'
      || action.commandClass === 'typecheck'
      || action.commandClass === 'lint'
      || action.commandClass === 'build');
  const failureSignature = verifier && (isError || /\bfail(?:ed|ure)?\b/i.test(text))
    ? extractFailureSignature(text, action.commandClass ?? 'other')
    : undefined;
  const args = asRecord(event.input);
  const writeBody = action.family === 'mutation' && typeof args.content === 'string'
    ? args.content
    : undefined;
  const readBody = action.family === 'read' ? contentText(event.content) : undefined;
  const evidenceId = `${action.key}:${observation.key}`;
  return {
    invocation,
    action,
    observationKey: observation.key,
    observationVerified: observation.verified,
    progressHint: {
      isError,
      failureSignature,
      isNewEvidence: false,
      mutationPath: action.path,
      fileBody: writeBody ?? (readBody || undefined),
      mutationOldText: typeof args.oldText === 'string' ? args.oldText : undefined,
      mutationNewText: typeof args.newText === 'string' ? args.newText : undefined,
    },
    evidenceId,
  };
}

export function isVerifier(action: ActionFingerprint): boolean {
  return action.family === 'shell'
    && (action.commandClass === 'test'
      || action.commandClass === 'typecheck'
      || action.commandClass === 'lint'
      || action.commandClass === 'build');
}
