/**
 * Pure, best-effort classifier for mutation-like tool calls.
 *
 * Pi's built-in `bash` tool is a shell string, so the router cannot know what
 * a command actually does without executing it. This classifier statically
 * recognizes high-confidence write shapes — file redirection, in-place
 * editors, file-writer commands, filesystem mutators, `dd of=`, destructive
 * git worktree resets/discards, and inline Python write APIs — so the bounded
 * mutation gate can treat them like
 * `edit`/`write`. Everything else is `none` (no recognized mutation shape)
 * or `possible` (opaque Python: scripts, `-m` modules, eval/subprocess/import
 * indirection), which only feeds observability and never blocks.
 *
 * Best effort by construction: Pi runs `tool_call` hooks in load order and
 * Bash applies its own `spawnHook` later, so a command can be rewritten after
 * this classifier observes it. Quoted strings, arithmetic/test expressions and
 * non-Python heredoc bodies are masked before shell-shape scanning, but
 * `$(...)` substitutions, aliases, imported code, versioned interpreter names,
 * and obfuscation can still hide writes. The classifier never persists or logs
 * command text — it emits enum signals only.
 *
 * Pure and deterministic: no I/O, no registry or session access.
 */
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

/**
 * Command-position introducer: start of string, after a shell separator
 * (`\n ; & | ( {`), or after a compound-block keyword (`then`/`do`/`else`).
 * The keyword forms matter because a mutation inside `if …; then sed -i …; fi`
 * or `while …; do rm …; done` is not preceded by a plain separator and would
 * otherwise be invisible to every shell-shape and interpreter pattern below.
 */
const CMD_DELIM = '(?:^|[\\n;&|({]\\s*|\\b(?:then|do|else)\\s+)';
const CMD_POS = CMD_DELIM + '(?:sudo\\s+)?';

/** Interpreter names in command position; `pytest` is opaque by definition. */
const PYTHON_INVOCATION = new RegExp(
  CMD_POS + '(?:(?:uv|poetry|pipenv)\\s+run\\s+)?(?:python[23]?(?:\\.\\d+)?|pytest)(?=[\\s"\'<])',
  'g',
);

/** A heredoc opener: `<<DELIM`, `<<-DELIM`, with optional quotes. */
const HEREDOC_OPENER = /(?<!<)<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/;

/** A heredoc whose body is Python code (the interpreter owns the opener line). */
const PYTHON_HEREDOC_OPENER = new RegExp(
  CMD_POS + '(?:(?:uv|poetry|pipenv)\\s+run\\s+)?python[23]?(?:\\.\\d+)?' +
    '(?:\\s+[^;&|\\n]*)?\\s*<<-?\\s*[\'"]?([A-Za-z_][A-Za-z0-9_]*)["\']?\\s*$',
);

function classifyBashCommand(command: string): MutationDetection {
  // Heredoc bodies are input data, not shell code: blank non-Python bodies
  // first so python-looking text inside `cat <<EOF` cannot drive detection.
  const forPython = blankHeredocBodies(command, (line) => PYTHON_HEREDOC_OPENER.test(line));
  const python = detectPython(forPython);
  if (python?.confidence === 'high') return python;

  // Blank heredoc bodies before masking quoted spans so quoted delimiters stay
  // visible to the heredoc scanner. Shell comments are data after `#`, not
  // executable command text. Redirect scanning keeps quotes long enough to
  // recognize quoted target paths, while command-name scanning masks them.
  const withoutHeredocBodies = blankHeredocBodies(command, () => false);
  const redirectInput = maskArithmeticAndTests(maskShellComments(withoutHeredocBodies));
  const masked = maskQuoted(redirectInput);

  const shell = detectShellShape(masked, redirectInput);
  if (shell) return shell;

  // Opaque Python (script files, `-m` modules, eval/subprocess/import
  // indirection) is observability-only: the static scan cannot prove a write.
  if (python?.confidence === 'possible') return python;

  return { confidence: 'none' };
}

// ─── Python detection ─────────────────────────────────────────────────────

function detectPython(command: string): MutationDetection | undefined {
  let best: MutationDetection | undefined;
  PYTHON_INVOCATION.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PYTHON_INVOCATION.exec(command)) !== null) {
    const detection = classifyPythonInvocation(command.slice(m.index + m[0].length));
    if (!detection) continue;
    if (detection.confidence === 'high') return detection;
    if (!best || rank(detection) > rank(best)) best = detection;
  }
  return best;
}

function rank(detection: MutationDetection): number {
  return detection.confidence === 'high' ? 2 : detection.confidence === 'possible' ? 1 : 0;
}

function classifyPythonInvocation(tail: string): MutationDetection | undefined {
  const heredoc = /^\s*(<<-?)\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/.exec(tail);
  if (heredoc) {
    const body = extractHeredocBody(tail.slice(heredoc[0].length), heredoc[2], heredoc[1].includes('-'));
    if (body === undefined) {
      // Unterminated heredoc: the full body is invisible — opaque.
      return { confidence: 'possible', surface: 'bash-python-opaque', signal: 'python-opaque' };
    }
    return pythonCodeDetection(body);
  }

  const tokens = tokenizeTail(tail);
  const dashC = tokens.indexOf('-c');
  if (dashC !== -1) {
    const code = tokens[dashC + 1];
    if (code !== undefined) return pythonCodeDetection(stripQuotes(code));
    return { confidence: 'possible', surface: 'bash-python-opaque', signal: 'python-opaque' };
  }

  // Any other invocation form (script path, `-m` module, version flags) keeps
  // its code in a file or module the classifier cannot see — opaque.
  return { confidence: 'possible', surface: 'bash-python-opaque', signal: 'python-opaque' };
}

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

function pythonCodeDetection(code: string): MutationDetection {
  if (PY_WRITE_PATTERNS.some((p) => p.test(code))) {
    return { confidence: 'high', surface: 'bash-python-inline', signal: 'python-write-api' };
  }
  if (PY_OPAQUE_PATTERNS.some((p) => p.test(code))) {
    return { confidence: 'possible', surface: 'bash-python-opaque', signal: 'python-opaque' };
  }
  return { confidence: 'none' };
}

/** Quote-aware token scan of everything after the interpreter name. */
function tokenizeTail(tail: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < tail.length) {
    const ch = tail[i];
    if (/\s/.test(ch) || ch === ';' || ch === '&' || ch === '|') {
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = tail.indexOf(ch, i + 1);
      if (end === -1) {
        tokens.push(tail.slice(i));
        break;
      }
      tokens.push(tail.slice(i, end + 1));
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < tail.length && !/[\s;&|]/.test(tail[j])) j++;
    tokens.push(tail.slice(i, j));
    i = j;
  }
  return tokens;
}

function stripQuotes(token: string): string {
  if (token.length >= 2 && (token[0] === "'" || token[0] === '"') && token[token.length - 1] === token[0]) {
    return token.slice(1, -1);
  }
  return token;
}

function extractHeredocBody(rest: string, delimiter: string, stripTabs: boolean): string | undefined {
  const body: string[] = [];
  for (const line of rest.split('\n')) {
    const candidate = stripTabs ? line.replace(/^\t+/, '') : line;
    if (candidate === delimiter) return body.join('\n');
    body.push(line);
  }
  return undefined;
}

// ─── Shell shape detection ────────────────────────────────────────────────

const SHELL_PATTERNS: ReadonlyArray<{ signal: MutationSignal; pattern: RegExp }> = [
  {
    signal: 'shell-inplace',
    pattern: new RegExp(
      CMD_POS + '(?:sed\\s+(?:--in-place(?:=\\S+)?|-i\\S*)|perl\\s+-[a-z]*i\\S*|awk\\s+-i\\s+inplace)\\b',
      'i',
    ),
  },
  {
    signal: 'shell-writer',
    pattern: new RegExp(CMD_POS + '(?:tee|patch|git\\s+apply|truncate|touch)\\b', 'i'),
  },
  {
    signal: 'shell-filesystem',
    pattern: new RegExp(CMD_POS + '(?:cp|mv|rm|install|mkdir|ln)\\b', 'i'),
  },
  {
    // Destructive git worktree ops that overwrite/delete uncommitted work.
    // `git reset --hard`, `git checkout -- <paths>` / `git checkout .`,
    // `git restore` (worktree discard is its default), and forced `git clean`.
    // These match no redirect/writer/filesystem shape yet are the likeliest to
    // lose real work, so they get their own high-confidence signal.
    signal: 'shell-git-destructive',
    pattern: new RegExp(
      CMD_POS +
        'git\\s+(?:' +
        'reset\\b[^\\n;&|()]*--hard\\b' +
        '|checkout\\b[^\\n;&|()]*\\s--(?:\\s|$)' +
        '|checkout\\s+\\.(?:\\s|$)' +
        '|restore\\b' +
        '|clean\\b[^\\n;&|()]*\\s-\\w*f' +
        ')',
      'i',
    ),
  },
];

const BENIGN_TARGETS = ['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty'];

function isBenignTarget(target: string): boolean {
  if (BENIGN_TARGETS.includes(target)) return true;
  if (target.startsWith('/dev/fd/')) return true;
  return false;
}

/** True when the command writes to a file through `>`/`>>`/`>|`/`&>`. */
function hasFileRedirect(text: string): boolean {
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch !== '>') continue;
    const prev = i > 0 ? text[i - 1] : '';
    const next = i + 1 < text.length ? text[i + 1] : '';
    // `<>` read-write opens and `2>&1`-style fd duplication are not file writes.
    if (prev === '<') continue;
    if (/[0-9]/.test(prev) && next === '&') continue;
    let j = i + 1;
    if (next === '&') {
      // `>&1` duplicates stdout onto an fd; `>&file` writes a file.
      const after = i + 2 < text.length ? text[i + 2] : '';
      if (/[0-9]/.test(after)) continue;
      j = i + 2;
    } else if (next === '>' || next === '|') {
      j = i + 2; // `>>` append, `>|` clobber.
    }
    while (j < text.length && /\s/.test(text[j])) j++;
    let target = '';
    const targetQuote = text[j] === "'" || text[j] === '"' ? text[j++] : undefined;
    while (j < text.length) {
      if (targetQuote) {
        if (text[j] === targetQuote) break;
        if (text[j] === '\\' && targetQuote === '"' && j + 1 < text.length) j++;
      } else if (/[\s;|&()<>]/.test(text[j])) {
        break;
      }
      target += text[j];
      j++;
    }
    if (target !== '' && !isBenignTarget(target)) return true;
  }
  return false;
}

function ddTarget(masked: string): string | undefined {
  const m = new RegExp(CMD_POS + 'dd\\b[^;&|\\n]*\\bof=([^\\s;&|()]+)').exec(masked);
  return m?.[1]?.replace(/['"]/g, '');
}

function detectShellShape(masked: string, redirectInput: string): MutationDetection | undefined {
  if (hasFileRedirect(redirectInput)) {
    return { confidence: 'high', surface: 'bash-shell', signal: 'shell-redirect' };
  }
  for (const { signal, pattern } of SHELL_PATTERNS) {
    if (pattern.test(masked)) {
      return { confidence: 'high', surface: 'bash-shell', signal };
    }
  }
  const dd = ddTarget(masked);
  if (dd !== undefined && !isBenignTarget(dd)) {
    return { confidence: 'high', surface: 'bash-shell', signal: 'shell-dd' };
  }
  return undefined;
}

// ─── Masking ──────────────────────────────────────────────────────────────

/** Blank shell comments outside quotes while preserving line/column positions. */
function maskShellComments(text: string): string {
  const chars = [...text];
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    const startsComment = ch === '#' && (i === 0 || /[\s;|&()]/.test(chars[i - 1]));
    if (!startsComment) continue;
    while (i < chars.length && chars[i] !== '\n') chars[i++] = ' ';
  }
  return chars.join('');
}

/** Blank single/double-quoted spans (shell strings are data, not commands). */
function maskQuoted(command: string): string {
  let out = command;
  let i = 0;
  while (i < out.length) {
    const ch = out[i];
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < out.length) {
        if (out[j] === '\\' && ch === '"') {
          j += 2;
          continue;
        }
        if (out[j] === ch) break;
        j++;
      }
      if (j >= out.length) j = out.length - 1;
      const span = out.slice(i, j + 1);
      out = out.slice(0, i) + ' '.repeat(span.length) + out.slice(j + 1);
      i = j + 1;
    } else {
      i++;
    }
  }
  return out;
}

/** Blank spans between matching markers, e.g. `$((...))` arithmetic and `[[...]]` tests. */
function maskBetween(text: string, open: string, close: string): string {
  let result = text;
  let idx = result.indexOf(open);
  while (idx !== -1) {
    const end = result.indexOf(close, idx + open.length);
    if (end === -1) break;
    const span = result.slice(idx, end + close.length);
    result = result.slice(0, idx) + ' '.repeat(span.length) + result.slice(end + close.length);
    idx = result.indexOf(open, idx + 1);
  }
  return result;
}

function maskArithmeticAndTests(text: string): string {
  return maskBetween(maskBetween(text, '$((', '))'), '[[', ']]');
}

/**
 * Blank the bodies of heredocs whose opener line fails `isPythonHeredoc`.
 * Blanked lines become spaces, so positions elsewhere in the command stay
 * intact while body content can no longer drive classification.
 */
function blankHeredocBodies(text: string, isPythonHeredoc: (line: string) => boolean): string {
  const lines = text.split('\n');
  const out = [...lines];
  for (let i = 0; i < lines.length; i++) {
    const opener = HEREDOC_OPENER.exec(lines[i]);
    if (!opener) continue;
    if (isPythonHeredoc(lines[i])) continue;
    const delimiter = opener[1];
    const stripTabs = lines[i].includes('<<-');
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = stripTabs ? lines[j].replace(/^\t+/, '') : lines[j];
      if (candidate === delimiter || candidate.trim() === delimiter) {
        for (let k = i + 1; k < j; k++) out[k] = ' '.repeat(lines[k].length) || ' ';
        break;
      }
    }
  }
  return out.join('\n');
}
