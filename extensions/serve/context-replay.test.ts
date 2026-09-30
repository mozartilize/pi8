/**
 * Replay the labelled work-context corpus through the provider and score it.
 *
 * Each session includes files on disk, pre-tracking history, a provider entry,
 * and the router-observable events the corpus lists. Labelled choices are
 * submitted through the context handoff; they test boundary plumbing, not
 * the model's ability to make those choices. The corpus cannot establish
 * the statistical release gates; it pins safety across scenario shapes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Context, Message } from '@earendil-works/pi-ai';
import { createTempRouterDir } from '../test-support/temp-router-dir.js';
import { registryModel } from '../test-support/router-fixtures.js';
import { setupProviderTest, type ProviderTestHarness } from '../test-support/provider-harness.js';
import { SessionTree } from '../test-support/session-tree.js';
import {
  correctnessGates,
  sameReasons,
  scoreByApiFamily,
  type Corpus,
  type CorpusEntry,
  type CorpusLabel,
  type CorpusSession,
  type EntryPrediction,
} from '../test-support/context-replay.js';
import { CONTEXT_ENTRY_TYPE } from '../routing/context/persistence.js';
import { carriedContext, requestContext, referencedArtifactPaths } from '../routing/context/resolve.js';
import { referencedArtifactsFresh } from '../routing/context/grounding.js';
import type { ContextReason } from '../routing/context/types.js';
import { DIMENSION_STRENGTH } from '../routing/dimensions.js';
import { observeContextGrounding } from './context-grounding.js';
import { prepareHandoffFacts, submitContextHandoff } from './context-handoff-tool.js';

vi.mock('@earendil-works/pi-ai', async (importOriginal) => ({
  contentText: (await importOriginal<typeof import('@earendil-works/pi-ai')>()).contentText,
  Type: (await importOriginal<typeof import('@earendil-works/pi-ai')>()).Type,
  createAssistantMessageEventStream: vi.fn(),
  isRetryableAssistantError: () => false,
}));
vi.mock('@earendil-works/pi-ai/compat', () => ({ streamSimple: vi.fn() }));

const FIXTURES = join(import.meta.dirname, '..', '..', 'fixtures');
const corpus = JSON.parse(readFileSync(join(FIXTURES, 'routing-context-corpus.json'), 'utf8')) as Corpus;
// Built from this machine's Pi sessions by scripts/session-corpus.mjs; gitignored.
const LOCAL_CORPUS = join(FIXTURES, 'local', 'sessions-corpus.json');
/** The local replay takes minutes, so it runs only when asked: `npm run replay:local`. */
const LOCAL_REPLAY = process.env.PI8_LOCAL_REPLAY === '1' && existsSync(LOCAL_CORPUS);

const BENCHMARKS = [
  {
    registryId: 'alpha/cheap', benchSlug: 'alpha-cheap', active: true,
    quality: { intelligence: 0.5, coding: 0.5, agenticCoding: 0.5 }, priceInputPer1M: 0.1, priceOutputPer1M: 0.2, source: 'test',
  },
  {
    registryId: 'beta/strong', benchSlug: 'beta-strong', active: true,
    quality: { intelligence: 0.9, coding: 0.9, agenticCoding: 0.9 }, priceInputPer1M: 2, priceOutputPer1M: 8, source: 'test',
  },
];
const MODELS = [
  registryModel('alpha/cheap', { contextWindow: 200000, maxTokens: 8192, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 } }),
  registryModel('beta/strong', { contextWindow: 200000, maxTokens: 8192, cost: { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 } }),
];

const HANDOFF = (entry: CorpusEntry) => ({
  outcome: ['gather', 'lightweight'].includes(entry.label.deliverable) ? 'answer' : 'ready',
  deliverable: entry.label.deliverable,
  complexity: 'trivial', scope: 'bounded',
  findings: 'the request and visible context were checked',
  question: 'serve the selected work',
  ...(['plan', 'review'].includes(entry.label.deliverable)
    ? { difficulty: { alternatives: 1, stakes: 1, spread: 1, knowledge: 1, uncertainty: 1 } } : {}),
});

describe('routing-context corpus replay', () => {
  let temp: ReturnType<typeof createTempRouterDir>;
  beforeEach(() => { temp = createTempRouterDir(); });
  afterEach(async () => {
    const { setDecisionLogBase } = await import('../host/decisionlog.js');
    setDecisionLogBase(undefined);
    vi.restoreAllMocks();
    temp.cleanup();
  });

  async function replaySession(session: CorpusSession): Promise<EntryPrediction[]> {
    const cwd = join(temp.path, session.id);
    mkdirSync(cwd, { recursive: true });
    for (const [path, content] of Object.entries(session.files ?? {})) {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), content);
    }
    const tree = new SessionTree();
    for (const turn of session.legacyHistory ?? []) {
      if (turn.role === 'user') tree.user(turn.text);
      else tree.assistant(turn.text);
    }
    const harness: ProviderTestHarness = await setupProviderTest({
      dir: temp.path,
      benchmarks: BENCHMARKS as never,
      models: MODELS,
      ctx: { cwd, sessionManager: tree.manager() } as never,
    });
    harness.session.context.bindPersistence((event) => tree.appendEntry(CONTEXT_ENTRY_TYPE, event));
    harness.session.context.restore(tree.getBranch());
    const routerCtx = { cwd, model: { provider: 'router', id: 'auto' }, sessionManager: tree.manager() } as never;

    // Aliases are attached only after the handoff creates the corresponding item.
    const ids = new Map<string, string>();
    harness.scriptReply([{ type: 'text_delta', delta: 'served' }, { type: 'done' }]);
    const messages = (): Message[] => tree.getBranch().flatMap((e) =>
      e.type === 'message' ? [{ role: e.message!.role, content: e.message!.content, timestamp: e.message!.timestamp } as Message] : []);
    const serve = async () => {
      harness.resetEventStream();
      await harness.serve({ messages: messages() } as unknown as Context);
    };

    // The entry's model asked the user which work it is, in text or through the handoff.
    let askedUser = false;
    // These choices test the handoff contract; they are not model-generated predictions.
    const handoff = async (entry: CorpusEntry): Promise<boolean> => {
      const state = harness.session.getWorkPhaseState();
      const acquiring = state?.contextStatus === 'acquiring';
      // Collecting context hands off; so does an incumbent that changes phase.
      if (!state || (!acquiring && !(state.incumbentServes && state.contextStatus == null))) return false;
      const pending = state.pendingIdentity;
      const label = entry.label;
      if (label.context.includes('identity-unresolved')) {
        askedUser = true;
        // An incumbent asks in its answer; collecting context asks through the handoff.
        if (!acquiring) return false;
        return submitContextHandoff({ outcome: 'needs-user', question: 'Which work and source should I use?' },
          routerCtx, harness.session).accepted;
      }
      let choice: string | undefined;
      if (pending) {
        choice = label.workItem === 'NONE' ? 'NONE' : ids.get(label.workItem)
          ?? (label.existing ? undefined : 'NEW_WORK_ITEM');
        if (!choice || (choice !== 'NEW_WORK_ITEM' && choice !== 'NONE'
          && !pending.catalog.workItems.some((item) => item.id === choice)
          && !pending.legacy.some((item) => item.id === choice))) return false;
      }
      const newWork = choice === 'NEW_WORK_ITEM' || pending?.legacy.some((item) => item.id === choice);
      const params = {
        ...HANDOFF(entry),
        ...(choice ? { workItemId: choice } : {}),
        ...(newWork ? {
          topicId: ids.get(label.topic) ?? 'NEW_TOPIC',
          topicTitle: entry.titles?.topic ?? 'Unclassified topic',
          workItemTitle: entry.titles?.work ?? entry.prompt.slice(0, 100),
        } : {}),
      };
      const facts = await prepareHandoffFacts(params, routerCtx, harness.session,
        async () => ({ stdout: '', stderr: '', code: 0 }) as never);
      const result = submitContextHandoff(params, routerCtx, harness.session, facts);
      if (!result.accepted) return false;
      await serve();
      return true;
    };

    const predictions: EntryPrediction[] = [];
    for (const [ordinal, entry] of session.entries.entries()) {
      askedUser = false;
      tree.user(entry.prompt, 1_000 + tree.getBranch().length);
      await serve();
      const initialContext = harness.getProviderState().lastDecision?.workContext;
      const pendingBase = harness.session.getWorkPhaseState()?.pendingIdentity?.base;
      // The scripted choice declares which existing item the handoff will
      // select; check its carried references without assigning entry identity.
      const declaredId = ids.get(entry.label.workItem);
      const declaredItem = declaredId ? harness.session.context.getLedger().items.get(declaredId) : undefined;
      const requested = initialContext?.contextReasons ?? [...new Set([
        ...(pendingBase ? requestContext(pendingBase.anchors, pendingBase.deliverable) : []),
        ...(declaredItem ? carriedContext(declaredItem) : []),
      ])];
      const requestedSatisfied = initialContext?.contextSatisfied ?? (requested.length === 0
        || (!!declaredItem && await referencedArtifactsFresh(cwd, declaredItem, referencedArtifactPaths(declaredItem))));
      let attemptedHandoff = false;
      for (const action of entry.after ?? []) {
        if ('read' in action) {
          const text = readFileSync(join(cwd, action.read), 'utf8');
          const shown = action.offset != null || action.limit != null
            ? text.split('\n').slice((action.offset ?? 1) - 1, (action.offset ?? 1) - 1 + (action.limit ?? Infinity)).join('\n')
            : text;
          await observeContextGrounding(
            { toolName: 'read', input: { path: action.read, offset: action.offset, limit: action.limit }, content: [{ type: 'text', text: shown }], isError: false } as never,
            { cwd, sessionManager: tree.manager() } as never,
            harness.session,
          );
        } else if ('write' in action) {
          attemptedHandoff = true;
          if (await handoff(entry) || harness.session.getWorkPhaseState()?.contextStatus !== 'acquiring') {
            writeFileSync(join(cwd, action.write), action.content);
            await observeContextGrounding(
              { toolName: 'write', input: { path: action.write }, content: [{ type: 'text', text: 'ok' }], isError: false } as never,
              { cwd, sessionManager: tree.manager() } as never,
              harness.session,
            );
          }
        } else if ('externalEdit' in action) {
          writeFileSync(join(cwd, action.externalEdit), action.content);
        } else {
          attemptedHandoff = true;
          await handoff(entry);
        }
      }
      if (!attemptedHandoff) await handoff(entry);
      const selected = harness.session.getCachedIntent()?.context;
      const contextStatus = harness.session.getWorkPhaseState()?.contextStatus;
      // An entry the handoff could only answer with a question owes which work it is.
      const observedContext: ContextReason[] = requested.length > 0 ? requested
        : askedUser || contextStatus === 'clarification-only' ? ['identity-unresolved']
        : selected?.resolution.contextReasons ?? [];
      // Unresolved work is owed only while collecting context: an incumbent answers without it.
      const phase = harness.session.getWorkPhaseState();
      const observedSatisfied = observedContext.includes('identity-unresolved') ? false
        : requested.length > 0 ? requestedSatisfied
        : selected?.contextSatisfied ?? (phase?.pendingIdentity && !phase.incumbentServes ? false : requestedSatisfied);
      const label = entry.label;
      if (selected?.createdWorkItem && selected.workItemId && !label.existing && label.workItem !== 'NONE') {
        ids.set(label.workItem, selected.workItemId);
      }
      if (selected?.createdTopic && label.topicRelation === 'new') ids.set(label.topic, selected.resolution.topicId);
      predictions.push({
        entryId: entry.id,
        sessionId: session.id,
        apiFamily: session.apiFamily ?? 'openai-completions',
        ordinal,
        topicId: selected?.resolution.topicId ?? (phase?.contextAnswer === 'lightweight' ? 'NONE' : 'UNKNOWN'),
        workItemId: selected?.resolution.workItemId ?? (phase?.contextAnswer === 'lightweight' ? 'NONE' : 'UNKNOWN'),
        createdTopic: selected?.createdTopic === true,
        createdWorkItem: selected?.createdWorkItem === true,
        relation: selected?.resolution.relation ?? 'unknown',
        deliverable: phase?.contextAnswer ?? phase?.deliverable ?? 'gather',
        context: observedContext,
        contextSatisfied: observedSatisfied,
        resolver: selected?.resolution.resolver ?? 'pending',
      });
      tree.assistant('done');
    }
    return predictions;
  }

  async function replay(source: Corpus = corpus) {
    const predictions: EntryPrediction[] = [];
    const labels = new Map<string, CorpusLabel>();
    for (const session of source.sessions) {
      for (const entry of session.entries) labels.set(entry.id, entry.label);
      predictions.push(...await replaySession(session));
    }
    return { predictions, labels };
  }

  // An evaluation, not a contract: it reports the gates on the local corpus
  // and writes the report and per-entry disagreements next to it.
  it.skipIf(!LOCAL_REPLAY)('reports the release gates on the local session corpus', async () => {
    const local = JSON.parse(readFileSync(LOCAL_CORPUS, 'utf8')) as Corpus;
    const { predictions, labels } = await replay(local);
    const families = Object.fromEntries(scoreByApiFamily(predictions, labels));
    const disagreements = predictions.flatMap((p) => {
      const l = labels.get(p.entryId)!;
      const direction = DIMENSION_STRENGTH[p.deliverable] > DIMENSION_STRENGTH[l.deliverable] ? 'over' : 'under';
      const diff = [
        p.relation !== l.relation ? `relation ${p.relation}≠${l.relation}` : '',
        p.deliverable !== l.deliverable ? `deliverable ${direction} ${p.deliverable}≠${l.deliverable}` : '',
        !sameReasons(p.context, l.context) ? `context ${p.context.join('+') || 'none'}≠${l.context.join('+') || 'none'}` : '',
        sameReasons(p.context, l.context) && p.contextSatisfied !== l.contextSatisfied ? `satisfied ${p.contextSatisfied}≠${l.contextSatisfied}` : '',
      ].filter(Boolean);
      return diff.length > 0 ? [{ entry: p.entryId, resolver: p.resolver, diff }] : [];
    });
    const report = {
      entries: local.sessions.reduce((n, s) => n + s.entries.length, 0),
      replay: {
        gates: correctnessGates(families.all!),
        families,
        disagreements,
        predictions: predictions.map((p) => ({ ...p, label: labels.get(p.entryId) })),
      },
    };
    writeFileSync(join(FIXTURES, 'local', 'sessions-report.json'), JSON.stringify(report, null, 1));
    expect(report.entries).toBeGreaterThan(0);
  }, 3_600_000);

  it('resolves every scenario with no critical false continuation', async () => {
    const { predictions, labels } = await replay();
    const metrics = scoreByApiFamily(predictions, labels).get("all")!;
    // A partial read cannot materialize work; a follow-up cannot claim uncreated work.
    expect(predictions.find((entry) => entry.entryId === 'P1')).toMatchObject({ workItemId: 'UNKNOWN', contextSatisfied: false });
    expect(predictions.find((entry) => entry.entryId === 'P2')).toMatchObject({ workItemId: 'UNKNOWN', relation: 'unknown' });
    expect(predictions.find((entry) => entry.entryId === 'F2')).toMatchObject({ workItemId: 'UNKNOWN', context: ['identity-unresolved'] });
    const contextDisagreements = predictions.filter((prediction) =>
      !sameReasons(prediction.context, labels.get(prediction.entryId)!.context)).map((entry) => entry.entryId);
    // Without an accepted P1 handoff, P2 cannot recover that entry's file obligation.
    expect(contextDisagreements).toEqual(['P2']);
    expect(metrics.entries).toBe(labels.size);
    expect(metrics.criticalFalseContinuation.numerator).toBe(0);
    expect(metrics.workItemAccuracy.value).toBe(1);
    expect(metrics.contextSatisfiedAccuracy.value).toBe(1);
    // A corpus this size cannot show the 0.5% bound.
    expect(correctnessGates(metrics).find((gate) => gate.gate.startsWith('critical'))?.status).toBe('insufficient-evidence');
  }, 60_000);
});
