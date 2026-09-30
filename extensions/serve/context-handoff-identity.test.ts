import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from '@earendil-works/pi-ai';
import { createTempRouterDir } from '../test-support/temp-router-dir.js';
import { registryModel } from '../test-support/router-fixtures.js';
import { setupProviderTest, type ProviderTestHarness } from '../test-support/provider-harness.js';
import { SessionTree } from '../test-support/session-tree.js';
import { CONTEXT_ENTRY_TYPE } from '../routing/context/persistence.js';
import { observeContextGrounding } from './context-grounding.js';
import { investigationNote, prepareHandoffFacts, submitContextHandoff } from './context-handoff-tool.js';

vi.mock('@earendil-works/pi-ai', async (importOriginal) => ({
  contentText: (await importOriginal<typeof import('@earendil-works/pi-ai')>()).contentText,
  createAssistantMessageEventStream: vi.fn(),
  isRetryableAssistantError: () => false,
}));
vi.mock('@earendil-works/pi-ai/compat', () => ({ streamSimple: vi.fn() }));

const BENCHMARKS = [{
  registryId: 'alpha/cheap', benchSlug: 'alpha-cheap', active: true,
  quality: { intelligence: 0.5, coding: 0.5, agenticCoding: 0.5 },
  priceInputPer1M: 0.1, priceOutputPer1M: 0.2, source: 'test',
}];
const MODEL = registryModel('alpha/cheap', {
  contextWindow: 200000, maxTokens: 8192,
  cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
});
const READY = {
  outcome: 'ready', deliverable: 'implement', findings: 'checked the request', question: 'implement the change',
};

describe('entry-scoped work choice at the context handoff', () => {
  let temp: ReturnType<typeof createTempRouterDir>;
  let harness: ProviderTestHarness;
  let tree: SessionTree;
  let cwd: string;
  let routerCtx: { cwd: string; model: { provider: string; id: string }; sessionManager: ReturnType<SessionTree['manager']> };
  beforeEach(async () => {
    temp = createTempRouterDir();
    cwd = join(temp.path, 'repo');
    mkdirSync(join(cwd, 'requirements'), { recursive: true });
    writeFileSync(join(cwd, 'requirements', 'foo.md'), 'CSV header\n');
    tree = new SessionTree();
    routerCtx = { cwd, model: { provider: 'router', id: 'auto' }, sessionManager: tree.manager() };
    harness = await setupProviderTest({ dir: temp.path, benchmarks: BENCHMARKS as never,
      models: [MODEL], ctx: routerCtx as never });
    harness.session.context.bindPersistence((event) => tree.appendEntry(CONTEXT_ENTRY_TYPE, event));
    harness.scriptReply([{ type: 'text_delta', delta: 'served' }, { type: 'done' }]);
  });
  afterEach(() => { vi.restoreAllMocks(); temp.cleanup(); });

  async function entry(prompt: string) {
    tree.user(prompt, Date.now() + tree.getBranch().length);
    const messages = tree.getBranch().filter((event) => event.type === 'message')
      .map((event) => ({ role: event.message!.role, content: event.message!.content, timestamp: event.message!.timestamp }));
    harness.resetEventStream();
    await harness.serve({ messages } as unknown as Context);
    return harness.getProviderState().lastDecision!;
  }
  async function handoff(params: Record<string, unknown>) {
    const facts = await prepareHandoffFacts(params, routerCtx as never, harness.session, async () => ({ stdout: '', stderr: '', code: 0 }) as never);
    return submitContextHandoff(params, routerCtx as never, harness.session, facts);
  }

  it('routes an unresolved entry without a work event, then creates work only on an accepted handoff', async () => {
    const first = await entry('implement a CSV exporter');
    expect(first).toMatchObject({ dimension: 'gather', cause: 'investigation' });
    expect(first.workContext).toBeUndefined();
    expect(harness.session.context.getLedger().items.size).toBe(0);
    expect(investigationNote(harness.session.getWorkPhaseState()!)).toContain('NEW_WORK_ITEM');
    expect((await handoff({ ...READY, workItemId: 'made-up', topicId: 'NEW_TOPIC', topicTitle: 'Export' })).accepted).toBe(false);
    expect(harness.session.context.getLedger().items.size).toBe(0);
    expect((await handoff({ ...READY, workItemId: 'NEW_WORK_ITEM', topicId: 'NEW_TOPIC',
      topicTitle: 'Export', workItemTitle: 'CSV exporter' })).accepted).toBe(true);
    const item = [...harness.session.context.getLedger().items.values()][0]!;
    expect(item).toMatchObject({ title: 'CSV exporter' });
    const records = tree.getBranch().filter((event) => event.type === 'custom' && event.customType === CONTEXT_ENTRY_TYPE);
    expect(records).toHaveLength(1);
    expect(records[0]?.data).toMatchObject({ op: 'context-commit', events: [
      { op: 'work-create' }, { op: 'activate' }, { op: 'boundary' },
    ] });
    harness.session.context.restore(tree.getBranch());
    expect(harness.session.context.getLedger().activeWorkItemId).toBe(item.id);
    expect(harness.session.context.getLedger().items.get(item.id)?.openContext).toEqual([]);
    const next = await entry('implement it');
    expect(next.workContext).toMatchObject({ resolver: 'deterministic', relation: 'continue', workItemId: item.id });
  });

  it('keeps manual-pinned unresolved work provisional until an accepted handoff', async () => {
    harness.session.setManualModel('alpha/cheap');
    const first = await entry('@requirements/foo.md implement the exporter');
    expect(first.dimension).toBe('gather');
    expect(harness.session.getWorkPhaseState()?.pendingIdentity).toBeDefined();
    expect(harness.session.context.getLedger().items.size).toBe(0);
    await observeContextGrounding({ toolName: 'read', input: { path: 'requirements/foo.md' },
      content: [{ type: 'text', text: 'CSV header\n' }], isError: false } as never,
    routerCtx as never, harness.session);
    expect((await handoff({ ...READY, workItemId: 'NEW_WORK_ITEM', topicTitle: 'Export',
      workItemTitle: 'CSV exporter' })).accepted).toBe(true);
    expect(harness.session.context.getLedger().items.size).toBe(1);
  });

  it('leaves no selected work when a ready boundary cannot persist', async () => {
    await entry('implement a CSV exporter');
    harness.session.context.bindPersistence((event) => {
      if (event.op === 'context-commit' && event.events.some((inner) => inner.op === 'boundary')) {
        throw new Error('boundary storage unavailable');
      }
      tree.appendEntry(CONTEXT_ENTRY_TYPE, event);
    });
    const response = await handoff({ ...READY, workItemId: 'NEW_WORK_ITEM',
      topicTitle: 'Export', workItemTitle: 'CSV exporter' });
    expect(response.accepted).toBe(false);
    expect(harness.session.context.getLedger().items.size).toBe(0);
    expect(harness.session.context.getLedger().activeWorkItemId).toBeUndefined();
    expect(tree.getBranch().filter((event) => event.type === 'custom' && event.customType === CONTEXT_ENTRY_TYPE)).toEqual([]);
  });

  it('requires an entry-local complete read before creating work with a referenced file', async () => {
    await entry('@requirements/foo.md implement the exporter');
    const params = { ...READY, workItemId: 'NEW_WORK_ITEM', topicId: 'NEW_TOPIC',
      topicTitle: 'Export', workItemTitle: 'CSV exporter' };
    const denied = await handoff(params);
    expect(denied.accepted).toBe(false);
    expect(denied.text).toContain('requirements/foo.md');
    await observeContextGrounding({ toolName: 'read', input: { path: 'requirements/foo.md' },
      content: [{ type: 'text', text: 'CSV header\n' }], isError: false } as never,
    routerCtx as never, harness.session);
    expect(harness.session.context.getLedger().items.size).toBe(0);
    expect(harness.session.getWorkPhaseState()?.provisionalGrounding).toHaveLength(1);
    expect((await handoff(params)).accepted).toBe(true);
    const item = [...harness.session.context.getLedger().items.values()][0]!;
    expect(item.grounding).toHaveLength(1);
    expect(item.grounding[0]!.anchorValue).toBe('requirements/foo.md');
  });

  it('does not treat pasted artifact contents as a router-observed read', async () => {
    await entry('@requirements/foo.md implement the importer. Full contents: CSV header');
    const params = { ...READY, workItemId: 'NEW_WORK_ITEM', topicTitle: 'Import', workItemTitle: 'Importer' };
    expect(harness.session.getWorkPhaseState()?.provisionalGrounding).toBeUndefined();
    expect((await handoff(params)).accepted).toBe(false);
    expect(harness.session.context.getLedger().items.size).toBe(0);
    await observeContextGrounding({ toolName: 'read', input: { path: 'requirements/foo.md' },
      content: [{ type: 'text', text: 'CSV header\n' }], isError: false } as never,
    routerCtx as never, harness.session);
    expect((await handoff(params)).accepted).toBe(true);
  });

  it('keeps an existing work item unchanged when its selection cannot persist', async () => {
    await entry('implement a CSV exporter');
    expect((await handoff({ ...READY, workItemId: 'NEW_WORK_ITEM', topicTitle: 'Export',
      workItemTitle: 'CSV exporter' })).accepted).toBe(true);
    const original = [...harness.session.context.getLedger().items.values()][0]!;
    await entry('@requirements/foo.md extend the exporter');
    await observeContextGrounding({ toolName: 'read', input: { path: 'requirements/foo.md' },
      content: [{ type: 'text', text: 'CSV header\n' }], isError: false } as never,
    routerCtx as never, harness.session);
    const persisted = tree.getBranch().filter((event) => event.type === 'custom' && event.customType === CONTEXT_ENTRY_TYPE).length;
    harness.session.context.bindPersistence((event) => {
      if (event.op === 'context-commit' && event.events.some((inner) => inner.op === 'grounding-upsert')) {
        throw new Error('storage unavailable');
      }
      tree.appendEntry(CONTEXT_ENTRY_TYPE, event);
    });
    const rejected = await handoff({ ...READY, workItemId: original.id });
    expect(rejected.accepted).toBe(false);
    expect(harness.session.context.getLedger().items.get(original.id)).toEqual(original);
    expect(harness.session.getWorkPhaseState()?.pendingIdentity).toBeDefined();
    expect(tree.getBranch().filter((event) => event.type === 'custom' && event.customType === CONTEXT_ENTRY_TYPE)).toHaveLength(persisted);
  });

  it('does not credit provisional reads to the previous active work item', async () => {
    await entry('implement a CSV exporter');
    expect((await handoff({ ...READY, workItemId: 'NEW_WORK_ITEM', topicTitle: 'Export', workItemTitle: 'CSV exporter' })).accepted).toBe(true);
    const original = [...harness.session.context.getLedger().items.values()][0]!;
    await entry('@requirements/foo.md review the database backup');
    await observeContextGrounding({ toolName: 'read', input: { path: 'requirements/foo.md' },
      content: [{ type: 'text', text: 'CSV header\n' }], isError: false } as never,
    routerCtx as never, harness.session);
    expect(harness.session.context.getLedger().items.get(original.id)?.grounding).toHaveLength(0);
    expect(harness.session.getWorkPhaseState()?.provisionalGrounding).toHaveLength(1);
  });

  it('only accepts listed work and topic ids and can start another work item in a listed topic', async () => {
    await entry('implement a CSV exporter');
    expect((await handoff({ ...READY, workItemId: 'NEW_WORK_ITEM', topicTitle: 'Export', workItemTitle: 'CSV exporter' })).accepted).toBe(true);
    const original = [...harness.session.context.getLedger().items.values()][0]!;
    await entry('review error handling in the exporter');
    const pending = harness.session.getWorkPhaseState()!.pendingIdentity!;
    expect(pending.catalog.workItems.map((item) => item.id)).toContain(original.id);
    expect(investigationNote(harness.session.getWorkPhaseState()!)).toContain(original.id);
    expect((await handoff({ ...READY, deliverable: 'review', workItemId: original.id,
      topicId: 'fabricated-topic' })).accepted).toBe(false);
    const second = await handoff({ ...READY, deliverable: 'review', workItemId: 'NEW_WORK_ITEM',
      topicId: original.topic.id, workItemTitle: 'Error review' });
    expect(second).toMatchObject({ accepted: true });
    const created = [...harness.session.context.getLedger().items.values()].find((item) => item.id !== original.id)!;
    expect(created).toMatchObject({ title: 'Error review', topic: { id: original.topic.id } });
    expect(harness.session.context.getLedger().items.size).toBe(2);
  });

  it('derives new, switch, and resume relations from selected work', async () => {
    await entry('implement a CSV exporter');
    expect((await handoff({ ...READY, workItemId: 'NEW_WORK_ITEM', topicTitle: 'Export',
      workItemTitle: 'CSV exporter' })).accepted).toBe(true);
    const original = [...harness.session.context.getLedger().items.values()][0]!;
    expect(harness.session.getWorkPhaseState()?.contextResolution?.relation).toBe('new');

    await entry('implement a separate importer');
    expect((await handoff({ ...READY, workItemId: 'NEW_WORK_ITEM', topicId: original.topic.id,
      workItemTitle: 'Importer' })).accepted).toBe(true);
    expect(harness.session.getWorkPhaseState()?.contextResolution?.relation).toBe('new');

    await entry('implement a backup scheduler');
    expect((await handoff({ ...READY, workItemId: 'NEW_WORK_ITEM', topicId: 'NEW_TOPIC',
      topicTitle: 'Backup', workItemTitle: 'Backup scheduler' })).accepted).toBe(true);
    expect(harness.session.getWorkPhaseState()?.contextResolution?.relation).toBe('switch');

    await entry('update the CSV exporter');
    expect((await handoff({ ...READY, workItemId: original.id })).accepted).toBe(true);
    expect(harness.session.getWorkPhaseState()?.contextResolution).toMatchObject({
      relation: 'resume', workItemId: original.id,
    });
    expect(harness.session.context.getLedger().items.size).toBe(3);
  });

  it('accepts NONE only for a lightweight side question', async () => {
    await entry('hello');
    expect((await handoff({ ...READY, workItemId: 'NONE' })).accepted).toBe(false);
    expect((await handoff({ ...READY, deliverable: 'lightweight', scope: 'bounded', workItemId: 'NONE' })).accepted).toBe(true);
    expect(harness.session.context.getLedger().items.size).toBe(0);
    expect(harness.session.getWorkPhaseState()?.pendingIdentity).toBeUndefined();
  });

  it('offers earlier unrouted work as a bounded choice without inheriting grounding', async () => {
    tree.modelChange('openai', 'manual');
    const old = tree.user('design the CSV exporter before the router existed');
    tree.assistant('The exporter should use headers.');
    tree.modelChange('router', 'auto');
    await entry('continue designing the CSV exporter');
    const pending = harness.session.getWorkPhaseState()?.pendingIdentity;
    expect(pending?.legacy.length).toBeGreaterThan(0);
    expect(investigationNote(harness.session.getWorkPhaseState()!)).toContain(pending!.legacy[0]!.id);
    const result = await handoff({ ...READY, deliverable: 'plan', workItemId: pending!.legacy[0]!.id,
      topicId: 'NEW_TOPIC', topicTitle: 'Export' });
    expect(result).toMatchObject({ accepted: true });
    const item = [...harness.session.context.getLedger().items.values()][0]!;
    expect(item).toMatchObject({ legacySourceEntryId: old });
    expect(item.grounding).toEqual([]);
  });

  it('does not attach a new task to active work because both name the same file', async () => {
    await entry('implement a CSV exporter');
    expect((await handoff({ ...READY, workItemId: 'NEW_WORK_ITEM', topicTitle: 'Export', workItemTitle: 'CSV exporter' })).accepted).toBe(true);
    const original = [...harness.session.context.getLedger().items.values()][0]!;
    await entry('@requirements/foo.md implement a different importer');
    expect(harness.session.getWorkPhaseState()?.workItemId).toBeUndefined();
    expect(harness.session.getWorkPhaseState()?.pendingIdentity?.catalog.workItems.map((item) => item.id)).toContain(original.id);
    expect((await handoff({ ...READY, workItemId: 'NEW_WORK_ITEM', topicId: original.topic.id,
      workItemTitle: 'Importer' })).accepted).toBe(false);
    await observeContextGrounding({ toolName: 'read', input: { path: 'requirements/foo.md' },
      content: [{ type: 'text', text: 'CSV header\n' }], isError: false } as never,
    routerCtx as never, harness.session);
    expect((await handoff({ ...READY, workItemId: 'NEW_WORK_ITEM', topicId: original.topic.id,
      workItemTitle: 'Importer' })).accepted).toBe(true);
    expect(harness.session.context.getLedger().items.size).toBe(2);
  });

  it('does not inherit an earlier item’s identity from a thin prompt without a fast-path match', async () => {
    await entry('implement a CSV exporter');
    expect((await handoff({ ...READY, workItemId: 'NEW_WORK_ITEM', topicTitle: 'Export', workItemTitle: 'CSV exporter' })).accepted).toBe(true);
    const original = [...harness.session.context.getLedger().items.values()][0]!;
    await entry('@requirements/foo.md implement a separate parser');
    await entry('ok go ahead');
    expect(harness.session.getWorkPhaseState()?.pendingIdentity).toBeDefined();
    expect(harness.session.getWorkPhaseState()?.workItemId).toBeUndefined();
    expect(harness.session.context.getLedger().items.size).toBe(1);
    expect(harness.session.context.getLedger().items.get(original.id)?.grounding).toEqual([]);
  });

  it('rejects a read when its file changes before the work is chosen', async () => {
    await entry('@requirements/foo.md implement a CSV exporter');
    await observeContextGrounding({ toolName: 'read', input: { path: 'requirements/foo.md' },
      content: [{ type: 'text', text: 'CSV header\n' }], isError: false } as never,
    routerCtx as never, harness.session);
    writeFileSync(join(cwd, 'requirements', 'foo.md'), 'different header\n');
    const response = await handoff({ ...READY, workItemId: 'NEW_WORK_ITEM',
      topicTitle: 'Export', workItemTitle: 'CSV exporter' });
    expect(response).toMatchObject({ accepted: false });
    expect(response.text).toContain('requirements/foo.md');
    expect(harness.session.context.getLedger().items.size).toBe(0);
  });

  it('rejects a choice made for a prior session generation', async () => {
    await entry('implement a CSV exporter');
    const params = { ...READY, workItemId: 'NEW_WORK_ITEM', topicTitle: 'Export', workItemTitle: 'CSV exporter' };
    const facts = await prepareHandoffFacts(params, routerCtx as never, harness.session, async () => ({ stdout: '', stderr: '', code: 0 }) as never);
    harness.session.reset();
    expect(submitContextHandoff(params, routerCtx as never, harness.session, facts).accepted).toBe(false);
    expect(harness.session.context.getLedger().items.size).toBe(0);
  });
});
