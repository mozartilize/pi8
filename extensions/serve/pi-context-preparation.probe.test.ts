/** Real Pi mechanism probes. Fake providers make no network or paid calls. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Type, createAssistantMessageEventStream, type AssistantMessage, type Context, type Model, type SimpleStreamOptions } from '@earendil-works/pi-ai';
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  estimateTokens, shouldCompact, type ExtensionContext,
} from '@earendil-works/pi-coding-agent';

const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const config = (id: string, contextWindow: number) => ({
  id, name: id, contextWindow, maxTokens: 4096, reasoning: false, input: ['text'] as ['text'], cost: COST,
});
const message = (model: Model<any>, text: string, input: number): AssistantMessage => ({
  role: 'assistant', api: model.api, provider: model.provider, model: model.id,
  content: [{ type: 'text', text }], stopReason: 'stop', timestamp: Date.now(),
  usage: { input, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: input + 1, cost: COST },
});
const tokens = (messages: Parameters<typeof estimateTokens>[0][]) => messages.reduce((sum, msg) => sum + estimateTokens(msg), 0);
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

type Trace = { kind: string; model?: string; tokens?: number; summary?: boolean; aborted?: boolean; reason?: string };
interface ProbeOptions {
  mode?: 'virtual' | 'wrapper' | 'direct' | 'router';
  /** Router mode: advertise the selected target's window before the run, or keep 1M. */
  routerWindow?: 'target' | 'fixed';
  historyTokens?: number;
  failSummary?: boolean;
  enabled?: boolean;
  guard?: 'abort' | 'throw';
  targetReserve?: number;
  manualBeforeRun?: boolean;
  manualAtStart?: boolean;
  manualInContext?: boolean;
  fallback?: boolean;
  persist?: boolean;
  toolOutputTokens?: number;
  holdSummary?: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> };
  finalCheck?: (ctx: ExtensionContext) => void;
}
const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });

async function makeProbe(options: ProbeOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pi8-context-probe-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const trace: Trace[] = [];
  const runtime = await ModelRuntime.create({
    authPath: join(root, 'auth.json'), modelsPath: null, modelsStorePath: join(root, 'models-store.json'),
    refreshOnCreate: false, allowModelNetwork: false,
  });
  let compacting = false;
  let manualStarted = false;
  const manualFinished = deferred();
  const stream = (model: Model<any>, context: Context, streamOptions?: SimpleStreamOptions) => {
    const summary = compacting;
    const input = tokens(context.messages);
    trace.push({ kind: 'request', model: model.id, tokens: input, summary, aborted: streamOptions?.signal?.aborted });
    const output = createAssistantMessageEventStream();
    void (async () => {
      if (summary && options.holdSummary) {
        options.holdSummary.entered.resolve();
        await options.holdSummary.release.promise;
      }
      const result = message(model, summary ? 'A short summary of finalized history.' : `ANSWER-${model.id}`, input);
      if (streamOptions?.signal?.aborted || (summary && options.failSummary) || (!summary && options.fallback && model.id === 'A')) {
        const error: AssistantMessage = {
          ...result, content: [], stopReason: streamOptions?.signal?.aborted ? 'aborted' : 'error',
          errorMessage: streamOptions?.signal?.aborted ? 'Probe cancelled' : 'Probe failure',
        };
        output.push({ type: 'error', reason: error.stopReason as 'aborted' | 'error', error });
        return;
      }
      if (!summary && options.toolOutputTokens && !context.messages.some((msg) => msg.role === 'toolResult')) {
        const call = { type: 'toolCall' as const, id: 'probe-tool-1', name: 'probe_history', arguments: {} };
        const toolMessage: AssistantMessage = { ...result, content: [call], stopReason: 'toolUse' };
        output.push({ type: 'start', partial: toolMessage });
        output.push({ type: 'toolcall_start', contentIndex: 0, partial: toolMessage });
        output.push({ type: 'toolcall_end', contentIndex: 0, toolCall: call, partial: toolMessage });
        output.push({ type: 'done', reason: 'toolUse', message: toolMessage });
        return;
      }
      output.push({ type: 'start', partial: result });
      output.push({ type: 'text_start', contentIndex: 0, partial: result });
      output.push({ type: 'text_delta', contentIndex: 0, delta: (result.content[0] as { text: string }).text, partial: result });
      output.push({ type: 'text_end', contentIndex: 0, content: (result.content[0] as { text: string }).text, partial: result });
      output.push({ type: 'done', reason: 'stop', message: result });
    })();
    return output;
  };
  runtime.registerProvider('probe', {
    api: 'probe-api', apiKey: 'fake-local-only', baseUrl: 'http://127.0.0.1:1',
    models: [config('A', 1_000_000), config('B', 272_000)], streamSimple: stream,
  });
  const A = runtime.getModel('probe', 'A')!;
  const B = runtime.getModel('probe', 'B')!;
  const servingTarget = B;
  runtime.registerProvider('wrapper', {
    api: 'wrapper-api', apiKey: 'fake-local-only', baseUrl: 'http://127.0.0.1:1', models: [config('auto', 1_000_000)],
    streamSimple: (_model, context, streamOptions) => {
      if (compacting || !options.fallback) return runtime.streamSimple(compacting ? A : servingTarget, context, streamOptions);
      const output = createAssistantMessageEventStream();
      void (async () => {
        // Answerless attempts must not end the consumer stream.
        for await (const _event of runtime.streamSimple(A, context, streamOptions)) { /* discard the failed attempt */ }
        for await (const event of runtime.streamSimple(B, context, streamOptions)) output.push(event);
      })();
      return output;
    },
  });
  const settings = SettingsManager.inMemory({
    compaction: {
      enabled: options.enabled ?? true, reserveTokens: 16_384, keepRecentTokens: 20_000,
      ...(options.targetReserve !== undefined ? { modelOverrides: { 'probe/B': { reserveTokens: options.targetReserve } } } : {}),
    },
    retry: { enabled: false }, cacheWarming: 'off',
  });
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir: root, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: 'Local preparation probe.',
    extensionFactories: [(pi) => {
      // The physical router model, registered through the extension API so
      // that a new registration refreshes the session model.
      const registerRouter = (contextWindow: number) => pi.registerProvider('router-probe', {
        api: 'router-probe-api', apiKey: 'fake-local-only', baseUrl: 'http://127.0.0.1:1',
        models: [config('auto', contextWindow)],
        streamSimple: (_model, context, streamOptions) => runtime.streamSimple(compacting ? A : servingTarget, context, streamOptions),
      });
      if (options.mode === 'router') registerRouter(1_000_000);
      if (options.mode === 'router' && options.routerWindow === 'target') {
        pi.on('before_agent_start', () => {
          trace.push({ kind: 'advertise', tokens: servingTarget.contextWindow });
          registerRouter(servingTarget.contextWindow);
        });
      }
      if (options.toolOutputTokens) pi.registerTool({
        name: 'probe_history', label: 'Local history probe', description: 'Return local probe text.',
        parameters: Type.Object({}), execute: async () => {
          trace.push({ kind: 'tool-execute', tokens: options.toolOutputTokens });
          return { content: [{ type: 'text', text: 't'.repeat(options.toolOutputTokens! * 4) }], details: {} };
        },
      });
      pi.registerVirtualModel({
        provider: 'virtual', id: 'auto', name: 'Virtual preparation probe', contextWindow: 1_000_000, maxTokens: 4096,
        route: (request) => {
          trace.push({ kind: 'route', reason: request.reason });
          return { model: request.reason === 'direct' ? A : B, thinkingLevel: 'off' };
        },
      });
      pi.on('session_before_compact', (event) => { trace.push({ kind: 'before-compact', reason: event.reason }); compacting = true; });
      pi.on('session_compact', () => { trace.push({ kind: 'compact-persisted' }); compacting = false; });
      pi.on('session_compact_failed', () => { trace.push({ kind: 'compact-failed' }); compacting = false; });
      pi.registerCommand('probe-prepare', {
        description: 'Prepare context while the session is idle.',
        handler: async (_prompt, ctx) => {
          if (!options.manualBeforeRun) return;
          trace.push({ kind: 'manual-before-run' });
          await new Promise<void>((resolve, reject) => ctx.compact({ onComplete: () => resolve(), onError: reject }));
        },
      });
      pi.on('before_agent_start', (_event, ctx) => {
        if (!options.manualAtStart || manualStarted) return;
        manualStarted = true;
        ctx.compact({
          onComplete: () => { trace.push({ kind: 'manual-complete' }); manualFinished.resolve(); },
          onError: () => { trace.push({ kind: 'manual-failed' }); manualFinished.resolve(); },
        });
      });
      pi.on('context', (event, ctx) => {
        const input = tokens(event.messages);
        trace.push({ kind: 'context', tokens: input });
        options.finalCheck?.(ctx);
        if (options.manualInContext && !manualStarted) {
          manualStarted = true;
          trace.push({ kind: 'manual-in-context' });
          ctx.compact({
            onComplete: () => { trace.push({ kind: 'manual-complete' }); manualFinished.resolve(); },
            onError: () => { trace.push({ kind: 'manual-failed' }); manualFinished.resolve(); },
          });
        }
        // Use Pi's resolved target settings. The provider-visible prompt is
        // checked independently below, after Pi's conversion.
        const budget = servingTarget.contextWindow - settings.getCompactionSettings(servingTarget).reserveTokens;
        if (options.guard && input > budget) {
          trace.push({ kind: 'guard-rejected', tokens: input });
          if (options.guard === 'throw') throw new Error('Preparation did not produce a fitting prompt');
          ctx.abort();
        }
      });
    }],
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  const manager = options.persist ? SessionManager.create(root, join(root, 'sessions')) : SessionManager.inMemory(root);
  manager.appendModelChange('probe', 'A');
  const history = options.historyTokens ?? 400_000;
  for (let i = 0; i < 20; i++) {
    manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'x'.repeat(history / 20 * 4) }], timestamp: Date.now() });
    manager.appendMessage(message(A, `Historical answer ${i}`, (i + 1) * history / 20));
  }
  const selected = options.mode === 'wrapper' ? runtime.getModel('wrapper', 'auto')!
    : options.mode === 'direct' ? B : A;
  const { session } = await createAgentSession({
    cwd: root, agentDir: root, model: selected, modelRuntime: runtime, resourceLoader: loader,
    settingsManager: settings, sessionManager: manager, tools: options.toolOutputTokens ? ['probe_history'] : [], thinkingLevel: 'off',
  });
  cleanup.push(() => session.dispose());
  await session.bindExtensions({});
  if (options.toolOutputTokens) expect(session.getActiveToolNames()).toContain('probe_history');
  if (!options.mode || options.mode === 'virtual') await session.setModel(runtime.getModel('virtual', 'auto')!);
  if (options.mode === 'router') await session.setModel(runtime.getModel('router-probe', 'auto')!);
  session.subscribe((event) => {
    if (event.type === 'message_end' && event.message.role === 'assistant') trace.push({ kind: 'consumer-end', model: event.message.model, reason: event.message.stopReason });
  });
  const serving = () => trace.filter((event) => event.kind === 'request' && !event.summary);
  const summaries = () => trace.filter((event) => event.kind === 'request' && event.summary);
  const compactions = () => manager.getBranch().filter((entry) => entry.type === 'compaction');
  return { session, manager, settings, runtime, loader, root, trace, serving, summaries, compactions, manualFinished: manualFinished.promise };
}

describe('real Pi context preparation mechanisms', () => {
  it('a 1M physical wrapper delegates an oversized request without native preparation', async () => {
    const probe = await makeProbe({ mode: 'wrapper' });
    await probe.session.prompt('Continue', { expandPromptTemplates: false });
    expect(probe.compactions()).toHaveLength(0);
    expect(probe.serving()).toHaveLength(1);
    expect(probe.serving()[0].tokens).toBeGreaterThan(272_000);
  });

  it.each([200_000, 400_000])('native virtual routing exposes prepared context for %i tokens', async (historyTokens) => {
    const probe = await makeProbe({ historyTokens, guard: 'abort' });
    await probe.session.prompt('Continue', { expandPromptTemplates: false });
    expect(probe.compactions()).toHaveLength(historyTokens === 400_000 ? 1 : 0);
    expect(probe.serving()).toHaveLength(1);
    expect(probe.serving()[0]).toMatchObject({ model: 'B', aborted: false });
    expect(probe.serving()[0].tokens).toBeLessThan(272_000 - 16_384);
    expect(probe.trace.filter((entry) => entry.kind === 'route' && entry.reason !== 'direct')).toHaveLength(1);
    if (historyTokens === 400_000) {
      expect(probe.summaries().every((request) => request.model === 'A' && request.tokens! < 1_000_000)).toBe(true);
      expect(probe.trace.findIndex((entry) => entry.kind === 'compact-persisted')).toBeLessThan(probe.trace.findIndex((entry) => entry.kind === 'context'));
      expect(probe.compactions()[0].usage?.totalTokens).toBeGreaterThan(0);
    }
    expect(probe.session.getLastAssistantText()).toBe('ANSWER-B');
  });

  it('switching directly to B uses B for an oversized summary request', async () => {
    const probe = await makeProbe({ mode: 'direct', guard: 'abort' });
    await probe.session.prompt('Continue', { expandPromptTemplates: false });
    expect(probe.summaries()).toHaveLength(1);
    expect(probe.summaries()[0]).toMatchObject({ model: 'B' });
    expect(probe.summaries()[0].tokens).toBeGreaterThan(272_000);
    // Fake acceptance cannot establish that the summary model has capacity.
    expect(probe.compactions()).toHaveLength(1);
  });

  it('throwing from the context hook does not veto oversized dispatch', async () => {
    const probe = await makeProbe({ failSummary: true, guard: 'throw' });
    await probe.session.prompt('Continue', { expandPromptTemplates: false });
    expect(probe.trace.some((event) => event.kind === 'guard-rejected')).toBe(true);
    expect(probe.compactions()).toHaveLength(0);
    expect(probe.serving().some((request) => request.model === 'B' && request.tokens! > 272_000)).toBe(true);
  });

  it.each([true, false])('context abort after failed/disabled compaction blocks B (enabled=%s)', async (enabled) => {
    const probe = await makeProbe({ enabled, failSummary: true, guard: 'abort' });
    await probe.session.prompt('Continue', { expandPromptTemplates: false });
    expect(probe.trace.some((event) => event.kind === 'guard-rejected')).toBe(true);
    expect(probe.compactions()).toHaveLength(0);
    expect(probe.serving()).toEqual([]);
  });

  it('an irreducible current prompt stays blocked after successful history compaction', async () => {
    const probe = await makeProbe({ historyTokens: 200_000, guard: 'abort' });
    await probe.session.prompt('z'.repeat(1_600_000), { expandPromptTemplates: false });
    expect(probe.compactions()).toHaveLength(1);
    expect(probe.trace.some((event) => event.kind === 'guard-rejected')).toBe(true);
    expect(probe.serving()).toEqual([]);
  });

  it('the virtual target threshold does not use the physical target reserve override', async () => {
    const probe = await makeProbe({ historyTokens: 200_000, targetReserve: 100_000, guard: 'abort' });
    const target = probe.runtime.getModel('probe', 'B')!;
    expect(shouldCompact(200_000, target.contextWindow, probe.settings.getCompactionSettings(target))).toBe(true);
    await probe.session.prompt('Continue', { expandPromptTemplates: false });
    expect(probe.compactions()).toHaveLength(0);
    expect(probe.trace.some((event) => event.kind === 'guard-rejected')).toBe(true);
    expect(probe.serving()).toEqual([]);
  });

  it('manual compaction can finish before an agent run starts', async () => {
    const probe = await makeProbe({ mode: 'wrapper', manualBeforeRun: true, guard: 'abort' });
    await probe.session.prompt('/probe-prepare Continue');
    await probe.session.prompt('Continue', { expandPromptTemplates: false });
    expect(probe.compactions()).toHaveLength(1);
    expect(probe.trace.findIndex((event) => event.kind === 'compact-persisted')).toBeLessThan(probe.trace.findIndex((event) => event.kind === 'context'));
    expect(probe.serving()).toHaveLength(1);
    expect(probe.serving()[0].tokens).toBeLessThan(272_000 - 16_384);
  });

  it('manual compaction from the start hook aborts the run before dispatch', async () => {
    const probe = await makeProbe({ mode: 'wrapper', manualAtStart: true });
    await probe.session.prompt('Continue', { expandPromptTemplates: false });
    await probe.manualFinished;
    expect(probe.serving()).toEqual([]);
    expect(probe.compactions()).toHaveLength(1);
    const terminal = probe.trace.filter((event) => event.kind === 'consumer-end');
    expect(terminal).toHaveLength(1);
    expect(['error', 'aborted']).toContain(terminal[0].reason);
    expect(probe.trace.findIndex((event) => event.kind === 'consumer-end')).toBeLessThan(probe.trace.findIndex((event) => event.kind === 'manual-complete'));
    expect(probe.trace.filter((event) => event.kind === 'manual-complete')).toHaveLength(1);
    await probe.session.prompt('Continue after preparation', { expandPromptTemplates: false });
    expect(probe.serving()).toHaveLength(1);
    expect(probe.session.getLastAssistantText()).toBe('ANSWER-B');
  });

  it('physical-provider fallback receives no additional host preparation or context hook', async () => {
    const probe = await makeProbe({ mode: 'wrapper', fallback: true });
    await probe.session.prompt('Continue', { expandPromptTemplates: false });
    expect(probe.compactions()).toHaveLength(0);
    expect(probe.trace.filter((event) => event.kind === 'context')).toHaveLength(1);
    expect(probe.serving().map((event) => event.model)).toEqual(['A', 'B']);
    expect(probe.serving()[1].tokens).toBeGreaterThan(272_000);
    expect(probe.trace.filter((event) => event.kind === 'consumer-end')).toEqual([
      { kind: 'consumer-end', model: 'B', reason: 'stop' },
    ]);
  });

  it('manual compaction from context aborts the run and finishes only after it ends', async () => {
    const probe = await makeProbe({ mode: 'wrapper', manualInContext: true });
    await probe.session.prompt('Continue', { expandPromptTemplates: false });
    await probe.manualFinished;
    expect(probe.serving()).toEqual([]);
    expect(probe.compactions()).toHaveLength(1);
    expect(probe.trace.findIndex((event) => event.kind === 'consumer-end')).toBeLessThan(probe.trace.findIndex((event) => event.kind === 'manual-complete'));
    const terminal = probe.trace.filter((event) => event.kind === 'consumer-end');
    expect(terminal).toHaveLength(1);
    expect(['error', 'aborted']).toContain(terminal[0].reason);
    await probe.session.prompt('Continue after preparation', { expandPromptTemplates: false });
    expect(probe.serving()).toHaveLength(1);
    expect(probe.session.getLastAssistantText()).toBe('ANSWER-B');
  });

  it('the context hook checks the next model request after a tool result', async () => {
    const probe = await makeProbe({ historyTokens: 200_000, guard: 'abort', toolOutputTokens: 300_000 });
    await probe.session.prompt('Fetch local history', { expandPromptTemplates: false });
    expect(probe.trace.filter((event) => event.kind === 'context')).toHaveLength(2);
    expect(probe.trace.some((event) => event.kind === 'guard-rejected')).toBe(true);
    expect(probe.serving()).toHaveLength(1);
    expect(probe.serving()[0].tokens).toBeLessThan(272_000 - 16_384);
    expect(probe.trace.some((event) => event.kind === 'consumer-end' && event.reason === 'toolUse')).toBe(true);
  });

  it.each(['target', 'fixed'] as const)('a physical router that advertises the %s window before the run', async (routerWindow) => {
    const probe = await makeProbe({
      mode: 'router', routerWindow, historyTokens: 200_000, toolOutputTokens: 100_000, guard: 'abort',
    });
    await probe.session.prompt('Fetch local history', { expandPromptTemplates: false });
    expect(probe.trace.some((event) => event.kind === 'tool-execute')).toBe(true);
    if (routerWindow === 'target') {
      // Pi compacts between the tool result and the next request, against the
      // advertised window, without ending the run.
      expect(probe.compactions()).toHaveLength(1);
      const firstEnd = probe.trace.findIndex((event) => event.kind === 'consumer-end');
      expect(firstEnd).toBeLessThan(probe.trace.findIndex((event) => event.kind === 'compact-persisted'));
      expect(probe.summaries().every((event) => event.model === 'A')).toBe(true);
      expect(probe.trace.some((event) => event.kind === 'guard-rejected')).toBe(false);
      expect(probe.serving().map((event) => event.model)).toEqual(['B', 'B']);
      expect(probe.serving()[1].tokens).toBeLessThan(272_000 - 16_384);
      expect(probe.trace.filter((event) => event.kind === 'consumer-end').map((event) => event.reason)).toEqual(['toolUse', 'stop']);
    } else {
      // A 1M window does not compact for B. Only the final guard prevents dispatch.
      expect(probe.compactions()).toHaveLength(0);
      expect(probe.trace.some((event) => event.kind === 'guard-rejected')).toBe(true);
      expect(probe.serving()).toHaveLength(1);
    }
  });

  it('a failed in-run summary with the target window ends the run without oversized dispatch', async () => {
    const probe = await makeProbe({
      mode: 'router', routerWindow: 'target', historyTokens: 200_000, toolOutputTokens: 100_000,
      guard: 'abort', failSummary: true,
    });
    await probe.session.prompt('Fetch local history', { expandPromptTemplates: false });
    expect(probe.summaries().length).toBeGreaterThan(0);
    expect(probe.compactions()).toHaveLength(0);
    expect(probe.trace.some((event) => event.kind === 'guard-rejected')).toBe(true);
    expect(probe.serving()).toHaveLength(1);
  });

  it('the final context hook can reject a selection invalidated during summary', async () => {
    const holdSummary = { entered: deferred(), release: deferred() };
    let revision = 1;
    let selectedRevision = revision;
    const probe = await makeProbe({
      holdSummary, guard: 'abort', finalCheck: (ctx) => { if (revision !== selectedRevision) ctx.abort(); },
    });
    const prompt = probe.session.prompt('Continue', { expandPromptTemplates: false });
    await holdSummary.entered.promise;
    revision++;
    holdSummary.release.resolve();
    await prompt;
    expect(probe.compactions()).toHaveLength(1);
    expect(probe.serving()).toEqual([]);
    selectedRevision = revision;
    await probe.session.prompt('Continue with a fresh selection', { expandPromptTemplates: false });
    expect(probe.serving()).toHaveLength(1);
    expect(probe.session.getLastAssistantText()).toBe('ANSWER-B');
  });

  it('native compaction and usage survive file-backed SDK resume', async () => {
    const probe = await makeProbe({ persist: true, guard: 'abort' });
    await probe.session.prompt('Continue', { expandPromptTemplates: false });
    const saved = probe.compactions()[0];
    probe.session.dispose();
    const restored = SessionManager.open(probe.manager.getSessionFile()!);
    expect(restored.getBranch().filter((entry) => entry.type === 'compaction')).toEqual([saved]);
    const { session } = await createAgentSession({
      cwd: probe.root, agentDir: probe.root, model: probe.runtime.getModel('virtual', 'auto')!,
      modelRuntime: probe.runtime, resourceLoader: probe.loader, settingsManager: probe.settings,
      sessionManager: restored, tools: [], thinkingLevel: 'off',
    });
    cleanup.push(() => session.dispose());
    await session.bindExtensions({});
    await session.prompt('Continue the restored session', { expandPromptTemplates: false });
    expect(session.getLastAssistantText()).toBe('ANSWER-B');
    expect(probe.serving()).toHaveLength(2);
    expect(probe.serving()[1].tokens).toBeLessThan(272_000 - 16_384);
    expect(restored.getBranch().filter((entry) => entry.type === 'compaction')).toHaveLength(1);
  });

  it('cancellation during native summary dispatches no target and persists no compaction', async () => {
    const holdSummary = { entered: deferred(), release: deferred() };
    const probe = await makeProbe({ guard: 'abort', holdSummary });
    const prompt = probe.session.prompt('Continue', { expandPromptTemplates: false });
    await holdSummary.entered.promise;
    const abort = probe.session.abort();
    holdSummary.release.resolve();
    await Promise.all([abort, prompt]);
    expect(probe.compactions()).toHaveLength(0);
    expect(probe.serving()).toEqual([]);
  });
});
