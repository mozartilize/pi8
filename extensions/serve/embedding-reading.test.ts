/**
 * The embedding reader through the provider: which prompts it reads, and
 * that a thin reading only raises the entry and never takes the fast path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from '@earendil-works/pi-ai';
import { createTempRouterDir } from '../test-support/temp-router-dir.js';
import { registryModel } from '../test-support/router-fixtures.js';
import { asStream, setupProviderTest, type ProviderTestHarness } from '../test-support/provider-harness.js';
import { SessionTree } from '../test-support/session-tree.js';
import { CONTEXT_ENTRY_TYPE } from '../routing/context/persistence.js';
import type { EmbeddingReading } from '../embed/embedding-head.js';
import type { RoutingDecision } from '../types.js';
import { EMBEDDING_THIN_MAX_CHARS, keywordsCannotRead } from './embedding-reading.js';
import { prepareHandoffFacts, submitContextHandoff } from './context-handoff-tool.js';

const embedding = vi.hoisted(() => ({ readPrompt: vi.fn() }));
vi.mock('../embed/embedding.js', () => ({ readPrompt: embedding.readPrompt }));
vi.mock('@earendil-works/pi-ai', async (importOriginal) => ({
  contentText: (await importOriginal<typeof import('@earendil-works/pi-ai')>()).contentText,
  createAssistantMessageEventStream: vi.fn(),
  isRetryableAssistantError: () => false,
}));
vi.mock('@earendil-works/pi-ai/compat', () => ({ streamSimple: vi.fn() }));

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

const reading = (over: Partial<EmbeddingReading> = {}): EmbeddingReading => ({
  thinMargin: 0.05, thin: true, kind: 'gather', kindMargin: 0.002, kindDecided: false, ...over,
});

describe('keywordsCannotRead', () => {
  it.each([
    ['ok làm tiếp đi', true, true],
    ['続けて', false, true],
    ['lorem ipsum', false, true],
    ['ok go ahead', true, false],
    ['fix the auth bug', true, false],
    ['   ', false, false],
  ])('%j (keyword evidence: %s) → %s', (prompt, evidence, expected) => {
    expect(keywordsCannotRead(prompt, evidence)).toBe(expected);
  });

  it('does not count typographic punctuation as a letter the rules cannot read', () => {
    expect(keywordsCannotRead('let’s ship the fix', true)).toBe(false);
  });
});

describe('embedding reader through the provider', () => {
  let temp: ReturnType<typeof createTempRouterDir>;
  let harness: ProviderTestHarness;
  let tree: SessionTree;

  beforeEach(() => {
    temp = createTempRouterDir();
    mkdirSync(join(temp.path, 'repo'), { recursive: true });
    tree = new SessionTree();
    embedding.readPrompt.mockReset();
    embedding.readPrompt.mockResolvedValue(reading({ thin: false, thinMargin: -0.03 }));
  });
  afterEach(async () => {
    const { setDecisionLogBase } = await import('../host/decisionlog.js');
    setDecisionLogBase(undefined);
    vi.restoreAllMocks();
    temp.cleanup();
  });

  async function setup(config?: Record<string, unknown>) {
    harness = await setupProviderTest({
      dir: temp.path,
      ...(config ? { config } : {}),
      benchmarks: BENCHMARKS as never,
      models: MODELS,
      ctx: { cwd: join(temp.path, 'repo'), sessionManager: tree.manager() } as never,
    });
    harness.session.context.bindPersistence((event) => tree.appendEntry(CONTEXT_ENTRY_TYPE, event));
    harness.scriptReply(() => asStream([{ type: 'text_delta', delta: 'served' }, { type: 'done' }]));
  }

  function messages() {
    return tree.getBranch()
      .filter((e) => e.type === 'message')
      .map((e) => ({ role: e.message!.role, content: e.message!.content, timestamp: e.message!.timestamp }));
  }

  async function entry(prompt: string): Promise<RoutingDecision> {
    tree.user(prompt, Date.now() + tree.getBranch().length);
    harness.resetEventStream();
    await harness.serve({ messages: messages() } as unknown as Context);
    tree.assistant('done');
    return harness.getProviderState().lastDecision!;
  }

  /** An implementation entry whose work item is then closed, so no item carries the next one. */
  async function implementThenClose(): Promise<void> {
    const first = await entry('implement the CSV export command');
    expect(first.dimension).toBe('gather');
    const params = { outcome: 'ready', deliverable: 'implement', workItemId: 'NEW_WORK_ITEM',
      topicId: 'NEW_TOPIC', topicTitle: 'CSV export', workItemTitle: 'Implement the export',
      findings: 'requirements checked', question: 'implement the export' };
    const ctx = { cwd: join(temp.path, 'repo'), model: { provider: 'router', id: 'auto' }, sessionManager: tree.manager() } as never;
    const facts = await prepareHandoffFacts(params, ctx, harness.session, async () => ({ stdout: '', stderr: '', code: 0 }) as never);
    expect(submitContextHandoff(params, ctx, harness.session, facts).accepted).toBe(true);
    const itemId = harness.session.getWorkPhaseState()!.workItemId!;
    harness.session.context.append({ v: 1, op: 'work-close', workItemId: itemId, status: 'done', sourceEntryId: 'x' });
  }

  it('carries a non-English follow-up read as thin at the previous entry\'s task type, without new work', async () => {
    await setup({ embeddingClassifier: true });
    await implementThenClose();
    embedding.readPrompt.mockResolvedValue(reading());
    const items = harness.session.context.getLedger().items.size;

    const next = await entry('ok làm tiếp đi');
    expect(next).toMatchObject({ dimension: 'gather', cause: 'investigation', deliverable: 'implement' });
    expect(next.workContext).toBeUndefined();
    expect(harness.session.getWorkPhaseState()?.pendingIdentity).toBeDefined();
    expect(next.embedding).toMatchObject({ thin: true, thinMargin: 0.05 });
    expect(harness.session.context.getLedger().items.size).toBe(items);
    expect(harness.session.getEmbeddingStats()).toMatchObject({ read: 1, thin: 1 });
  });

  it('starts new work at the keyword task type when the reader is off', async () => {
    await setup();
    await implementThenClose();
    const next = await entry('ok làm tiếp đi');
    expect(embedding.readPrompt).not.toHaveBeenCalled();
    expect(next.workContext).toBeUndefined();
    expect(harness.session.getWorkPhaseState()?.pendingIdentity).toBeDefined();
    expect(next.dimension).not.toBe('implement');
  });

  it('never takes the fast path on a thin reading: work stays unresolved until handoff', async () => {
    await setup({ embeddingClassifier: true });
    await entry('implement the CSV export command');
    embedding.readPrompt.mockResolvedValue(reading());

    const next = await entry('ok làm tiếp đi');
    expect(next.workContext).toBeUndefined();
    expect(harness.session.getWorkPhaseState()?.pendingIdentity).toBeDefined();
    expect(next.embedding?.thin).toBe(true);
  });

  it('applies a delayed thin reading before creating a work choice', async () => {
    await setup({ embeddingClassifier: true });
    await implementThenClose();
    let resolved = false;
    embedding.readPrompt.mockImplementation(() => new Promise<EmbeddingReading>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolved = true;
        resolve(reading());
      };
      // Bounds a reading that waits for nothing, so a serial read fails the
      // assertion below instead of hanging.
      const timer = setTimeout(done, 10);
    }));
    const next = await entry('ok làm tiếp đi');
    expect(resolved).toBe(true);
    expect(next.workContext).toBeUndefined();
    expect(next.embedding?.thin).toBe(true);
    expect(harness.session.getEmbeddingStats()).toMatchObject({ read: 1, thin: 1 });
  });

  it('leaves prompts the English rules read to the rules', async () => {
    await setup({ embeddingClassifier: true });
    await entry('implement the CSV export command');
    const next = await entry('ok go ahead');
    expect(embedding.readPrompt).not.toHaveBeenCalled();
    expect(next.workContext).toBeUndefined();
    expect(next.embedding).toBeUndefined();
  });

  it('does not treat a reading below the margin, or a long prompt, as thin', async () => {
    await setup({ embeddingClassifier: true });
    await implementThenClose();
    embedding.readPrompt.mockResolvedValue(reading({ thin: false, thinMargin: 0.01 }));
    const weak = await entry('ok làm tiếp đi');
    expect(weak.workContext).toBeUndefined();
    expect(weak.embedding).toMatchObject({ thinMargin: 0.01 });
    expect(weak.embedding?.thin).toBeUndefined();

    embedding.readPrompt.mockResolvedValue(reading());
    const long = await entry(`làm tiếp ${'phần xuất dữ liệu '.repeat(4)}`);
    expect(long.workContext).toBeUndefined();
    expect(`làm tiếp ${'phần xuất dữ liệu '.repeat(4)}`.trim().length).toBeGreaterThan(EMBEDDING_THIN_MAX_CHARS);
    expect(long.embedding?.thin).toBeUndefined();
  });

  it('routes as the keyword rules read it when the reader fails', async () => {
    await setup({ embeddingClassifier: true });
    await implementThenClose();
    embedding.readPrompt.mockResolvedValue(undefined);
    const next = await entry('ok làm tiếp đi');
    expect(next.workContext).toBeUndefined();
    expect(next.embedding).toBeUndefined();
    expect(harness.session.getEmbeddingStats()).toMatchObject({ read: 0, failed: 1 });
  });

  it('reads an entry once and keeps the reading through its tool loop', async () => {
    await setup({ embeddingClassifier: true });
    await implementThenClose();
    embedding.readPrompt.mockResolvedValue(reading());
    const first = await entry('ok làm tiếp đi');
    harness.resetEventStream();
    await harness.serve({
      messages: [
        ...messages(),
        { role: 'assistant', content: [{ type: 'toolCall', id: 't', name: 'read', arguments: {} }], timestamp: Date.now() + 50 },
        { role: 'toolResult', toolCallId: 't', toolName: 'read', content: [{ type: 'text', text: 'x' }], timestamp: Date.now() + 51 },
      ],
    } as unknown as Context);
    const second = harness.getProviderState().lastDecision!;
    expect(embedding.readPrompt).toHaveBeenCalledTimes(1);
    expect(second.embedding).toEqual(first.embedding);
    expect(second.dimension).toBe(first.dimension);
  });

  it('raises the entry\'s final step to a decided, stronger kind and never lowers it', async () => {
    await setup({ embeddingClassifier: true });
    embedding.readPrompt.mockResolvedValue(reading({ thin: false, thinMargin: -0.02, kind: 'plan', kindMargin: 0.02, kindDecided: true }));
    const raised = await entry('thiết kế kiến trúc cho dịch vụ đồng bộ');
    expect(raised.embedding).toMatchObject({ kind: 'plan', kindRaised: true });
    expect(harness.session.getWorkPhaseState()?.terminal.kind).toBe('plan');
    expect(harness.session.getEmbeddingStats()).toMatchObject({ kindRaised: 1 });

    embedding.readPrompt.mockResolvedValue(reading({ thin: false, thinMargin: -0.02, kind: 'lightweight', kindMargin: 0.05, kindDecided: true }));
    const weaker = await entry('sửa lỗi đăng nhập trong module xác thực');
    expect(weaker.embedding?.kindRaised).toBeUndefined();
    expect(harness.session.getWorkPhaseState()?.terminal.kind).toBe('gather');

    embedding.readPrompt.mockResolvedValue(reading({ thin: false, thinMargin: -0.02, kind: 'plan', kindMargin: 0.004, kindDecided: false }));
    const undecided = await entry('đề xuất phương án tách hệ thống');
    expect(undecided.embedding?.kindRaised).toBeUndefined();
  });

  it('logs the reading\'s margins and categories, never the prompt', async () => {
    await setup({ embeddingClassifier: true });
    await implementThenClose();
    embedding.readPrompt.mockResolvedValue(reading());
    await entry('ok làm tiếp đi, phần báo cáo tháng');
    const raw = readFileSync(join(temp.path, 'decisions.jsonl'), 'utf8');
    expect(raw).toContain('"embedding"');
    expect(raw).not.toContain('báo cáo');
  });
});
