/** Work-context resolution through the provider and its handoff boundary. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from '@earendil-works/pi-ai';
import { createTempRouterDir } from '../test-support/temp-router-dir.js';
import { registryModel } from '../test-support/router-fixtures.js';
import { setupProviderTest, type ProviderTestHarness } from '../test-support/provider-harness.js';
import { SessionTree } from '../test-support/session-tree.js';
import { branchEvents, CONTEXT_ENTRY_TYPE } from '../routing/context/persistence.js';
import { AUTO_MODEL_ID, ROUTER_PROVIDER_ID, type RoutingDecision } from '../types.js';
import { carryPhaseAcrossTree } from './context-resolution.js';
import { observeContextGrounding } from './context-grounding.js';
import { prepareHandoffFacts, submitContextHandoff } from './context-handoff-tool.js';
import { closeContextOnSettle } from './gathering-gate.js';

vi.mock('@earendil-works/pi-ai', async (importOriginal) => ({
  contentText: (await importOriginal<typeof import('@earendil-works/pi-ai')>()).contentText,
  createAssistantMessageEventStream: vi.fn(),
  isRetryableAssistantError: () => false,
}));
vi.mock('@earendil-works/pi-ai/compat', () => ({ streamSimple: vi.fn() }));

const BENCHMARKS = [
  { registryId: 'alpha/cheap', benchSlug: 'alpha-cheap', active: true,
    quality: { intelligence: 0.5, coding: 0.5, agenticCoding: 0.5 },
    priceInputPer1M: 0.1, priceOutputPer1M: 0.2, source: 'test' },
  { registryId: 'beta/strong', benchSlug: 'beta-strong', active: true,
    quality: { intelligence: 0.9, coding: 0.9, agenticCoding: 0.9 },
    priceInputPer1M: 2, priceOutputPer1M: 8, source: 'test' },
];
const MODELS = [
  registryModel('alpha/cheap', { contextWindow: 200000, maxTokens: 8192,
    cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 } }),
  registryModel('beta/strong', { contextWindow: 200000, maxTokens: 8192,
    cost: { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 } }),
];
const READY = { outcome: 'ready', deliverable: 'implement', complexity: 'trivial', scope: 'bounded', findings: 'checked the request', question: 'implement the change' };

describe('work-context resolution through the provider', () => {
  let temp: ReturnType<typeof createTempRouterDir>;
  let harness: ProviderTestHarness;
  let tree: SessionTree;
  let cwd: string;
  let routerCtx: { cwd: string; model: { provider: string; id: string }; sessionManager: ReturnType<SessionTree['manager']> };

  beforeEach(() => {
    temp = createTempRouterDir();
    cwd = join(temp.path, 'repo');
    mkdirSync(join(cwd, 'requirements'), { recursive: true });
    writeFileSync(join(cwd, 'requirements', 'foo.md'), 'CSV with a header row\n');
    tree = new SessionTree();
    routerCtx = { cwd, model: { provider: ROUTER_PROVIDER_ID, id: AUTO_MODEL_ID }, sessionManager: tree.manager() };
  });
  afterEach(() => { vi.restoreAllMocks(); temp.cleanup(); });

  async function setup() {
    harness = await setupProviderTest({ dir: temp.path, benchmarks: BENCHMARKS as never,
      models: MODELS, ctx: routerCtx as never });
    harness.session.context.bindPersistence((event) => tree.appendEntry(CONTEXT_ENTRY_TYPE, event));
    harness.scriptReply([{ type: 'text_delta', delta: 'served' }, { type: 'done' }]);
  }

  async function serveBranch(): Promise<RoutingDecision> {
    const messages = tree.getBranch().filter((e) => e.type === 'message')
      .map((e) => ({ role: e.message!.role, content: e.message!.content, timestamp: e.message!.timestamp }));
    harness.resetEventStream();
    await harness.serve({ messages } as unknown as Context);
    return harness.getProviderState().lastDecision!;
  }
  async function entry(prompt: string): Promise<RoutingDecision> {
    tree.user(prompt, Date.now() + tree.getBranch().length);
    const decision = await serveBranch();
    tree.assistant('done');
    return decision;
  }
  async function handoff(params: Record<string, unknown>) {
    const facts = await prepareHandoffFacts(params, routerCtx as never, harness.session,
      async () => ({ stdout: '', stderr: '', code: 0 }) as never);
    return submitContextHandoff(params, routerCtx as never, harness.session, facts);
  }
  async function groundFile() {
    await observeContextGrounding({ toolName: 'read', input: { path: 'requirements/foo.md' },
      content: [{ type: 'text', text: readFileSync(join(cwd, 'requirements', 'foo.md'), 'utf8') }], isError: false } as never,
    routerCtx as never, harness.session);
  }
  async function createItem(prompt = 'implement a CSV exporter') {
    await entry(prompt);
    const accepted = await handoff({ ...READY, workItemId: 'NEW_WORK_ITEM', topicTitle: 'Export', workItemTitle: 'CSV exporter' });
    expect(accepted.accepted).toBe(true);
    return [...harness.session.context.getLedger().items.values()][0]!;
  }
  const ledgerEvents = () => branchEvents(tree.getBranch()).map((event) => event.op);

  it('collects an unresolved request until a handoff selects work', async () => {
    await setup();
    const first = await entry('@requirements/foo.md implement this');
    expect(first).toMatchObject({ dimension: 'gather', cause: 'investigation', deliverable: 'gather' });
    expect(first.workContext).toBeUndefined();
    expect(ledgerEvents()).toEqual([]);
  });

  it('offers the selected work item to the next entry, which continues it only at a handoff', async () => {
    await setup();
    const item = await createItem();
    const next = await entry('implement it');
    expect(next.workContext).toBeUndefined();
    expect(harness.session.getWorkPhaseState()?.pendingIdentity?.catalog.workItems.map((w) => w.id)).toContain(item.id);
    expect((await handoff({ ...READY, workItemId: item.id })).accepted).toBe(true);
    expect(harness.session.getCachedIntent()?.context?.resolution).toMatchObject({ workItemId: item.id, relation: 'continue' });
  });

  it('requires a selected work item’s changed referenced file to be read again at the handoff', async () => {
    await setup();
    await entry('@requirements/foo.md implement this');
    await groundFile();
    expect((await handoff({ ...READY, workItemId: 'NEW_WORK_ITEM', topicTitle: 'Export',
      workItemTitle: 'CSV exporter' })).accepted).toBe(true);
    const id = harness.session.context.getLedger().activeWorkItemId!;
    writeFileSync(join(cwd, 'requirements', 'foo.md'), 'TSV without a header row\n');
    expect(await entry('implement it')).toMatchObject({ dimension: 'gather', cause: 'investigation' });
    const declined = await handoff({ ...READY, workItemId: id });
    expect(declined.accepted).toBe(false);
    expect(declined.text).toContain('requirements/foo.md');
    await groundFile();
    expect((await handoff({ ...READY, workItemId: id })).accepted).toBe(true);
    expect(harness.session.getCachedIntent()?.context?.resolution.contextReasons).toEqual(['referenced-artifact']);
  });

  it('restores the incumbent on resume and serves the next entry with it', async () => {
    await setup();
    await createItem();
    await serveBranch();
    const incumbent = harness.session.context.getIncumbent();
    expect(incumbent).toBeDefined();
    expect(ledgerEvents()).toContain('incumbent');
    // A resumed session starts empty and restores the branch.
    harness.session.reset();
    harness.session.context.restore(tree.getBranch());
    const next = await entry('ok go ahead');
    expect(next.chosen.startsWith(incumbent!.registryId)).toBe(true);
    expect(harness.session.getWorkPhaseState()?.contextStatus).toBeUndefined();
  });

  it('serves a follow-up by the incumbent, which reads a changed file itself', async () => {
    await setup();
    await entry('@requirements/foo.md implement this');
    await groundFile();
    expect((await handoff({ ...READY, workItemId: 'NEW_WORK_ITEM', topicTitle: 'Export',
      workItemTitle: 'CSV exporter' })).accepted).toBe(true);
    await serveBranch();
    const incumbent = harness.session.context.getIncumbent();
    expect(incumbent).toBeDefined();
    writeFileSync(join(cwd, 'requirements', 'foo.md'), 'TSV without a header row\n');
    const next = await entry('implement it');
    expect(next.cause).not.toBe('investigation');
    expect(next.chosen.startsWith(incumbent!.registryId)).toBe(true);
    expect(harness.session.getWorkPhaseState()?.contextStatus).toBeUndefined();
  });

  it('closes a directory investigation at the handoff without inventing file grounding', async () => {
    await setup();
    expect(await entry('@requirements/ implement the exporter')).toMatchObject({ dimension: 'gather' });
    expect((await handoff({ ...READY, workItemId: 'NEW_WORK_ITEM', topicTitle: 'Export',
      workItemTitle: 'CSV exporter' })).accepted).toBe(true);
    const item = [...harness.session.context.getLedger().items.values()][0]!;
    expect(item.grounding).toEqual([]);
    expect(item.openContext).toEqual([]);
  });

  it('keeps a needs-user outcome out of the work ledger and out of missed-handoff recovery', async () => {
    await setup();
    await entry('review the retry logic in the exporter');
    expect((await handoff({ outcome: 'needs-user', question: 'Which exporter?' })).accepted).toBe(true);
    closeContextOnSettle(harness.session);
    expect(harness.session.context.getLedger().items.size).toBe(0);
    expect(harness.session.getWorkPhaseState()?.contextStatus).toBe('clarification-only');
  });

  it('carries execution penalties only when an entry continues the selected work item', async () => {
    await setup();
    const item = await createItem();
    harness.session.commitWorkPhaseState({ ...harness.session.getWorkPhaseState()!,
      contractStrikes: { 'beta/strong': 1 } });
    await entry('implement it');
    expect(harness.session.getWorkPhaseState()?.contractStrikes).toBeUndefined();
    expect((await handoff({ ...READY, workItemId: item.id })).accepted).toBe(true);
    expect(harness.session.getWorkPhaseState()?.contractStrikes).toEqual({ 'beta/strong': 1 });
    await entry('@requirements/foo.md implement a backup check');
    await groundFile();
    expect((await handoff({ ...READY, workItemId: 'NEW_WORK_ITEM', topicTitle: 'Backups',
      workItemTitle: 'Backup check' })).accepted).toBe(true);
    expect(harness.session.getWorkPhaseState()?.contractStrikes).toBeUndefined();
  });

  it('carries no old work identity or penalties across /tree', async () => {
    await setup();
    await createItem();
    harness.session.commitWorkPhaseState({ ...harness.session.getWorkPhaseState()!,
      contractStrikes: { 'beta/strong': 2 }, excludedExecutors: ['beta/strong'] });
    tree.navigate(null);
    harness.session.context.restore(tree.getBranch());
    carryPhaseAcrossTree(harness.session, tree.getBranch());
    await entry('ok go ahead');
    const state = harness.session.getWorkPhaseState()!;
    expect(state).toMatchObject({ contextStatus: 'acquiring' });
    expect(state.workItemId).toBeUndefined();
    expect(state.contractStrikes).toBeUndefined();
    expect(state.excludedExecutors).toBeUndefined();
  });

  it('fails open when work-context resolution fails', async () => {
    await setup();
    const item = await createItem();
    vi.spyOn(harness.session.context, 'getBranchState').mockImplementationOnce(() => { throw new Error('branch unreadable'); });
    expect((await entry('write the release notes for the new API')).workContext).toBeUndefined();
    expect(harness.outStream.events.some((e) => e.type === 'error')).toBe(false);
    const next = await entry('ok go ahead');
    expect(next.workContext).toBeUndefined();
    expect(harness.session.getWorkPhaseState()?.pendingIdentity).toBeDefined();
    expect(harness.session.context.getLedger().activeWorkItemId).toBe(item.id);
  });

  it('does not release a selected identity when its work-create event cannot persist', async () => {
    await setup();
    await entry('implement a CSV exporter');
    harness.session.context.bindPersistence((event) => {
      if (event.op === 'context-commit' && event.events.some((inner) => inner.op === 'work-create')) {
        throw new Error('disk full');
      }
      tree.appendEntry(CONTEXT_ENTRY_TYPE, event);
    });
    const params = { ...READY, workItemId: 'NEW_WORK_ITEM', topicTitle: 'Export', workItemTitle: 'CSV exporter' };
    expect((await handoff(params)).accepted).toBe(false);
    expect(harness.session.context.getLedger().items.size).toBe(0);
    expect(harness.session.getWorkPhaseState()?.contextStatus).toBe('acquiring');
    harness.session.context.bindPersistence((event) => tree.appendEntry(CONTEXT_ENTRY_TYPE, event));
    expect((await handoff(params)).accepted).toBe(true);
    expect(harness.session.context.getLedger().items.size).toBe(1);
  });

  it('starts tracking an existing branch with its first work, and writes no boundary record', async () => {
    tree.user('refactor the cache layer', 1);
    tree.assistant('step 1 done');
    await setup();
    harness.session.context.restore(tree.getBranch());
    expect(harness.session.context.getBranchState()).toBe('legacy-uninitialized');
    await entry('continue with step 2 of the cache refactor');
    expect(ledgerEvents()).toEqual([]);
    expect((await handoff({ ...READY, workItemId: 'NEW_WORK_ITEM', topicTitle: 'Cache',
      workItemTitle: 'Cache refactor' })).accepted).toBe(true);
    expect(ledgerEvents().slice(0, 2)).toEqual(['work-create', 'activate']);
    expect(harness.session.context.getBranchState()).toBe('tracked');
  });

  it('offers requests sent under another model after tracking began, and stops continuing the active item', async () => {
    tree.modelChange(ROUTER_PROVIDER_ID, AUTO_MODEL_ID);
    await setup();
    const item = await createItem();
    expect(harness.session.context.getLedger().activeWorkItemId).toBe(item.id);
    tree.modelChange('openai', 'gpt-5');
    const concrete = tree.user('implement the auth login flow with JWT sessions', Date.now());
    tree.assistant('Login issues a JWT.');
    tree.modelChange(ROUTER_PROVIDER_ID, AUTO_MODEL_ID);
    // model_select rebuilds the ledger from the branch on the switch back.
    harness.session.context.restore(tree.getBranch());
    expect(harness.session.context.getLedger().activeWorkItemId).toBeUndefined();
    expect(harness.session.context.getLedger().items.get(item.id)?.status).toBe('active');
    await entry('back to the auth login work');
    const legacy = harness.session.getWorkPhaseState()?.pendingIdentity?.legacy ?? [];
    expect(legacy.map((choice) => choice.excerpt).join('\n')).toContain('implement the auth login flow');
    expect((await handoff({ ...READY, workItemId: legacy[0]!.id, topicTitle: 'Auth' })).accepted).toBe(true);
    const recovered = [...harness.session.context.getLedger().items.values()].find((i) => i.legacySourceEntryId === concrete);
    expect(recovered).toBeDefined();
    expect(ledgerEvents()).not.toContain('migration-init');
  });

  it('never offers a request the router served as earlier work', async () => {
    tree.modelChange(ROUTER_PROVIDER_ID, AUTO_MODEL_ID);
    await setup();
    await entry('implement the auth login flow');
    expect((await handoff({ ...READY, outcome: 'answer', deliverable: 'lightweight', workItemId: 'NONE' })).accepted).toBe(true);
    await entry('back to the auth login flow');
    expect(harness.session.getWorkPhaseState()?.pendingIdentity?.legacy ?? []).toEqual([]);
  });

  it('offers scrubbed earlier requests, never tool output, as bounded legacy choices', async () => {
    const secret = `sk-${'s'.repeat(40)}`;
    tree.modelChange('openai', 'gpt-5');
    const seed = tree.user(`implement the auth login flow with JWT sessions in src/auth/login.ts (key ${secret})`);
    tree.message({ role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'src/auth/login.ts' } }] });
    tree.message({ role: 'toolResult', content: [{ type: 'text', text: 'LOGIN_FILE_CONTENTS' }] });
    tree.assistant('Login issues a JWT and refreshes it.');
    tree.user('bump the lint config'); tree.assistant('done');
    tree.modelChange(ROUTER_PROVIDER_ID, AUTO_MODEL_ID);
    await setup();
    await entry('back to the old auth login work');
    const choices = harness.session.getWorkPhaseState()?.pendingIdentity?.legacy ?? [];
    expect(choices.length).toBeGreaterThan(0);
    expect(choices.length).toBeLessThanOrEqual(3);
    const excerpts = choices.map((choice) => choice.excerpt).join('\n');
    expect(excerpts).toContain('User: implement the auth login flow');
    expect(excerpts).toContain('Assistant: Login issues a JWT');
    expect(excerpts).not.toContain(secret);
    expect(excerpts).not.toContain('LOGIN_FILE_CONTENTS');
    expect((await handoff({ ...READY, workItemId: choices[0]!.id, topicTitle: 'Auth' })).accepted).toBe(true);
    const item = [...harness.session.context.getLedger().items.values()][0]!;
    expect(item).toMatchObject({ legacySourceEntryId: seed, grounding: [] });
    expect(ledgerEvents().slice(0, 2)).toEqual(['work-create', 'activate']);
    const raw = readFileSync(join(temp.path, 'decisions.jsonl'), 'utf8');
    expect(raw).not.toContain(seed);
    expect(raw).not.toContain('LOGIN_FILE_CONTENTS');
  });

  it('keeps work titles out of the decision log after the boundary', async () => {
    await setup();
    await entry('@requirements/foo.md implement this');
    await groundFile();
    expect((await handoff({ ...READY, workItemId: 'NEW_WORK_ITEM', topicTitle: 'Release',
      workItemTitle: 'Codename Bluebird rollout' })).accepted).toBe(true);
    await serveBranch();
    const raw = readFileSync(join(temp.path, 'decisions.jsonl'), 'utf8');
    expect(raw).toContain('"workContext"');
    expect(raw).not.toContain('Codename Bluebird');
    expect(ledgerEvents()).toEqual(expect.arrayContaining(['work-create', 'activate', 'served']));
  });
});
