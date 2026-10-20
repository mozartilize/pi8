import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from '@earendil-works/pi-ai';
import { convertToLlm, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import { createTempRouterDir } from '../test-support/temp-router-dir.js';
import { registryModel } from '../test-support/router-fixtures.js';
import { setupProviderTest, type ProviderTestHarness } from '../test-support/provider-harness.js';
import { SessionTree } from '../test-support/session-tree.js';
import { observeContextGrounding } from './context-grounding.js';
import { prepareHandoffFacts, registerContextHandoffTool, submitContextHandoff } from './context-handoff-tool.js';
import { RouterSession } from './router-session-state.js';
import { phaseDifficulty } from '../routing/features/difficulty.js';
import { settleReminder } from './settle-reminder.js';
import { closeContextOnSettle } from './gathering-gate.js';

vi.mock('@earendil-works/pi-ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@earendil-works/pi-ai')>()),
  createAssistantMessageEventStream: vi.fn(), isRetryableAssistantError: () => false,
}));
vi.mock('@earendil-works/pi-ai/compat', () => ({ streamSimple: vi.fn() }));

const READY = { outcome: 'ready', deliverable: 'implement', complexity: 'trivial', scope: 'bounded',
  findings: 'checked the request', question: 'implement the change' };
const models = ['alpha/cheap', 'beta/strong'].map((id) => registryModel(id, {
  contextWindow: 200000, maxTokens: 8192, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
}));
const benchmarks = models.map((model) => ({ registryId: `${model.provider}/${model.id}`,
  benchSlug: model.id, active: true, quality: { intelligence: 50, coding: 50, agenticCoding: 50 }, source: 'test' }));

describe('entry-scoped context handoff', () => {
  let temp: ReturnType<typeof createTempRouterDir>;
  let harness: ProviderTestHarness;
  let tree: SessionTree;
  let cwd: string;
  let ctx: { cwd: string; model: { provider: string; id: string }; sessionManager: ReturnType<SessionTree['manager']> };
  beforeEach(async () => {
    temp = createTempRouterDir();
    cwd = join(temp.path, 'repo'); mkdirSync(cwd);
    writeFileSync(join(cwd, 'source.ts'), 'first\nsecond\nthird\nfourth');
    tree = new SessionTree();
    ctx = { cwd, model: { provider: 'router', id: 'auto' }, sessionManager: tree.manager() };
    harness = await setupProviderTest({ dir: temp.path, benchmarks: benchmarks as never, models, ctx: ctx as never });
    harness.scriptReply([{ type: 'text_delta', delta: 'served' }, { type: 'done' }]);
  });
  afterEach(() => { vi.restoreAllMocks(); temp.cleanup(); });

  async function serve() {
    harness.resetEventStream();
    const messages = tree.getBranch().filter((event) => event.type === 'message').map((event) => event.message!);
    await harness.serve({ messages } as unknown as Context);
  }
  async function entry(prompt: string) { tree.user(prompt, tree.getBranch().length + 1); await serve(); }
  async function handoff(params: Record<string, unknown> = READY) {
    const facts = await prepareHandoffFacts(params, ctx as never, harness.session,
      async () => ({ stdout: '', stderr: '', code: 0 }) as never);
    return submitContextHandoff(params, ctx as never, harness.session, facts);
  }
  async function read(text = 'first\nsecond\nthird\nfourth', offset?: number) {
    await observeContextGrounding({ toolName: 'read', input: { path: 'source.ts', ...(offset ? { offset } : {}) },
      content: [{ type: 'text', text }], isError: false } as never, ctx as never, harness.session);
  }
  async function struckFlow() {
    await entry('implement the parser');
    expect((await handoff()).accepted).toBe(true);
    await serve();
    const state = harness.session.getEntryRoutingState()!;
    const flow = { ...state.executionFlow!, strikesByModel: { 'alpha/cheap': 2 }, excludedModels: ['alpha/cheap'] };
    harness.session.commitEntryRoutingState({ ...state, executionFlow: flow });
    return flow;
  }

  it('declares only ready, needs-user, and the optional explicit flow continuation', () => {
    let parameters: any;
    registerContextHandoffTool({ registerTool: (tool: { parameters: unknown }) => { parameters = tool.parameters; } } as unknown as ExtensionAPI,
      new RouterSession());
    expect(parameters.properties.outcome.anyOf.map((v: { const: string }) => v.const)).toEqual(['ready', 'needs-user']);
    for (const key of ['workItemId', 'topicId', 'topicTitle', 'workItemTitle']) expect(parameters.properties).not.toHaveProperty(key);
    expect(parameters.properties.continuesFlow.type).toBe('boolean');
    expect(JSON.stringify(parameters.properties.deliverable)).not.toContain('lightweight');
  });

  it('creates gather boundaries with declared demand and repeats the accepted payload without a new boundary', async () => {
    await entry('investigate the failure');
    const triage = harness.session.getEntryRoutingState()!.boundaryId;
    const params = { ...READY, deliverable: 'gather', complexity: 'routine' };
    expect((await handoff(params)).accepted).toBe(true);
    const boundary = harness.session.getEntryRoutingState()!.boundaryId;
    expect(boundary).not.toBe(triage);
    await serve();
    expect(phaseDifficulty(harness.session.getEntryRoutingState(), 'gather')).toMatchObject({ value: 0.25, source: 'declared-complexity' });
    const served = harness.session.getEntryRoutingState();
    expect((await handoff(params)).accepted).toBe(true);
    expect(harness.session.getEntryRoutingState()).toBe(served);
    expect((await handoff({ ...params, findings: 'another independent failure' })).accepted).toBe(true);
    expect(harness.session.getEntryRoutingState()!.boundaryId).not.toBe(boundary);
  });

  it('keeps strikes across two implement handoffs in the same entry', async () => {
    const flow = await struckFlow();
    expect((await handoff({ ...READY, findings: 'revised implementation evidence' })).accepted).toBe(true);
    expect(harness.session.getEntryRoutingState()!.executionFlow).toEqual(flow);
    await serve();
    expect(harness.session.getLastDecision()!.fallbackChain).not.toContain('alpha/cheap');
    expect(harness.session.getLastServed()!.registryId).toBe('beta/strong');
  });

  it('carries the previous flow only through the next entry\'s explicit implement declaration', async () => {
    const flow = await struckFlow();
    harness.session.finishExecutionFlow();
    await entry('continue');
    const delegated = JSON.stringify(vi.mocked(streamSimple).mock.calls.at(-1)?.[1]);
    expect(delegated).toContain('alpha/cheap');
    expect(delegated).toContain('Set continuesFlow to true');
    expect(harness.session.getEntryRoutingState()!.executionFlow).toBeUndefined();
    expect((await handoff({ ...READY, continuesFlow: true })).accepted).toBe(true);
    expect(harness.session.getEntryRoutingState()!.executionFlow).toEqual(flow);
    expect(harness.session.previousFlow).toBeUndefined();
    await serve();
    expect(harness.session.getLastDecision()!.fallbackChain).not.toContain('alpha/cheap');
  });

  it('starts a fresh flow with a diagnostic when no previous flow exists', async () => {
    await entry('implement the parser');
    const result = await handoff({ ...READY, continuesFlow: true });
    expect(result).toMatchObject({ accepted: true, text: expect.stringContaining('No previous execution flow exists') });
    expect(harness.session.getEntryRoutingState()!.executionFlow).toMatchObject({ strikesByModel: {}, excludedModels: [] });
  });

  it('discards an unlinked flow and cannot adopt it across an unrelated answer entry', async () => {
    const flow = await struckFlow();
    await entry('what does CSV mean?');
    expect(harness.session.previousFlow).toEqual(flow);
    harness.session.finishExecutionFlow();
    expect(harness.session.previousFlow).toBeUndefined();
    await entry('implement another parser');
    expect((await handoff({ ...READY, continuesFlow: true })).accepted).toBe(true);
    expect(harness.session.getEntryRoutingState()!.executionFlow!.flowId).not.toBe(flow.flowId);
    expect(harness.session.getEntryRoutingState()!.executionFlow!.excludedModels).toEqual([]);
  });

  it('discards the previous flow when a fresh implementation omits continuesFlow', async () => {
    const flow = await struckFlow();
    await entry('implement an unrelated scheduler');
    expect((await handoff()).accepted).toBe(true);
    expect(harness.session.previousFlow).toBeUndefined();
    expect(harness.session.getEntryRoutingState()!.executionFlow!.flowId).not.toBe(flow.flowId);
    expect(harness.session.getEntryRoutingState()!.executionFlow!.strikesByModel).toEqual({});
  });

  it.each([{ deliverable: 'plan', continuesFlow: true }, { outcome: 'needs-user', continuesFlow: true },
    { continuesFlow: 'true' }, { outcome: 'answer' }, { deliverable: 'lightweight' }])('rejects invalid declaration %j without spending a source refusal', async (patch) => {
    await entry('hello');
    const state = harness.session.getEntryRoutingState();
    expect((await handoff({ ...READY, ...patch })).accepted).toBe(false);
    expect(harness.session.getEntryRoutingState()).toBe(state);
  });

  it('requires a complete current-entry read even when files are declared or the model is pinned', async () => {
    harness.session.setManualModel('alpha/cheap');
    await entry('@source.ts implement the parser');
    expect((await handoff({ ...READY, files: ['source.ts'] })).accepted).toBe(false);
    await read('first\nsecond', 1);
    expect(harness.session.getEntryRoutingState()!.sourceEvidencePending).toBe(true);
    await read('third\nfourth', 3);
    expect(harness.session.getEntryRoutingState()!.sourceEvidencePending).toBe(false);
    expect((await handoff()).accepted).toBe(true);
    await entry('@source.ts explain another result');
    expect(harness.session.getEntryRoutingState()!.evidence!.observedFiles.size).toBe(0);
    expect((await handoff()).accepted).toBe(false);
  });

  it('logs source counts without paths or source content at an accepted boundary', async () => {
    await entry('@source.ts implement the parser');
    await read();
    expect((await handoff({ ...READY, files: ['source.ts'] })).accepted).toBe(true);
    const text = readFileSync(join(temp.path, 'decisions.jsonl'), 'utf8');
    const accepted = text.trim().split('\n').map((line) => JSON.parse(line))
      .find((record) => record.investigationHandoff?.action === 'accept');
    expect(accepted.investigationHandoff.status).toBe('ready-pending');
    expect(accepted.routingScope.boundaryId).toBe(harness.session.getEntryRoutingState()!.boundaryId);
    expect(accepted.routingScope.entryId).toBe(harness.session.getEntryRoutingState()!.sourceEntryId);
    expect(accepted.investigationHandoff.sourceEvidence).toEqual({ required: 1, fresh: 1, partial: 0, oversized: 0 });
    expect(text).not.toContain('source.ts');
    expect(text).not.toContain('first\\nsecond');
  });

  it('rejects a changed source and permits needs-user without falsely satisfying it', async () => {
    await entry('@source.ts implement the parser');
    await read();
    writeFileSync(join(cwd, 'source.ts'), 'changed content');
    expect((await handoff()).accepted).toBe(false);
    expect((await handoff({ outcome: 'needs-user', question: 'Which source version should I use?' })).accepted).toBe(true);
    expect(harness.session.getEntryRoutingState()).toMatchObject({ status: 'clarification-only', sourceEvidencePending: true });
  });

  it('keeps a converted source-repair reminder in the same entry and permits a direct answer after the read', async () => {
    await entry('@source.ts explain this');
    const first = harness.session.getEntryRoutingState()!;
    const repair = await settleReminder({ outcome: 'completed' } as never, harness.session);
    const draft = repair?.entries?.at(-1);
    expect(draft).toMatchObject({ type: 'custom_message', customType: 'pi8-settle' });
    const note = draft && 'content' in draft ? draft.content : '';
    const custom = { role: 'custom', customType: 'pi8-settle', content: note, display: false, timestamp: 100 };
    tree.message(custom);
    harness.resetEventStream();
    const messages = tree.getBranch().filter((event) => event.type === 'message').map((event) => event.message!);
    await harness.serve({ messages: convertToLlm(messages as never) } as Context);
    const current = harness.session.getEntryRoutingState()!;
    expect(current.intentKey).toBe(first.intentKey);
    expect(current.boundaryId).toBe(first.boundaryId);
    expect(current.providerInvocation).toBe(2);
    expect(current.evidence).toBe(first.evidence);
    expect(current.sourceSettleAttempts).toBe(1);
    await read();
    expect(await settleReminder({ outcome: 'completed' } as never, harness.session)).toBeUndefined();
    expect(harness.session.getEntryRoutingState()?.handoffKey).toBeUndefined();
  });

  it('does not credit a late read or accept old prepared facts after a new genuine entry reaches the branch', async () => {
    await entry('@source.ts implement the parser');
    await read();
    const facts = await prepareHandoffFacts(READY, ctx as never, harness.session,
      async () => ({ stdout: '', stderr: '', code: 0 }) as never);
    const before = harness.session.getEntryRoutingState()!;
    before.evidence!.observedFiles.clear();
    tree.user('implement another scheduler');
    await read();
    expect(before.evidence!.observedFiles.size).toBe(0);
    expect(submitContextHandoff(READY, ctx as never, harness.session, facts).accepted).toBe(false);
    expect(harness.session.getEntryRoutingState()).toBe(before);
  });

  it('does not classify an accepted needs-user question with unmet sources as a missing handoff', async () => {
    await entry('@source.ts clarify this request');
    expect((await handoff({ outcome: 'needs-user', question: 'Which source version should I use?' })).accepted).toBe(true);
    await serve();
    closeContextOnSettle(harness.session);
    const records = readFileSync(join(temp.path, 'decisions.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(records.some((record) => record.investigationHandoff?.action === 'no-handoff')).toBe(false);
    expect(harness.session.getEntryRoutingState()?.contextClosed).toBe(true);
  });

  it.each(['same-entry', 'new-entry'] as const)('does not publish a late selection after a newer %s invocation serves', async (mode) => {
    const selection = await import('./unified-decision.js');
    const original = selection.resolveUnifiedDecision;
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const paused = new Promise<void>((resolve) => { release = resolve; });
    let oldAssignment: string | undefined;
    vi.spyOn(selection, 'resolveUnifiedDecision').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      if ('authorization' in result) oldAssignment = result.authorization.assignmentId;
      enter();
      await paused;
      return result;
    });
    tree.user('explain the first result', 1);
    const oldStream = harness.outStream;
    harness.providerOptions.streamSimple({ id: 'auto' } as never,
      { messages: [{ role: 'user', content: 'explain the first result', timestamp: 1 }] } as unknown as Context);
    try {
      await entered;
      if (mode === 'new-entry') await entry('explain another result');
      else await serve();
      const current = harness.session.getEntryRoutingState()!;
      const assignment = current.boundaryAuthorization!.assignmentId;
      const decisionScope = harness.session.getLastDecision()!.routingScope;
      expect(oldAssignment).toBeDefined();
      expect(oldAssignment).not.toBe(assignment);
      release();
      await vi.waitFor(() => expect(oldStream.ended).toBe(true));
      expect(harness.session.getEntryRoutingState()?.boundaryAuthorization?.assignmentId).toBe(assignment);
      expect(harness.session.getLastDecision()?.routingScope).toEqual(decisionScope);
      expect(harness.session.getEntryRoutingState()?.providerInvocation).toBe(mode === 'new-entry' ? 1 : 2);
      expect(harness.streamedModels()).toHaveLength(1);
    } finally { release(); }
  }, 10_000);

  it.each(['entry', 'epoch', 'session'] as const)('rejects prepared facts after a different %s becomes current', async (change) => {
    await entry('implement the parser');
    const facts = await prepareHandoffFacts(READY, ctx as never, harness.session,
      async () => ({ stdout: '', stderr: '', code: 0 }) as never);
    if (change === 'entry') await entry('implement a scheduler');
    if (change === 'epoch') harness.session.invalidateRouting();
    if (change === 'session') harness.session.reset();
    const state = harness.session.getEntryRoutingState();
    expect(submitContextHandoff(READY, ctx as never, harness.session, facts).accepted).toBe(false);
    expect(harness.session.getEntryRoutingState()).toBe(state);
  });
});
