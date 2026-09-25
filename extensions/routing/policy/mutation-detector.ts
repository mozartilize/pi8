/**
 * Pure, best-effort classifier for mutation-like tool calls.
 *
 * Pi's built-in `bash` tool is a shell string, so the router cannot know what
 * a command actually does without executing it. This classifier parses the
 * command with `unbash` and recognizes high-confidence write shapes — file
 * redirection, in-place editors, file-writer commands, filesystem mutators,
 * `dd of=`, destructive git worktree resets/discards, and inline Python write
 * APIs — so a shell write counts like `edit`/`write`.
 * Everything else is `none` (no recognized mutation shape) or `possible`
 * (opaque Python: scripts, `-m` modules, eval/subprocess/import indirection),
 * which only feeds observability and never blocks.
 *
 * Every command the shell would run is classified, including commands inside
 * substitutions, arithmetic, tests and unquoted heredoc bodies. Quoted strings,
 * comments and heredoc text are data, not commands.
 *
 * Best effort by construction: Pi runs `tool_call` hooks in load order and
 * Bash applies its own `spawnHook` later, so a command can be rewritten after
 * this classifier observes it. `bash -c` strings, wrapper commands (`env`,
 * `xargs`, `find -exec`), aliases, imported code and obfuscation can still
 * hide writes. The classifier never persists or logs command text — it emits
 * enum signals only.
 *
 * Pure and deterministic: no I/O, no registry or session access.
 */
import { parse } from 'unbash';
import type { Command, Redirect, Word } from 'unbash';

export type MutationSurface = 'native' | 'bash-shell' | 'bash-python-inline' | 'bash-python-opaque';

export type MutationConfidence = 'high' | 'possible' | 'none';

export type MutationSignal =
  | 'native-edit'
  | 'native-write'
  | 'shell-redirect'
  | 'shell-inplace'
  | 'shell-writer'
  | 'shell-filesystem'
  | 'shell-git-destructive'
  | 'shell-dd'
  | 'python-write-api'
  | 'python-opaque';

export interface MutationDetection {
  confidence: MutationConfidence;
  surface?: MutationSurface;
  signal?: MutationSignal;
}

const NATIVE_SIGNALS: Readonly<Record<string, MutationSignal>> = {
  edit: 'native-edit',
  write: 'native-write',
};

export function classifyMutationCall(toolName: string, input: Record<string, unknown>): MutationDetection {
  const native = NATIVE_SIGNALS[toolName];
  if (native) return { confidence: 'high', surface: 'native', signal: native };
  if (toolName !== 'bash') return { confidence: 'none' };
  const command = typeof input?.command === 'string' ? input.command : '';
  if (command.trim() === '') return { confidence: 'none' };
  return classifyBashCommand(command);
}

// ─── Bash classification ──────────────────────────────────────────────────

/** When several shapes appear, the first listed one is reported. */
const PRECEDENCE: readonly MutationSignal[] = [
  'python-write-api',
  'shell-redirect',
  'shell-inplace',
  'shell-writer',
  'shell-filesystem',
  'shell-git-destructive',
  'shell-dd',
  'python-opaque',
];

const SURFACES: Readonly<Record<MutationSignal, MutationSurface>> = {
  'native-edit': 'native',
  'native-write': 'native',
  'shell-redirect': 'bash-shell',
  'shell-inplace': 'bash-shell',
  'shell-writer': 'bash-shell',
  'shell-filesystem': 'bash-shell',
  'shell-git-destructive': 'bash-shell',
  'shell-dd': 'bash-shell',
  'python-write-api': 'bash-python-inline',
  'python-opaque': 'bash-python-opaque',
};

function classifyBashCommand(source: string): MutationDetection {
  const signals = new Set<MutationSignal>();
  // unbash is tolerant: malformed input yields a partial AST, not a throw.
  walk(parse(source), (node) => {
    const signal = isCommand(node) ? commandSignal(node) : isRedirect(node) && writesFile(node) ? 'shell-redirect' : undefined;
    if (signal) signals.add(signal);
  });
  const signal = PRECEDENCE.find((s) => signals.has(s));
  if (!signal) return { confidence: 'none' };
  // Opaque Python is observability-only: the static scan cannot prove a write.
  return { confidence: signal === 'python-opaque' ? 'possible' : 'high', surface: SURFACES[signal], signal };
}

/**
 * Nested shell syntax that unbash resolves lazily through getters, so it is
 * invisible to own-key traversal: word parts (substitutions), `(( ))`
 * arithmetic, and the three clauses of an arithmetic `for`.
 */
const LAZY_KEYS = ['parts', 'expression', 'initialize', 'test', 'update'] as const;

function walk(value: unknown, visit: (node: object) => void): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  visit(value);
  const own = Object.keys(value);
  for (const key of own) walk((value as Record<string, unknown>)[key], visit);
  for (const key of LAZY_KEYS) {
    if (key in value && !own.includes(key)) walk((value as Record<string, unknown>)[key], visit);
  }
}

const isCommand = (node: object): node is Command => (node as { type?: unknown }).type === 'Command';
// Redirects are the only untyped nodes that carry both fields.
const isRedirect = (node: object): node is Redirect => 'operator' in node && 'fileDescriptor' in node;

// ─── Redirects ────────────────────────────────────────────────────────────

/** `<>` opens read-write without truncating; it is not treated as a write. */
const WRITE_OPERATORS = new Set(['>', '>>', '>|', '&>', '&>>', '>&']);
const BENIGN_TARGETS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty']);

function isBenignTarget(target: string): boolean {
  return BENIGN_TARGETS.has(target) || target.startsWith('/dev/fd/');
}

function writesFile(redirect: Redirect): boolean {
  if (!WRITE_OPERATORS.has(redirect.operator)) return false;
  const target = redirect.target?.value;
  if (!target) return false;
  // `>&1` duplicates and `>&-` closes a descriptor; `>&file` writes a file.
  if (redirect.operator === '>&' && /^(?:\d+|-)$/.test(target)) return false;
  return !isBenignTarget(target);
}

// ─── Commands ─────────────────────────────────────────────────────────────

const WRITERS = new Set(['tee', 'patch', 'truncate', 'touch']);
const FILESYSTEM = new Set(['cp', 'mv', 'rm', 'install', 'mkdir', 'ln']);
/** Interpreter names; `pytest` is opaque by definition. */
const PYTHON = /^(?:python[23]?(?:\.\d+)?|pytest)$/;
const RUNNERS = new Set(['uv', 'poetry', 'pipenv']);

/** Dequoted command words after unwrapping `sudo` and `uv|poetry|pipenv run`. */
function argv(command: Command): string[] {
  const words = [command.name, ...command.suffix]
    .filter((word): word is Word => word !== undefined)
    .map((word) => word.value);
  if (words[0] === 'sudo') words.shift();
  if (RUNNERS.has(words[0] ?? '') && words[1] === 'run') words.splice(0, 2);
  return words;
}

function commandSignal(command: Command): MutationSignal | undefined {
  const [rawName, ...args] = argv(command);
  if (rawName === undefined) return undefined;
  // Case-insensitive filesystems resolve `RM` to `rm`.
  const name = rawName.toLowerCase();
  if (PYTHON.test(name)) return pythonSignal(name, args, command.redirects);
  if (WRITERS.has(name)) return 'shell-writer';
  if (FILESYSTEM.has(name)) return 'shell-filesystem';
  if (name === 'git') return gitSignal(args);
  if (name === 'dd') {
    const target = args.find((arg) => arg.startsWith('of='))?.slice(3);
    return target && !isBenignTarget(target) ? 'shell-dd' : undefined;
  }
  const inPlace =
    (name === 'sed' && args.some((arg) => /^(?:-[iI]|--in-place)/.test(arg)))
    || (name === 'perl' && args.some((arg) => /^-[a-z]*i/.test(arg)))
    || (name === 'awk' && args.some((arg, i) => arg === '-i' && args[i + 1] === 'inplace'));
  return inPlace ? 'shell-inplace' : undefined;
}

/** Git ops that overwrite or delete uncommitted work, plus `git apply`. */
function gitSignal([sub, ...rest]: string[]): MutationSignal | undefined {
  const destructive =
    (sub === 'reset' && rest.includes('--hard'))
    || (sub === 'checkout' && (rest.includes('--') || rest[0] === '.'))
    || sub === 'restore'
    || (sub === 'clean' && rest.some((arg) => /^-\w*f/.test(arg)));
  if (destructive) return 'shell-git-destructive';
  return sub === 'apply' ? 'shell-writer' : undefined;
}

// ─── Python ───────────────────────────────────────────────────────────────

const PY_WRITE_PATTERNS: ReadonlyArray<RegExp> = [
  // open(path, mode=...) with a write/append/create/update mode.
  /\bopen\s*\(\s*[^,)]*?\s*,\s*mode\s*=\s*(['"])([rwaxbt+]*[wax+][rwaxbt+]*)\1/,
  // open(path, 'w' | 'a' | 'x' | 'r+' | ...) — the mode literal.
  /\bopen\s*\(\s*[^,)]*?\s*,\s*(['"])([rwaxbt+]*[wax+][rwaxbt+]*)\1/,
  // pathlib Path methods that create, replace or remove files.
  /\b(?:pathlib\s*\.\s*)?Path\s*\([^)]*\)\s*\.\s*(?:write_text|write_bytes|touch|unlink|rename|replace|mkdir|rmdir)\s*\(/,
  // os / pathlib module functions.
  /\b(?:os|pathlib)\s*\.\s*(?:remove|unlink|rename|replace|mkdir|makedirs|rmdir)\s*\(/,
  // shutil file/dir operations.
  /\bshutil\s*\.\s*(?:copy|copy2|copyfile|copytree|move|rmtree)\s*\(/,
];

const PY_OPAQUE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bsubprocess\s*(?:\.\s*\w+\s*)?\(/,
  /\b(?:os\.system|os\.popen|Popen|eval|exec|__import__|importlib\s*\.\s*import_module)\s*\(/,
];

function pythonSignal(name: string, args: string[], redirects: Redirect[]): MutationSignal | undefined {
  // Inline code comes from `-c` or a heredoc on stdin. Script paths, `-m`
  // modules and pytest keep their code in files the classifier cannot see.
  const dashC = args.indexOf('-c');
  const heredoc = redirects.find((r) => r.operator === '<<' || r.operator === '<<-');
  const code = name === 'pytest'
    ? undefined
    : dashC !== -1 ? args[dashC + 1] : heredoc?.content;
  if (code === undefined) return 'python-opaque';
  if (PY_WRITE_PATTERNS.some((p) => p.test(code))) return 'python-write-api';
  if (PY_OPAQUE_PATTERNS.some((p) => p.test(code))) return 'python-opaque';
  return undefined;
}
