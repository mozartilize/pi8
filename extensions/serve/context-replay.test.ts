/** Replay historical prompts and tool results against entry-boundary and source contracts. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Context } from '@earendil-works/pi-ai';
import { createTempRouterDir } from '../test-support/temp-router-dir.js';
import { registryModel } from '../test-support/router-fixtures.js';
import { setupProviderTest } from '../test-support/provider-harness.js';
import { SessionTree } from '../test-support/session-tree.js';
interface Corpus {
  sessions: Array<{ id: string; files?: Record<string, string>; legacyHistory?: Array<{ role: string; text: string }>;
    entries: Array<{ id: string; prompt: string; label: { deliverable: string }; after?: Array<
      { read: string; offset?: number; limit?: number } | { externalEdit: string; content: string }
      | { write: string; content: string } | { handoff: boolean }
    > }> }>;
}
import { observeContextGrounding } from './context-grounding.js';
import { prepareHandoffFacts, submitContextHandoff } from './context-handoff-tool.js';
import { gateContextToolCall } from './gathering-gate.js';
import { gateContractMutation } from './execution-contract-tool.js';
import { refreshSourceEvidence } from './entry-evidence.js';

vi.mock('@earendil-works/pi-ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@earendil-works/pi-ai')>()),
  createAssistantMessageEventStream: vi.fn(), isRetryableAssistantError: () => false,
}));
vi.mock('@earendil-works/pi-ai/compat', () => ({ streamSimple: vi.fn() }));

const FIXTURES = join(import.meta.dirname, '..', '..', 'fixtures');
const corpus = JSON.parse(readFileSync(join(FIXTURES, 'routing-context-corpus.json'), 'utf8')) as Corpus;
const LOCAL_CORPUS = join(FIXTURES, 'local', 'sessions-corpus.json');
const LOCAL_REPLAY = process.env.PI8_LOCAL_REPLAY === '1' && existsSync(LOCAL_CORPUS);

const benchmarks = [{ registryId: 'a/model', benchSlug: 'model', active: true,
  quality: { intelligence: 50, coding: 50, agenticCoding: 50, research: 0.8 }, source: 'test' }];

describe('entry-boundary corpus replay', () => {
  let temp: ReturnType<typeof createTempRouterDir>;
  beforeEach(() => { temp = createTempRouterDir(); });
  afterEach(() => { vi.restoreAllMocks(); temp.cleanup(); });

  async function replay(source: Corpus) {
    const results: Array<{ id: string; required: number; accepted: boolean | undefined;
      writesAllowed: number; writesBlocked: number; sourcePending: boolean }> = [];
    for (const session of source.sessions) {
      const cwd = join(temp.path, session.id); mkdirSync(cwd, { recursive: true });
      for (const [path, content] of Object.entries(session.files ?? {})) {
        mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), content);
      }
      const tree = new SessionTree();
      for (const turn of session.legacyHistory ?? []) {
        if (turn.role === 'user') tree.user(turn.text); else tree.assistant(turn.text);
      }
      const ctx = { cwd, model: { provider: 'router', id: 'auto' }, sessionManager: tree.manager() } as never;
      const harness = await setupProviderTest({ dir: temp.path, benchmarks: benchmarks as never,
        models: [registryModel('a/model')], ctx });
      harness.scriptReply([{ type: 'text_delta', delta: 'served' }, { type: 'done' }]);
      const serve = async () => {
        harness.resetEventStream();
        await harness.serve({ messages: tree.getBranch().filter((e) => e.type === 'message').map((e) => e.message!) } as unknown as Context);
      };
      for (const entry of session.entries) {
        const entryId = tree.user(entry.prompt, tree.getBranch().length + 1000);
        await serve();
        const initial = harness.session.getEntryRoutingState()!;
        expect(initial, entry.id).toMatchObject({ sourceEntryId: entryId, status: 'triage', deliverable: 'gather', providerInvocation: 1 });
        expect(initial.contract, entry.id).toBeUndefined();
        expect(initial.executionFlow, entry.id).toBeUndefined();
        expect(initial.evidence!.observedFiles.size, entry.id).toBe(0);
        let accepted: boolean | undefined;
        let writesAllowed = 0;
        let writesBlocked = 0;
        const handoff = async () => {
          const before = harness.session.getEntryRoutingState()!;
          const params = { outcome: 'ready', deliverable: entry.label.deliverable === 'lightweight' ? 'gather' : entry.label.deliverable,
            complexity: 'trivial', scope: 'bounded', findings: 'checked the visible request', question: 'perform the declared task' };
          const facts = await prepareHandoffFacts(params, ctx, harness.session,
            async () => ({ stdout: '', stderr: '', code: 0 }) as never);
          accepted = submitContextHandoff(params, ctx, harness.session, facts).accepted;
          if (accepted) {
            const next = harness.session.getEntryRoutingState()!;
            expect(next.boundaryId, entry.id).not.toBe(initial.boundaryId);
            if (next.status === 'ready-pending') {
              expect(next.boundaryId, entry.id).not.toBe(before.boundaryId);
              expect(gateContextToolCall({ toolName: 'write', input: {} }, harness.session)?.block, entry.id).toBe(true);
              await serve();
              expect(harness.session.getEntryRoutingState()!.status, entry.id).toBe('served');
            } else {
              expect(before.status, entry.id).toBe('served');
              expect(next.status, entry.id).toBe('served');
              expect(next.boundaryId, entry.id).toBe(before.boundaryId);
            }
          } else {
            expect(harness.session.getEntryRoutingState()!.boundaryId, entry.id).toBe(before.boundaryId);
          }
        };
        for (const action of entry.after ?? []) {
          if ('read' in action) {
            const text = readFileSync(join(cwd, action.read), 'utf8');
            const shown = action.offset != null || action.limit != null
              ? text.split('\n').slice((action.offset ?? 1) - 1, (action.offset ?? 1) - 1 + (action.limit ?? Infinity)).join('\n') : text;
            await observeContextGrounding({ toolName: 'read', input: { path: action.read, offset: action.offset, limit: action.limit },
              content: [{ type: 'text', text: shown }] } as never, ctx, harness.session);
          } else if ('externalEdit' in action) {
            mkdirSync(dirname(join(cwd, action.externalEdit)), { recursive: true });
            writeFileSync(join(cwd, action.externalEdit), action.content);
          } else if ('write' in action) {
            await handoff();
            await refreshSourceEvidence(harness.session);
            const call = { toolName: 'write', input: { path: action.write } };
            const blocked = gateContextToolCall(call, harness.session) ?? gateContractMutation(call, harness.session);
            if (blocked?.block) {
              writesBlocked += 1;
            } else {
              writesAllowed += 1;
              mkdirSync(dirname(join(cwd, action.write)), { recursive: true });
              writeFileSync(join(cwd, action.write), action.content);
              await observeContextGrounding({ ...call, content: [{ type: 'text', text: 'ok' }] } as never, ctx, harness.session);
            }
          } else { await handoff(); }
        }
        // A historical lightweight label denotes an answer with no declaration.
        if (accepted === undefined && entry.label.deliverable !== 'lightweight') await handoff();
        await refreshSourceEvidence(harness.session);
        results.push({ id: entry.id, required: initial.evidence!.referencedPaths.length, accepted, writesAllowed, writesBlocked,
          sourcePending: harness.session.getEntryRoutingState()!.sourceEvidencePending === true });
        tree.assistant('done');
        harness.session.finishExecutionFlow();
      }
    }
    return results;
  }

  it('requires current explicit sources without inheriting task identity or source obligations', async () => {
    const results = await replay(corpus);
    expect(results.filter((r) => r.accepted === false).map((r) => r.id)).toEqual(['P1', 'L3a']);
    expect(results.find((r) => r.id === 'P1')).toMatchObject({ required: 1, accepted: false });
    expect(results.find((r) => r.id === 'P2')).toMatchObject({ required: 0, accepted: true });
    expect(results.find((r) => r.id === 'D2')).toMatchObject({ required: 0, accepted: undefined });
    expect(results.length).toBe(corpus.sessions.reduce((n, s) => n + s.entries.length, 0));
  }, 60_000);

  it('replays multiple writes through an idempotent served boundary without requiring another selection', async () => {
    const results = await replay({ sessions: [{ id: 'repeat', entries: [{ id: 'two-writes', prompt: 'implement the two changes',
      label: { deliverable: 'implement' }, after: [{ write: 'src/target.ts', content: 'first' }, { write: 'src/target.ts', content: 'second' }],
    }] }] });
    expect(results[0]).toMatchObject({ accepted: true, writesAllowed: 2, writesBlocked: 0, sourcePending: false });
    expect(readFileSync(join(temp.path, 'repeat', 'src/target.ts'), 'utf8')).toBe('second');
  });

  it.skipIf(!LOCAL_REPLAY)('reports entry and source results on the local session corpus', async () => {
    const local = JSON.parse(readFileSync(LOCAL_CORPUS, 'utf8')) as Corpus;
    const results = await replay(local);
    writeFileSync(join(FIXTURES, 'local', 'sessions-report.json'), JSON.stringify({ entries: results.length, results }, null, 1));
    expect(results.length).toBeGreaterThan(0);
  }, 3_600_000);
});
