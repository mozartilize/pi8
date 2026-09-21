/**
 * Deterministic action/observation fingerprints. Equivalence is the detector
 * input; raw tool payloads never leave this module.
 */
import { createHash } from 'node:crypto';

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
  progressHint: {
    isError: boolean;
    failureSignature?: string;
    isNewEvidence: boolean;
    mutationAdded?: number;
    mutationDeleted?: number;
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

function shellTargets(command: string): string {
  return command
    .split(/\s+/)
    .filter((token) => token.length > 1 && !token.startsWith('-'))
    .slice(0, 12)
    .join(' ');
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
    return { family: 'read', path: filePath, key: fingerprint(['read', filePath, range]) };
  }
  if (name === 'grep' || name === 'find') {
    const query = String(args.pattern ?? args.query ?? '');
    const scope = String(args.path ?? '');
    return { family: 'search', key: fingerprint(['search', name, query, scope]) };
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
      key: fingerprint(['shell', commandClass, normalizeText(shellTargets(command))]),
    };
  }
  return { family: 'other', key: fingerprint(['other', name]) };
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

export function diffLineDistance(diff: string): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) deleted += 1;
  }
  return { added, deleted };
}

/**
 * Line-level added+deleted distance between two snapshots. LCS length is the
 * retained lines; the rest is displacement from initial to current.
 */
export function lineDistance(from: string, to: string): { added: number; deleted: number } {
  if (from === to) return { added: 0, deleted: 0 };
  const a = from.split('\n');
  const b = to.split('\n');
  const n = a.length;
  const m = b.length;
  const prev = new Array<number>(m + 1).fill(0);
  const curr = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, curr[j - 1]!);
    }
    for (let j = 0; j <= m; j++) prev[j] = curr[j]!;
    curr.fill(0);
  }
  const lcs = prev[m]!;
  return { deleted: n - lcs, added: m - lcs };
}

export function applyReplacement(content: string, oldText: string, newText: string): string | undefined {
  const at = content.indexOf(oldText);
  if (at < 0) return undefined;
  return content.slice(0, at) + newText + content.slice(at + oldText.length);
}

function observationKey(action: ActionFingerprint, event: ToolCycleInput): string {
  const details = asRecord(event.details);
  if (action.family === 'search' && Array.isArray(details.matches)) {
    const ids = details.matches
      .map((match) => {
        if (match && typeof match === 'object' && 'path' in match) {
          return String((match as { path?: unknown }).path ?? '');
        }
        return '';
      })
      .filter(Boolean)
      .sort();
    return fingerprint(['obs', action.key, ids.join('|')]);
  }
  const text = contentText(event.content);
  return fingerprint(['obs', action.key, normalizeText(text).slice(0, 4000)]);
}

function mutationDistance(event: ToolCycleInput): { added?: number; deleted?: number } {
  const details = asRecord(event.details);
  const diff = typeof details.diff === 'string'
    ? details.diff
    : typeof details.patch === 'string'
      ? details.patch
      : '';
  if (!diff) return {};
  return diffLineDistance(diff);
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
  const mutation = action.family === 'mutation' ? mutationDistance(event) : {};
  const args = asRecord(event.input);
  const writeBody = action.family === 'mutation' && typeof args.content === 'string'
    ? args.content
    : undefined;
  const readBody = action.family === 'read' ? contentText(event.content) : undefined;
  const evidenceId = `${action.key}:${observation}`;
  return {
    invocation,
    action,
    observationKey: observation,
    progressHint: {
      isError,
      failureSignature,
      isNewEvidence: false,
      mutationAdded: mutation.added,
      mutationDeleted: mutation.deleted,
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
