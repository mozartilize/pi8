#!/usr/bin/env node
/**
 * Build a local work-context replay corpus from this machine's Pi sessions.
 *
 *   node scripts/session-corpus.mjs extract   sessions → skeleton + labelling view
 *   node scripts/session-corpus.mjs merge     skeleton + labels → corpus
 *
 * Everything it writes goes to fixtures/local/, which is
 * gitignored: prompts stay verbatim and never leave this machine.
 *
 * The skeleton keeps what the router can observe of each genuine user entry
 * on the active branch: the prompt, then Pi's native read/write/edit calls
 * and investigation handoffs, in order. Reads keep their real offset and
 * limit, and each file becomes a stub with the file's real line count (from
 * Pi's "of N" notice or a read that reached the end), so chunked reads cover
 * it exactly as they covered the real file. A stub has one version per
 * observed content: a model write or edit bumps the version, and a full
 * read whose content differs from the last known content (with no model
 * write between) is an edit the router cannot see (the user, or a bash
 * command), replayed as an external edit. Reads through any other tool are
 * invisible to the router and are dropped.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'fixtures', 'local');
const SESSIONS = process.env.PI_SESSIONS_DIR ?? join(homedir(), '.pi', 'agent', 'sessions');
const DEFAULT_LINES = 200;
const NOTICE = /\n\n\[(?:Showing lines (\d+)-(\d+) of (\d+)[^\]\n]*|(\d+) more lines in file\.[^\]\n]*)\]$/u;

const sha = (text) => createHash('sha256').update(text).digest('hex');
const stub = (path, version, lines) =>
  Array.from({ length: lines }, (_, i) => `${path} v${version} line ${i + 1}`).join('\n');

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text').map((b) => b.text ?? '').join('\n');
}

function readJsonl(file) {
  const rows = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* torn line */ }
  }
  return rows;
}

/** Entries on the active branch: from the last entry up its parent chain. */
function activeBranch(rows) {
  const entries = rows.filter((row) => row.id && row.type !== 'session');
  if (entries.length === 0) return [];
  const byId = new Map(entries.map((row) => [row.id, row]));
  const path = [];
  for (let cur = entries.at(-1); cur; cur = byId.get(cur.parentId)) path.push(cur);
  return path.reverse();
}

function projectOf(dir) {
  const name = dir.replace(/^-+|-+$/gu, '');
  const tail = name.split('-workspace-').at(-1);
  return tail.replace(/[^A-Za-z0-9]+/gu, '-').toLowerCase();
}

function extract() {
  const files = readdirSync(SESSIONS).flatMap((dir) => {
    const full = join(SESSIONS, dir);
    if (!statSync(full).isDirectory()) return [];
    return readdirSync(full).filter((f) => f.endsWith('.jsonl')).map((f) => ({ dir, file: join(full, f) }));
  }).sort((a, b) => statSync(a.file).mtimeMs - statSync(b.file).mtimeMs);

  const seen = new Set();
  const sessions = [];
  const views = [];
  const counters = new Map();
  for (const { dir, file } of files) {
    const rows = readJsonl(file);
    const header = rows.find((row) => row.type === 'session');
    const cwd = header?.cwd ?? '';
    const branch = activeBranch(rows);
    const project = projectOf(dir);

    const toRel = (path) => {
      if (typeof path !== 'string' || path.length === 0) return undefined;
      const clean = path.replace(/^@/u, '').replace(/^~(?=\/)/u, homedir());
      const abs = isAbsolute(clean) ? clean : resolve(cwd, clean);
      const rel = relative(cwd, abs);
      return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : undefined;
    };

    const entries = [];
    const apis = new Map();
    // Per path: stub version, and the hash of the content last known to be on disk.
    const fileState = new Map();
    const state = (path) => {
      let s = fileState.get(path);
      if (!s) {
        s = { version: 0, known: undefined, lines: undefined };
        fileState.set(path, s);
      }
      return s;
    };
    let current;
    let lastEntry;
    const calls = new Map();
    let mutatedSinceRead = false;

    for (const row of branch) {
      const message = row.message ?? {};
      if (row.type === 'message' && message.role === 'user') {
        const prompt = textOf(message.content).trim();
        if (!prompt) continue;
        const key = `${row.timestamp}\u0000${prompt.slice(0, 200)}`;
        if (seen.has(key)) { current = undefined; continue; }
        seen.add(key);
        lastEntry = current ?? lastEntry;
        current = { prompt, after: [], view: { tools: {}, reads: [], writes: [], text: '' } };
        entries.push(current);
        continue;
      }
      if (!current) continue;
      if (row.type === 'message' && message.role === 'assistant') {
        if (message.api) apis.set(message.api, (apis.get(message.api) ?? 0) + 1);
        for (const block of message.content ?? []) {
          if (block?.type === 'toolCall') {
            calls.set(block.id, block);
            current.view.tools[block.name] = (current.view.tools[block.name] ?? 0) + 1;
            if (block.name === 'bash') mutatedSinceRead = true;
          } else if (block?.type === 'text' && block.text && current.view.text.length < 300) {
            current.view.text = `${current.view.text} ${block.text}`.trim().slice(0, 300);
          }
        }
        continue;
      }
      if (row.type !== 'message' || message.role !== 'toolResult' || message.isError) continue;
      const call = calls.get(message.toolCallId);
      if (!call) continue;
      const args = call.arguments ?? {};
      // Recorded sessions name the handoff by either tool name.
      if (call.name === 'hand_off_context' || call.name === 'hand_off_investigation') {
        current.after.push({ handoff: 'investigation' });
        continue;
      }
      if (!['read', 'write', 'edit'].includes(call.name)) continue;
      const path = toRel(args.path ?? args.file_path);
      if (!path) continue;
      const s = state(path);
      if (call.name === 'read') {
        const returned = textOf(message.content);
        const chunked = args.offset != null || args.limit != null || NOTICE.test(returned);
        if (!chunked) {
          const hash = sha(returned);
          s.lines = Math.max(s.lines ?? 0, returned.split('\n').length);
          if (s.known && s.known !== hash) {
            s.version += 1;
            const edit = { externalEdit: path, version: s.version };
            // With no command run since the last read, the change came from
            // outside the session, before this entry.
            if (!mutatedSinceRead && lastEntry && current.after.length === 0) lastEntry.after.push(edit);
            else current.after.push(edit);
          }
          s.known = hash;
          current.after.push({ read: path });
        } else {
          const offset = typeof args.offset === 'number' && args.offset > 1 ? Math.floor(args.offset) : 1;
          const notice = NOTICE.exec(returned);
          const body = notice ? returned.slice(0, notice.index) : returned;
          const end = offset - 1 + body.split('\n').length;
          const total = notice ? (notice[3] ? Number(notice[3]) : end + Number(notice[4])) : end;
          s.lines = Math.max(s.lines ?? 0, total);
          const limit = end - offset + 1;
          current.after.push({ read: path, offset, limit });
        }
        if (!current.view.reads.includes(path)) current.view.reads.push(path);
        mutatedSinceRead = false;
      } else {
        s.version += 1;
        s.known = call.name === 'write' && typeof args.content === 'string' ? sha(args.content) : undefined;
        if (typeof args.content === 'string') s.lines = Math.max(s.lines ?? 0, args.content.split('\n').length);
        current.after.push({ write: path, version: s.version });
        if (!current.view.writes.includes(path)) current.view.writes.push(path);
      }
    }
    if (entries.length === 0) continue;
    // Stubs get their content once every file's line count is known.
    const linesOf = (path) => fileState.get(path)?.lines ?? DEFAULT_LINES;
    const initial = Object.fromEntries([...fileState.keys()].map((path) => [path, stub(path, 0, linesOf(path))]));
    for (const entry of entries) {
      entry.after = entry.after.map((action) => {
        if ('write' in action) return { write: action.write, content: stub(action.write, action.version, linesOf(action.write)) };
        if ('externalEdit' in action) return { externalEdit: action.externalEdit, content: stub(action.externalEdit, action.version, linesOf(action.externalEdit)) };
        return action;
      });
    }
    const n = (counters.get(project) ?? 0) + 1;
    counters.set(project, n);
    const id = `${project}-${String(n).padStart(3, '0')}`;
    const apiFamily = [...apis.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown';
    sessions.push({
      id,
      source: relative(SESSIONS, file),
      apiFamily,
      files: initial,
      entries: entries.map((entry, i) => ({ id: `${id}/${String(i + 1).padStart(3, '0')}`, prompt: entry.prompt, after: entry.after })),
    });
    views.push({ id, source: relative(SESSIONS, file), entries: entries.map((entry, i) => ({
      id: `${id}/${String(i + 1).padStart(3, '0')}`,
      prompt: entry.prompt.length > 500 ? `${entry.prompt.slice(0, 500)} …[${entry.prompt.length} chars]` : entry.prompt,
      ...entry.view,
    })) });
  }

  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'sessions-skeleton.json'), JSON.stringify({ version: 1, sessions }, null, 1));
  writeFileSync(join(OUT, 'sessions-view.jsonl'), views.map((v) => JSON.stringify(v)).join('\n') + '\n');
  const total = sessions.reduce((sum, s) => sum + s.entries.length, 0);
  console.log(`${sessions.length} sessions, ${total} entries, ${total - sessions.length} later entries → ${relative(ROOT, OUT)}`);
}

const DELIVERABLES = { L: 'lightweight', G: 'gather', P: 'plan', I: 'implement', R: 'review' };
const CONTEXT = { n: [], r: ['referenced-artifact'], u: ['identity-unresolved'] };

/**
 * Label files, fixtures/local/labels/*.txt:
 *
 *   # <session id>
 *   <entry number> <topic> <work item | -> <L|G|P|I|R> <n|r|u> [o]
 *
 * `-` is an entry that belongs to no work item; `o` marks open-ended scope.
 * The context code says what the request owes: `n` nothing, `r` the files it
 * references, `u` which work it is, which only the user can say.
 * Aliases are session-local. Topic and work-item relations, `existing`, the
 * handoff titles, and `contextSatisfied` are derived here.
 */
function readLabels() {
  const dir = join(OUT, 'labels');
  const labels = {};
  if (!existsSync(dir)) return labels;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.txt')).sort()) {
    let session;
    for (const [n, raw] of readFileSync(join(dir, file), 'utf8').split('\n').entries()) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#')) { session = line.slice(1).trim(); continue; }
      const [num, topic, work, d, p, scope] = line.split(/\s+/u);
      const deliverable = DELIVERABLES[d];
      const context = CONTEXT[p];
      if (!session || !deliverable || !context || !topic || !work) throw new Error(`${file}:${n + 1}: bad label "${line}"`);
      // Aliases are scored corpus-wide, so each session gets its own.
      labels[`${session}/${num.padStart(3, '0')}`] = {
        topic: `t:${session}:${topic}`, workItem: work === '-' ? 'NONE' : `w:${session}:${work}`, deliverable, context,
        scope: scope === 'o' ? 'open-ended' : 'bounded',
      };
    }
  }
  return labels;
}

function merge() {
  const skeleton = JSON.parse(readFileSync(join(OUT, 'sessions-skeleton.json'), 'utf8'));
  const labels = readLabels();
  const sessions = [];
  let unlabelled = 0;
  for (const session of skeleton.sessions) {
    if (!session.entries.every((entry) => labels[entry.id])) {
      unlabelled += session.entries.filter((entry) => !labels[entry.id]).length;
      continue;
    }
    const knownWork = new Set();
    const knownTopics = new Set();
    // Router-observable truth for contextSatisfied: every file the work
    // item requires was fully read, or written by the model, since it last
    // changed outside the session.
    const grounded = new Map();
    const required = new Map();
    const lineCount = (path) => (session.files[path] ?? '').split('\n').length;
    const coverage = new Map();
    let activeWork;
    let previousTopic;
    const entries = session.entries.map((entry) => {
      const l = { ...labels[entry.id] };
      const existing = l.workItem !== 'NONE' && knownWork.has(l.workItem);
      l.topicRelation = !knownTopics.has(l.topic) ? 'new' : l.topic === previousTopic ? 'same' : 'switch';
      l.relation = l.workItem === 'NONE' ? 'switch' : !existing ? 'new' : l.workItem === activeWork ? 'continue' : 'resume';
      previousTopic = l.topic;
      if (l.workItem !== 'NONE') activeWork = l.workItem;
      // A file the work item requires: any session file a prompt of the item
      // names, with or without `@`.
      const refs = Object.keys(session.files).filter((path) => entry.prompt.includes(path));
      if (l.workItem !== 'NONE' && refs.length > 0) {
        const set = required.get(l.workItem) ?? new Set();
        for (const ref of refs) set.add(ref);
        required.set(l.workItem, set);
      }
      const need = [...(required.get(l.workItem) ?? [])];
      // Nothing owed is satisfied; only the user can say which work it is.
      const contextSatisfied = l.context.length === 0
        || (l.context[0] === 'referenced-artifact' && need.length > 0 && need.every((path) => grounded.get(path) === true));
      for (const action of entry.after) {
        if ('read' in action) {
          if (action.offset == null) { grounded.set(action.read, true); continue; }
          const lines = coverage.get(action.read) ?? new Set();
          for (let i = action.offset; i < action.offset + action.limit; i += 1) lines.add(i);
          coverage.set(action.read, lines);
          if (lines.size >= lineCount(action.read)) grounded.set(action.read, true);
        } else if ('write' in action) { grounded.set(action.write, true); coverage.delete(action.write); }
        else if ('externalEdit' in action) { grounded.set(action.externalEdit, false); coverage.delete(action.externalEdit); }
      }
      if (l.workItem !== 'NONE') knownWork.add(l.workItem);
      knownTopics.add(l.topic);
      return {
        id: entry.id,
        prompt: entry.prompt,
        titles: { topic: l.topic.split(':').at(-1), work: l.workItem === 'NONE' ? 'none' : l.workItem.split(':').at(-1) },
        after: entry.after,
        label: {
          topic: l.topic, topicRelation: l.topicRelation, workItem: l.workItem, relation: l.relation,
          existing, deliverable: l.deliverable, context: l.context, contextSatisfied,
        },
      };
    });
    sessions.push({ id: session.id, scenario: session.source, apiFamily: session.apiFamily, files: session.files, entries });
  }
  const corpus = {
    version: 1,
    description: 'Model-labelled replay corpus built from local Pi sessions (scripts/session-corpus.mjs). Local only; never commit.',
    sessions,
  };
  writeFileSync(join(OUT, 'sessions-corpus.json'), JSON.stringify(corpus, null, 1));
  const total = sessions.reduce((sum, s) => sum + s.entries.length, 0);
  console.log(`${sessions.length} sessions, ${total} labelled entries; ${unlabelled} entries in partly labelled sessions skipped`);
}

const command = process.argv[2];
if (command === 'extract') extract();
else if (command === 'merge') merge();
else {
  console.error('usage: node scripts/session-corpus.mjs extract|merge');
  process.exit(2);
}
