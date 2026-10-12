/**
 * Provider registration and orchestration tests for `router/auto`.
 *
 * These tests cover provider-level orchestration and its integration with
 * delegation: route-up system-prompt injection, thinking-level re-adaptation,
 * registry model registration, status reporting, and the
 * decision-log/lastDecision consistency smoke for top-pick
 * and fallback turns. Fallback-lifecycle policy itself (failover, retries,
 * timeouts, circuit breaking, abort/cleanup, and bounded auth-metadata
 * lookup) is owned directly by `delegation.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import type { Api, Context, Model } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { expandModelCandidates } from './provider.js';
import { setDelegationTimeouts } from './delegation.js';
import { CONTINUE_TURN, handleContractToolCall, submitExecutionContract, trackContractToolResult } from './execution-contract-tool.js';
import { prepareHandoffFacts, submitContextHandoff } from './context-handoff-tool.js';
import { submitCompleteWork } from './complete-work-tool.js';
import { gateCompletedWorkToolCall } from './completed-work-gate.js';
import { ROUTER_TOOLS_ON_NOTE } from './router-tools-note.js';
import type { RouterSession } from './router-session-state.js';
import { ACQUISITION_REQUEST_LIMIT } from '../routing/policy/context-acquisition.js';
import { contractMeta } from '../routing/policy/execution-contract.js';
import type { FactsLog } from '../routing/policy/change-facts.js';
import { createTempRouterDir } from '../test-support/temp-router-dir.js';
import { candidatePolicyRun, registryModel } from '../test-support/router-fixtures.js';

afterEach(() => { vi.unstubAllEnvs(); });
import { SessionTree } from '../test-support/session-tree.js';
import {
  asStream,
  expectDecisionContract,
  fetchDecisionContractHandles,
  benchStoreJson,
  setupProviderTest,
  type ProviderTestHarness,
  type ResolvedRequestAuth,
} from '../test-support/provider-harness.js';
import type { BenchModel } from '../types.js';
import { defaultBlacklistState } from './blacklist.js';
import { savePreferences } from '../config.js';

/**
 * A struggle of `fromModel` after its recovery attempt on the same model, so
 * the escalation applies. The first struggle of a model is a recovery attempt.
 */
function setStruggleAfterRecovery(
  session: RouterSession,
  ...args: Parameters<RouterSession['setPendingTrajectoryEscalation']>
): void {
  const fromModel = args[1];
  if (fromModel) {
    session.claimTrajectoryRecovery(fromModel);
    session.takeTrajectoryRecoveryNotice();
  }
  session.setPendingTrajectoryEscalation(...args);
}

describe('candidate expansion — model × measured effort', () => {
  const benchRow = (effort: string, quality: number): BenchModel => ({
    registryId: 'p/model',
    benchSlug: `model-${effort}`,
    active: true,
    effort: effort as BenchModel['effort'],
    quality: { intelligence: quality },
    priceInputPer1M: 1,
    priceOutputPer1M: 2,
    source: 'aa',
  });

  it('emits one candidate per measured, supported effort', () => {
    const model = registryModel('p/model', {
      reasoning: true,
      thinkingLevelMap: {
        off: 'off',
        minimal: 'minimal',
        low: 'low',
        medium: 'medium',
        high: 'high',
        xhigh: 'xhigh',
        max: 'max',
      },
    });
    const candidates = expandModelCandidates(model, [
      benchRow('off', 20),
      benchRow('high', 50),
      benchRow('max', 60),
    ]);
    expect(candidates).toHaveLength(3);
    expect(candidates.map((c) => c.registryId).every((id) => id === 'p/model')).toBe(true);
    expect(candidates.map((c) => `${c.registryId}:${c.effort}`).sort()).toEqual([
      'p/model:high',
      'p/model:max',
      'p/model:off',
    ]);
    // Each candidate binds its own measured row, not the model's first row.
    const max = candidates.find((c) => c.effort === 'max');
    expect(max?.bench?.quality.intelligence).toBe(60);
    const low = candidates.find((c) => c.effort === 'off');
    expect(low?.bench?.quality.intelligence).toBe(20);
  });

  // Estimation is opt-in on the caller supplying a per-step drop: with no
  // drop there is nothing to step down by, so an unmeasured effort stays out
  // of the candidate set rather than being emitted at its anchor's quality.
  it('emits no unmeasured effort when the store supplied no per-step drop', () => {
    const model = registryModel('p/model', {
      reasoning: true,
      thinkingLevelMap: { off: 'off', low: 'low', medium: 'medium', high: 'high', max: 'max' },
    });
    const candidates = expandModelCandidates(model, [benchRow('low', 30)]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.effort).toBe('low');
  });

  it('estimates a supported effort below a measured row, marked as estimated', () => {
    const model = registryModel('p/model', {
      reasoning: true,
      thinkingLevelMap: { off: 'off', low: 'low', medium: 'medium', high: 'high', max: 'max' },
    });
    const candidates = expandModelCandidates(model, [benchRow('high', 50)], {
      intelligence: 6,
    });
    const byEffort = new Map(candidates.map((c) => [c.effort, c]));

    expect(byEffort.get('high')?.bench?.quality.intelligence).toBe(50);
    expect(byEffort.get('high')?.bench?.qualityEstimated).toBeUndefined();
    // One step down from the measured `high`, two steps for `low`.
    expect(byEffort.get('medium')?.bench?.quality.intelligence).toBeCloseTo(44, 5);
    expect(byEffort.get('medium')?.bench?.qualityEstimated).toBe(true);
    expect(byEffort.get('low')?.bench?.quality.intelligence).toBeCloseTo(38, 5);
    // `max` sits above every measured row, so nothing is invented for it.
    expect(byEffort.has('max')).toBe(false);
  });

  it('never estimates an effort the model cannot serve', () => {
    const model = registryModel('p/model', {
      reasoning: true,
      thinkingLevelMap: { off: 'off', low: 'low', medium: null, high: 'high', max: 'max' },
    });
    const candidates = expandModelCandidates(model, [benchRow('high', 50)], {
      intelligence: 6,
    });
    expect(candidates.some((c) => c.effort === 'medium')).toBe(false);
    expect(candidates.some((c) => c.effort === 'low')).toBe(true);
  });

  it('does not emit a measured effort the model cannot serve (map entry null)', () => {
    const model = registryModel('p/model', {
      reasoning: true,
      thinkingLevelMap: { off: 'off', minimal: 'minimal', low: 'low', medium: null, high: null },
    });
    const candidates = expandModelCandidates(model, [benchRow('medium', 40), benchRow('low', 30)]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.effort).toBe('low');
  });

  it('emits exactly one effort-less candidate for a model with no effort rows', () => {
    const model = registryModel('p/model');
    const row: BenchModel = {
      registryId: 'p/model',
      benchSlug: 'model',
      active: true,
      quality: { intelligence: 40 },
      source: 'aa',
    };
    const candidates = expandModelCandidates(model, [row]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.effort).toBeUndefined();
    expect(candidates[0]?.bench).toBe(row);
  });

  it('keeps an off row for a non-reasoning model (its only serveable mode)', () => {
    const model = registryModel('p/model', { reasoning: false });
    const candidates = expandModelCandidates(model, [benchRow('off', 25)]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.effort).toBe('off');
  });

  it('emits no off candidate for a reasoning model that cannot serve off (map entry null)', () => {
    const model = registryModel('p/model', {
      reasoning: true,
      thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' },
    });
    const candidates = expandModelCandidates(model, [benchRow('off', 20), benchRow('high', 50)], { intelligence: 6 });
    expect(candidates.some((c) => c.effort === 'off')).toBe(false);
    expect(candidates.some((c) => c.effort === 'low')).toBe(true);
  });

  it('emits no off candidate on a provider that cannot turn thinking off, even from a measured row', () => {
    const model = registryModel('claude-bridge/model', {
      reasoning: true,
      thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
    });
    const candidates = expandModelCandidates(model, [benchRow('off', 20), benchRow('high', 50)]);
    expect(candidates.map((c) => c.effort)).toEqual(['high']);
  });

  it('never estimates minimal, and keeps a measured minimal row', () => {
    const model = registryModel('p/model', {
      reasoning: true,
      thinkingLevelMap: { off: 'off', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' },
    });
    const estimated = expandModelCandidates(model, [benchRow('high', 50)], { intelligence: 6 });
    expect(estimated.some((c) => c.effort === 'minimal')).toBe(false);
    // `off` is still estimated from the nearest measured row above it.
    expect(estimated.some((c) => c.effort === 'off')).toBe(true);
    const measured = expandModelCandidates(model, [benchRow('minimal', 30), benchRow('high', 50)], { intelligence: 6 });
    expect(measured.find((c) => c.effort === 'minimal')?.bench?.qualityEstimated).toBeUndefined();
  });

  it('emits a row whose effort is missing as a plain effort-less candidate when it is the only row', () => {
    const model = registryModel('p/model');
    const candidates = expandModelCandidates(model, []);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ registryId: 'p/model', effort: undefined });
    expect(candidates[0]?.bench).toBeUndefined();
  });

  it('falls back to an effort-less candidate when every measured effort is unsupported by the model map', () => {
    // A model whose only bench row is measured at 'max' but the
    // thinkingLevelMap lacks 'max' — every labelled row is unsupported.
    // The model must not be silently dropped from the fallback chain (L1).
    const model = registryModel('p/model', {
      reasoning: true,
      thinkingLevelMap: { off: 'off', low: 'low', medium: 'medium', high: null, xhigh: null, max: null },
    });
    const candidates = expandModelCandidates(model, [benchRow('max', 60)]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.effort).toBeUndefined();
    // Quality row is still bound so the scorer can use it.
    expect(candidates[0]?.bench?.quality.intelligence).toBe(60);
  });

  it('fills an empty-quality pricing stub without losing target-level metadata', () => {
    // Sources can publish exact-level price/speed data without quality indices.
    // That row is the metadata authority while quality comes from an anchor.
    const model = registryModel('p/model', {
      reasoning: true,
      thinkingLevelMap: { off: 'off', low: 'low', medium: 'medium', high: 'high', max: 'max' },
    });
    const candidates = expandModelCandidates(model, [
      benchRow('max', 60),
      { ...benchRow('medium', 0), quality: {}, latencyMsTtft: 1234 },
    ], { intelligence: 6 });
    const byEffort = new Map(candidates.map((c) => [c.effort, c]));

    expect(byEffort.get('max')?.bench?.quality.intelligence).toBe(60);
    expect(byEffort.get('max')?.bench?.qualityEstimated).toBeUndefined();
    // medium is estimated from max (3 steps down at 6/step), while its own
    // exact-level latency remains attached.
    expect(byEffort.get('medium')?.bench?.qualityEstimated).toBe(true);
    expect(byEffort.get('medium')?.bench?.quality.intelligence).toBeCloseTo(42, 5);
    expect(byEffort.get('medium')?.bench?.latencyMsTtft).toBe(1234);
  });

  it('fills missing axes on a measured off row while preserving measured intelligence', () => {
    // DeepSeek-style rows measure intelligence at off but publish coding and
    // agentic quality only at high. Missing axes can step down independently.
    const model = registryModel('p/model', {
      reasoning: true,
      thinkingLevelMap: {
        off: 'off',
        minimal: null,
        low: null,
        medium: null,
        high: 'high',
        xhigh: null,
        max: 'max',
      },
    });
    const candidates = expandModelCandidates(model, [
      { ...benchRow('off', 29.3), quality: { intelligence: 29.3 } },
      {
        ...benchRow('high', 39),
        quality: { intelligence: 39, coding: 52, agenticCoding: 30.3, research: 0.351 },
      },
      {
        ...benchRow('max', 42.1),
        quality: { intelligence: 42.1, coding: 56.2, agenticCoding: 33.7, research: 0.379 },
      },
    ], { intelligence: 5.95, coding: 7.4, agenticCoding: 7.6 });
    const byEffort = new Map(candidates.map((c) => [c.effort, c]));

    // The registry serves only off/high/max, so unsupported intermediate
    // estimates must not be emitted.
    expect([...byEffort.keys()].sort()).toEqual(['high', 'max', 'off']);
    expect(byEffort.get('off')?.bench?.quality).toEqual({
      intelligence: 29.3,
      coding: 22.4,
      agenticCoding: 0,
    });
    expect(byEffort.get('off')?.bench?.qualityEstimated).toBe(true);
  });

  it('prefers a quality-bearing row for an effort-less fallback', () => {
    const model = registryModel('p/model', {
      reasoning: true,
      thinkingLevelMap: { off: 'off', medium: null, max: null },
    });
    const candidates = expandModelCandidates(model, [
      { ...benchRow('medium', 0), quality: {} },
      benchRow('max', 60),
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.effort).toBeUndefined();
    expect(candidates[0]?.bench?.quality.intelligence).toBe(60);
  });

  it('does not copy unlabelled knowledge into measured effort rows', () => {
    const model = registryModel('p/model', {
      reasoning: true, thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high', max: 'max' },
    });
    const candidates = expandModelCandidates(model, [
      { ...benchRow('high', 50), quality: { intelligence: 50, knowledge: 10, research: 0.4 } },
      benchRow('max', 60),
      { ...benchRow('max', 0), effort: undefined, quality: { knowledge: -11.2 } },
    ]);
    const byEffort = new Map(candidates.map((candidate) => [candidate.effort, candidate]));
    expect(byEffort.get('max')?.bench?.quality.knowledge).toBeUndefined();
    expect(byEffort.get('high')?.bench?.quality.knowledge).toBe(10);
    expect(byEffort.get('high')?.exactQualityByEffort).toEqual({ high: { knowledge: 10, research: 0.4 } });
  });

  it('keeps an unlabelled knowledge-only row at the model default effort', () => {
    const model = registryModel('p/model', { reasoning: true });
    const candidates = expandModelCandidates(model, [
      { ...benchRow('max', 0), effort: undefined, quality: { knowledge: -11.2 } },
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.effort).toBeUndefined();
    expect(candidates[0]?.bench?.quality).toEqual({ knowledge: -11.2 });
  });

  it('keeps effort-labelled knowledge-only rows distinct', () => {
    const model = registryModel('p/model', {
      reasoning: true,
      thinkingLevelMap: { off: 'off', high: 'high', max: 'max' },
    });
    const rows = [
      { ...benchRow('high', 0), quality: { knowledge: -9.7 }, source: 'artificial-analysis' },
      { ...benchRow('max', 0), quality: { knowledge: -10 }, source: 'artificial-analysis' },
    ];

    const candidates = expandModelCandidates(model, rows);

    expect(candidates.map((candidate) => candidate.effort)).toEqual(['high', 'max']);
    expect(candidates.map((candidate) => candidate.bench?.quality.knowledge)).toEqual([-9.7, -10]);
    expect(candidates.every((candidate) =>
      candidate.exactQualityByEffort?.high?.knowledge === -9.7
      && candidate.exactQualityByEffort.max?.knowledge === -10,
    )).toBe(true);
  });
});

// Every test starts with a fresh, empty config/store/log directory so no test
// can read another test's files (or the user's real ~/.pi/agent/pi8/).
// The temp dir also serves as the decision-log base for the turn.
let temp: ReturnType<typeof createTempRouterDir>;

beforeEach(() => {
  temp = createTempRouterDir();
});

afterEach(async () => {
  setDelegationTimeouts();
  const { setDecisionLogBase } = await import('../host/decisionlog.js');
  setDecisionLogBase(undefined);
  defaultBlacklistState.clearBlacklistedModels();
  vi.useRealTimers();
  vi.restoreAllMocks();
  temp.cleanup();
});

vi.mock('@earendil-works/pi-ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@earendil-works/pi-ai')>()),
  createAssistantMessageEventStream: vi.fn(),
  // Real transient-error classifier: retry only on overload/5xx/rate-limit/network.
  isRetryableAssistantError: (m: { stopReason?: string; errorMessage?: string }) =>
    m?.stopReason === 'error' &&
    !!m.errorMessage &&
    /(overloaded|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|network|timeout|connection)/i.test(
      m.errorMessage,
    ),
}));
vi.mock('@earendil-works/pi-ai/compat', () => ({
  streamSimple: vi.fn(),
}));

/** Every plan target exists; the router measured nothing else. */
const EXISTING_TARGETS = { missingTargets: 0 };

const REGISTRY_MODELS = [
  registryModel('alpha/first', {
    contextWindow: 200000,
    maxTokens: 8192,
    reasoning: true,
    thinkingLevelMap: { off: 'off', low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null },
    cost: { input: 1, output: 5, cacheRead: 0, cacheWrite: 0 },
  }),
  registryModel('beta/second', {
    contextWindow: 200000,
    maxTokens: 8192,
    reasoning: true,
    thinkingLevelMap: { off: 'off', high: 'high', xhigh: null, max: 'max' },
    cost: { input: 1, output: 5, cacheRead: 0, cacheWrite: 0 },
  }),
];

function contextForTree(tree: SessionTree) {
  return { cwd: temp.path, model: { provider: 'router', id: 'auto' }, sessionManager: tree.manager() };
}

async function prepareSelectedWork(harness: ProviderTestHarness, tree: SessionTree, prompt: string) {
  tree.user(prompt, Date.now());
  const context = { messages: tree.getBranch().filter((e) => e.type === 'message')
    .map((e) => ({ role: e.message!.role, content: e.message!.content, timestamp: e.message!.timestamp })) } as unknown as Context;
  await harness.serve(context);
  const params = { outcome: 'ready', deliverable: 'implement', complexity: 'trivial', scope: 'bounded', findings: 'request examined',
    question: 'implement the selected work', workItemId: 'NEW_WORK_ITEM', topicTitle: 'Parser', workItemTitle: 'Parser change' };
  const ctx = contextForTree(tree);
  const facts = await prepareHandoffFacts(params, ctx as never, harness.session,
    async () => ({ stdout: '', stderr: '', code: 0 }) as never);
  expect(submitContextHandoff(params, ctx as never, harness.session, facts).accepted).toBe(true);
  return context;
}

describe('benchmark data prerequisite', () => {
  const missing = { ready: false as const, message: 'router/auto has no benchmark data. Run /router-sync <key>.' };

  it('returns one setup error and never delegates without benchmark data', async () => {
    const harness = await setupProviderTest({ dir: temp.path, benchmarkCheck: missing });
    await harness.serve({ messages: [{ role: 'user', content: 'hi' }] } as Context);
    expect(harness.outStream.events.filter(event => event.type === 'error')).toHaveLength(1);
    expect(JSON.stringify(harness.outStream.events)).toContain('/router-sync');
    expect(harness.streamedModels()).toEqual([]);
  });

  it('serves a manual pin without benchmark data', async () => {
    const harness = await setupProviderTest({ dir: temp.path, benchmarkCheck: missing });
    harness.session.setManualModel('alpha/first');
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);
    await harness.serve({ messages: [{ role: 'user', content: 'hi' }] } as Context);
    expect(harness.streamedModels()).toEqual(['alpha/first']);
  });

  it('collects counts only for a successful serve', async () => {
    const harness = await setupProviderTest({ dir: temp.path });
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);
    await harness.serve({ systemPrompt: 'shared prompt', messages: [{ role: 'user', content: 'secret request' }] } as Context);
    const { loadModelHistory } = await import('../bench/model-history.js');
    expect([...loadModelHistory().stats.values()].reduce((n, stats) => n + stats.entries, 0)).toBeGreaterThan(0);
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(join(temp.path, 'model-events.jsonl'), 'utf8')).not.toContain('secret request');
  });
});

describe('advertised router limits', () => {
  it('advertises the served model window and output limit before the turn ends', async () => {
    const registered = vi.fn();
    const harness = await setupProviderTest({
      dir: temp.path,
      models: [
        ...REGISTRY_MODELS,
        registryModel('gamma/wide', { contextWindow: 1_000_000, maxTokens: 64_000 }),
      ],
      pi: { registerProvider: registered } as unknown as ExtensionAPI,
    });
    const limits = () => {
      const config = registered.mock.calls.at(-1)?.[1] as { models: Array<{ contextWindow: number; maxTokens: number }> };
      return { contextWindow: config.models[0]!.contextWindow, maxTokens: config.models[0]!.maxTokens };
    };
    harness.providerOptions = registered.mock.calls[0]![1];
    expect(limits().contextWindow).toBe(1_000_000);

    harness.session.setManualModel('alpha/first');
    let limitsAtEnd: ReturnType<typeof limits> | undefined;
    const end = harness.outStream.end.bind(harness.outStream);
    harness.outStream.end = () => {
      limitsAtEnd = limits();
      end();
    };
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);
    await harness.serve({ messages: [{ role: 'user', content: 'hi' }] } as unknown as Context);

    expect(limitsAtEnd).toEqual({ contextWindow: 200_000, maxTokens: 8192 });
  });
});

describe('provider orchestration', () => {
  let harness: ProviderTestHarness;
  let setThinkingLevelSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    setThinkingLevelSpy = vi.fn();
    harness = await setupProviderTest({
      dir: temp.path,
      pi: { setThinkingLevel: setThinkingLevelSpy } as unknown as ExtensionAPI,
    });
  });

  async function selectedTurn(prompt: string) {
    const tree = new SessionTree();
    harness = await setupProviderTest({
      dir: temp.path, models: REGISTRY_MODELS, ctx: contextForTree(tree) as never,
      pi: { setThinkingLevel: setThinkingLevelSpy } as unknown as ExtensionAPI,
    });
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);
    const routedContext = await prepareSelectedWork(harness, tree, prompt);
    const firstReasoning = harness.delegatedCall().options?.reasoning;
    harness.resetEventStream();
    vi.mocked(streamSimple).mockClear();
    return { routedContext, firstReasoning };
  }

  const context = {
    messages: [{ role: 'user', content: 'hi' }],
  } as unknown as Context;

  it('publishes the decision returned by routing policy and delegates its chain', async () => {
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);

    await harness.serve(
      { messages: [{ role: 'user', content: 'implement the parser' }] } as unknown as Context,
    );

    const state = harness.getProviderState();
    expect(state.lastDecision?.fallbackChain[0]).toBe(state.lastDecision?.chosen);
  });

  it('serves a manual pin without fallback candidates', async () => {
    harness.session.setManualModel('alpha/first');
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);

    await harness.serve(
      { messages: [{ role: 'user', content: 'implement the parser' }] } as unknown as Context,
    );

    const decision = harness.getProviderState().lastDecision;
    expect(decision?.chosen).toBe('alpha/first');
    expect(decision?.cause).toBe('manual-override');
    expect(decision?.fallbackChain).toEqual(['alpha/first']);
    expect(harness.session.getCachedIntent()).toBeDefined();
    expect(harness.streamedModels()).toEqual(['alpha/first']);
  });

  it('names failed models, not the allowlist, when every candidate is excluded', async () => {
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);
    await harness.serve(context);
    // Exclusions are per action: exclude every effort of every model.
    for (const model of ['alpha/first', 'beta/second']) {
      for (const effort of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) harness.session.blacklistModel(`${model}:${effort}`);
    }
    harness.resetEventStream();

    await harness.serve(context);

    const error = harness.outStream.events.find((e) => e.type === 'error');
    const message = error?.error?.errorMessage ?? error?.error?.message;
    expect(message).toContain('failed earlier this session');
    expect(message).not.toContain('allowlist');
  });

  it('serves a manual pin that failed earlier this session', async () => {
    harness.session.blacklistModel('alpha/first');
    harness.session.blacklistModel('alpha/first:high');
    harness.session.setManualModel('alpha/first:high');
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);

    await harness.serve(context);

    expect(harness.streamedModels()).toEqual(['alpha/first']);
    expect(harness.outStream.events.some((e) => e.type === 'error')).toBe(false);
  });

  it('does not fall back to another model when a manual pin fails', async () => {
    harness.session.setManualModel('alpha/first');
    harness.scriptReply([{ type: 'error', error: { errorMessage: 'manual failure' } }]);

    await harness.serve(context);

    expect(harness.streamedModels()).toEqual(['alpha/first']);
    expect(harness.outStream.events.find((event) => event.type === 'error')).toBeDefined();
  });

  it('serves a manual pin that the router allowlist would exclude', async () => {
    // Auto routing is restricted to beta/*, so alpha/first is absent from the
    // router's candidate pool. A manual pin is an explicit override, so it must
    // still expand and serve alpha/first — the picker offers it like /model.
    writeFileSync(
      join(temp.path, 'config.json'),
      JSON.stringify({ models: ['beta/*'] }),
      'utf8',
    );
    harness.session.setManualModel('alpha/first');
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);

    await harness.serve(
      { messages: [{ role: 'user', content: 'implement the parser' }] } as unknown as Context,
    );

    const decision = harness.getProviderState().lastDecision;
    expect(decision?.chosen).toBe('alpha/first');
    expect(decision?.cause).toBe('manual-override');
    expect(harness.streamedModels()).toEqual(['alpha/first']);
  });

  it('resume does not reuse a route from unresolved work for a distinct request', async () => {
    // An unresolved entry cannot establish a reusable WorkItem route.
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);
    await harness.serve(
      { messages: [{ role: 'user', content: 'implement the parser' }] } as unknown as Context,
    );
    const autoDecision = harness.getProviderState().lastDecision!;
    expect(autoDecision.cause).not.toBe('resume');

    // 2. Pin the other model (snapshots the pre-pin route), then resume.
    harness.session.setManualModel('alpha/first');
    expect(harness.session.resumeManual()).toBe(true);

    // A distinct entry must collect its own WorkItem identity.
    harness.resetEventStream();
    harness.scriptReply([{ type: 'text_delta', delta: 'ok2' }, { type: 'done' }]);
    await harness.serve(
      { messages: [{ role: 'user', content: 'a completely different request now' }] } as unknown as Context,
    );
    const resumed = harness.getProviderState().lastDecision!;
    expect(autoDecision.cause).toBe('investigation');
    expect(resumed.cause).toBe('investigation');
    expect(harness.session.getWorkPhaseState()?.pendingIdentity).toBeDefined();
    expect(harness.session.context.getLedger().items.size).toBe(0);

    // The one-shot is spent even when identity cannot be resolved.
    harness.resetEventStream();
    harness.scriptReply([{ type: 'text_delta', delta: 'ok3' }, { type: 'done' }]);
    await harness.serve(
      { messages: [{ role: 'user', content: 'yet another distinct instruction' }] } as unknown as Context,
    );
    expect(harness.getProviderState().lastDecision!.cause).not.toBe('resume');
  });

  it('reports context collection consistently when no candidate has benchmark data', async () => {
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);

    await harness.serve(
      { messages: [{ role: 'user', content: 'summarize this file' }] } as unknown as Context,
    );

    // The cause-precedence row must agree across the in-memory decision, the
    // durable decision log (/router-why after restart), and the rendered detail.
    const handles = await fetchDecisionContractHandles(temp.path);
    expectDecisionContract({ ...handles, match: { cause: 'investigation' } });
  });

  it('never delegates to its own router/auto model, even as a last resort', async () => {
    // Every real model fails, so the loop is forced to walk the entire
    // fallback chain — router/auto must not be in it.
    harness.scriptReply([{ type: 'error', error: { errorMessage: 'nope' } }]);

    await harness.serve(context);

    const targets = harness.streamedModels();
    expect(targets).toEqual(expect.arrayContaining(['alpha/first', 'beta/second']));
    expect(targets.some((id) => id.startsWith('router/'))).toBe(false);
  });

  it('serves the winning candidate at its measured effort', async () => {
    // The store binds alpha/first to one effort-labelled row; expansion
    // produces the alpha/first:high candidate, and implement's floor
    // (medium) lets the measured high win — the effort must reach
    // streamSimple and the chain entry must carry it.
    writeFileSync(join(temp.path, 'benchmarks.json'), benchStoreJson({
      version: 2,
      syncedAt: Date.now(),
      aliases: {},
      models: [
        { registryId: 'alpha/first', benchSlug: 'first-high', active: true, effort: 'high', source: 'test', quality: { intelligence: 100, coding: 100, agenticCoding: 100, research: 0.9 } },
      ],
    }));
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);

    await harness.serve(
      { messages: [{ role: 'user', content: 'implement the parser' }] } as unknown as Context,
      {},
    );

    expect(harness.delegatedCall().options?.reasoning).toBe('high');
    expect(harness.getProviderState().lastDecision?.fallbackChain[0]).toBe('alpha/first:high');
  });

  it('serves a scored low effort as low after selecting implementation work', async () => {
    writeFileSync(join(temp.path, 'benchmarks.json'), benchStoreJson({
      version: 2,
      syncedAt: Date.now(),
      aliases: {},
      models: [
        { registryId: 'alpha/first', benchSlug: 'first-low', active: true, effort: 'low', source: 'test', quality: { intelligence: 100, coding: 100, agenticCoding: 100, research: 0.9 } },
      ],
    }));
    const { routedContext } = await selectedTurn('implement the parser');
    await harness.serve(routedContext, {});

    // Each effort has its own score, so the scored low effort is served as is.
    expect(harness.delegatedCall().options?.reasoning).toBe('low');
  });

  it('lets an explicit user reasoning level suppress the router effort choice', async () => {
    writeFileSync(join(temp.path, 'benchmarks.json'), benchStoreJson({
      version: 2,
      syncedAt: Date.now(),
      aliases: {},
      models: [
        { registryId: 'alpha/first', benchSlug: 'first-low', active: true, effort: 'low', source: 'test', quality: { intelligence: 100, coding: 100, agenticCoding: 100, research: 0.9 } },
      ],
    }));
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);

    await harness.serve(
      { messages: [{ role: 'user', content: 'implement the parser' }] } as unknown as Context,
      { reasoning: 'high' },
    );

    // The user asked for high; the router's measured low must not override it.
    expect(harness.delegatedCall().options?.reasoning).toBe('high');
  });

  it('does not read the level Pi echoes back as a user choice: the next scored effort serves', async () => {
    writeFileSync(join(temp.path, 'benchmarks.json'), benchStoreJson({
      version: 2,
      syncedAt: Date.now(),
      aliases: {},
      models: [
        { registryId: 'alpha/first', benchSlug: 'first-low', active: true, effort: 'low', source: 'test', quality: { intelligence: 100, coding: 100, agenticCoding: 100, research: 0.9 } },
      ],
    }));
    const { routedContext, firstReasoning } = await selectedTurn('implement a function to parse the pending adjustment payload');
    expect(firstReasoning).toBe('low');
    // The next sync scores the same model at high; Pi still echoes low.
    writeFileSync(join(temp.path, 'benchmarks.json'), benchStoreJson({
      version: 2,
      syncedAt: Date.now() + 1,
      aliases: {},
      models: [
        { registryId: 'alpha/first', benchSlug: 'first-high', active: true, effort: 'high', source: 'test', quality: { intelligence: 100, coding: 100, agenticCoding: 100, research: 0.9 } },
      ],
    }));
    await harness.serve(routedContext, { reasoning: firstReasoning });
    expect(harness.delegatedCall().options?.reasoning).toBe('high');
  });

  it('serves the measured effort after an explicit level when Pi echoes that level back', async () => {
    writeFileSync(join(temp.path, 'benchmarks.json'), benchStoreJson({
      version: 2,
      syncedAt: Date.now(),
      aliases: {},
      models: [
        { registryId: 'alpha/first', benchSlug: 'first-low', active: true, effort: 'low', source: 'test', quality: { intelligence: 100, coding: 100, agenticCoding: 100, research: 0.9 } },
      ],
    }));
    harness = await setupProviderTest({
      dir: temp.path, models: REGISTRY_MODELS,
      pi: { setThinkingLevel: setThinkingLevelSpy } as unknown as ExtensionAPI,
    });
    const request = { messages: [{ role: 'user', content: 'implement the parser' }] } as unknown as Context;
    // An explicit user level is the only legal effort of each model.
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);
    await harness.serve(request, { reasoning: 'high' });
    expect(harness.getProviderState().lastDecision?.chosen).toMatch(/:high$/);
    expect(harness.delegatedCall().options?.reasoning).toBe('high');
    harness.resetEventStream();
    vi.mocked(streamSimple).mockClear();

    // Pi echoes high back. An echoed level is not a user choice, and no
    // incumbent minimum keeps the unmeasured effort: the measured row serves.
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);
    await harness.serve(request, { reasoning: 'high' });
    expect(harness.getProviderState().lastDecision?.chosen).toBe('alpha/first:low');
    expect(harness.delegatedCall().options?.reasoning).toBe('low');
  });

  it('never routes to a provider that rejects delegated calls, even when it scores best', async () => {
    writeFileSync(join(temp.path, 'benchmarks.json'), benchStoreJson({
      version: 2, syncedAt: Date.now(), aliases: {},
      models: [
        { registryId: 'cursor/grok', benchSlug: 'g', active: true, effort: 'high', source: 'test', quality: { intelligence: 95, coding: 95, agenticCoding: 95, research: 0.855 }, costPerTask: 0.1, timePerTaskSeconds: 1 },
        { registryId: 'alpha/first', benchSlug: 'a', active: true, effort: 'high', source: 'test', quality: { intelligence: 90, coding: 90, agenticCoding: 90, research: 0.81 }, costPerTask: 5, timePerTaskSeconds: 5 },
      ],
    }));
    const cursor = registryModel('cursor/grok', { contextWindow: 200000, maxTokens: 8192, reasoning: true, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    harness = await setupProviderTest({ dir: temp.path, models: [...REGISTRY_MODELS, cursor], pi: { setThinkingLevel: setThinkingLevelSpy } as unknown as ExtensionAPI });
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);
    await harness.serve({ messages: [{ role: 'user', content: 'what does the cache module do' }] } as unknown as Context);
    const decision = harness.getProviderState().lastDecision!;
    expect(decision.chosen).toBe('alpha/first:high');
    expect(decision.fallbackChain.filter((key) => key.startsWith('cursor/'))).toEqual([]);
  });

  it.each([false, true])('treats as incumbent only a model the router still serves (ended=%s)', async (ended) => {
    writeFileSync(join(temp.path, 'benchmarks.json'), benchStoreJson({
      version: 2, syncedAt: Date.now(), aliases: {},
      models: [
        { registryId: 'alpha/first', benchSlug: 'a', active: true, effort: 'high', source: 'test', quality: { intelligence: 90, coding: 90, agenticCoding: 90, research: 0.81 }, costPerTask: 5, timePerTaskSeconds: 5 },
        { registryId: 'beta/second', benchSlug: 'b', active: true, effort: 'high', source: 'test', quality: { intelligence: 50, coding: 50, agenticCoding: 50, research: 0.45 }, costPerTask: 1, timePerTaskSeconds: 1 },
      ],
    }));
    harness = await setupProviderTest({ dir: temp.path, models: REGISTRY_MODELS, pi: { setThinkingLevel: setThinkingLevelSpy } as unknown as ExtensionAPI });
    // The router served the strong model, then Pi selected a concrete model
    // (ended) or kept router/auto.
    harness.session.setLastServed({ registryId: 'alpha/first', thinkingLevel: 'high', viaFallback: false, accumulatedCost: 0 });
    harness.session.context.clearIncumbent();
    if (ended) harness.session.endServing();
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);
    await harness.serve({ messages: [{ role: 'user', content: 'what does the cache module do' }] } as unknown as Context);
    const decision = harness.getProviderState().lastDecision!;
    expect(decision.dimension).toBe('gather');
    // `switched` is set only against an incumbent.
    expect(decision.switched === undefined).toBe(ended);
  });

  it('sends the effort it scored, call after call, without a user thinking level', async () => {
    const row = (effort: string, intelligence: number, costPerTask: number) => ({
      registryId: 'alpha/first', benchSlug: `first-${effort}`, active: true, effort, source: 'test',
      quality: { intelligence, coding: 100, agenticCoding: 100, research: 0.9 }, costPerTask, timePerTaskSeconds: costPerTask,
    });
    const sync = (syncedAt: number, models: unknown[]) =>
      writeFileSync(join(temp.path, 'benchmarks.json'), benchStoreJson({ version: 2, syncedAt, aliases: {}, models }));
    harness = await setupProviderTest({
      dir: temp.path, models: REGISTRY_MODELS,
      pi: { setThinkingLevel: setThinkingLevelSpy } as unknown as ExtensionAPI,
    });
    const request = { messages: [{ role: 'user', content: 'implement the parser' }] } as unknown as Context;
    const serveAndCompare = async () => {
      harness.resetEventStream();
      vi.mocked(streamSimple).mockClear();
      harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);
      // Pi passes back the level the router synced, which is not a user choice.
      await harness.serve(request, { reasoning: setThinkingLevelSpy.mock.calls.at(-1)?.[0] });
      const chosen = harness.getProviderState().lastDecision!.chosen;
      expect(harness.delegatedCall().options?.reasoning).toBe(chosen.split(':')[1]);
      return chosen;
    };

    sync(Date.now(), [row('high', 100, 5)]);
    expect(await serveAndCompare()).toBe('alpha/first:high');
    // A cheaper low row appears while the same request continues. The
    // incumbent served at high, so the router scores and sends high.
    sync(Date.now() + 1, [row('high', 100, 5), row('low', 100, 1)]);
    expect(await serveAndCompare()).toBe('alpha/first:high');
    expect(await serveAndCompare()).toBe('alpha/first:high');
  });

  it('syncs Pi\'s own thinking-level state to the served effort', async () => {
    // The footer/session state only updates via pi.setThinkingLevel; without
    // this call it would keep showing whatever level the user last set
    // manually, never reflecting what the router actually picked per-turn.
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);

    writeFileSync(join(temp.path, 'benchmarks.json'), benchStoreJson({
      version: 2,
      syncedAt: Date.now(),
      aliases: {},
      models: [
        { registryId: 'alpha/first', benchSlug: 'first-high', active: true, effort: 'high', source: 'test', quality: { intelligence: 100, coding: 100, agenticCoding: 100, research: 0.9 } },
      ],
    }));
    const { routedContext } = await selectedTurn('implement a function to parse the pending adjustment payload');
    setThinkingLevelSpy.mockClear();
    await harness.serve(routedContext, {});

    expect(setThinkingLevelSpy).toHaveBeenCalledWith('high');
  });

  it('never lets a footer-sync failure break the turn', async () => {
    setThinkingLevelSpy.mockImplementation(() => {
      throw new Error('footer unavailable');
    });
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);

    await harness.serve(context);

    expect(harness.outStream.events.filter((e) => e.type === 'error')).toHaveLength(0);
  });

  it('registers only the generic router/auto model', () => {
    const ids = (harness.providerOptions.models as Array<{ id: string }>).map((m) => m.id);
    expect(ids).toEqual(['auto']);
  });

  it('advertises reasoning support on router models with a union thinking map', () => {
    const routerModels = harness.providerOptions.models as Array<{ id: string; reasoning?: boolean; thinkingLevelMap?: Record<string, string | null> }>;
    const auto = routerModels.find((m) => m.id === 'auto');
    expect(auto?.reasoning).toBe(true);
    expect(auto?.thinkingLevelMap?.high).toBe('high');
    expect(auto?.thinkingLevelMap?.max).toBe('max');
  });

  it('never makes context size the cause or the task type of a long-context turn', async () => {
    writeFileSync(join(temp.path, 'config.json'), JSON.stringify({ lowConfidenceThreshold: 1 }, null, 2));
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);

    const longContext = {
      messages: [{ role: 'user', content: `analyze this ${'a'.repeat(500000)}` }],
    } as unknown as Context;

    await harness.serve(longContext);

    const { lastDecision } = harness.getProviderState();
    const handles = await fetchDecisionContractHandles(temp.path);
    expectDecisionContract({ ...handles, match: { cause: lastDecision?.cause, dimension: lastDecision?.dimension } });
    expect(lastDecision?.cause).not.toBe('context-pressure');
    // Every dispatched action holds the prompt.
    expect(lastDecision?.unified?.holdingPrompt).toBe(lastDecision?.fallbackChain.length);
  });

  it('treats a literal "!escalate" in prompt text as ordinary content', async () => {
    writeFileSync(join(temp.path, 'config.json'), JSON.stringify({ lowConfidenceThreshold: 1 }, null, 2));
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);

    const longEscalatedContext = {
      messages: [{ role: 'user', content: `!escalate ${'a'.repeat(500000)}` }],
    } as unknown as Context;

    await harness.serve(longEscalatedContext);

    const { lastDecision } = harness.getProviderState();
    // Routing comes from the ordinary passive path; the prompt text earns no
    // escalation cause of its own.
    expect(lastDecision?.reason).not.toContain('[manual:');
    expect(lastDecision?.cause).not.toBe('manual-override');
  });
});

describe('semi-automatic confirmation gate', () => {
  // `alpha/first` is the routed pick, so a `beta/second` incumbent is a real
  // switch; `beta/second` stays a routable candidate (it just loses on
  // quality), so the "keep" path has something to serve.
  const semiConfig = { semi: true };
  // Both measured at the same effort and price: alpha/first is better on every
  // quality axis, so it wins for every admissible weight vector.
  const semiBenchmarks = [
    {
      registryId: 'alpha/first',
      benchSlug: 'a',
      active: true,
      effort: 'high',
      source: 'test',
      quality: { intelligence: 100, coding: 100, agenticCoding: 100, research: 0.9 },
    },
    {
      registryId: 'beta/second',
      benchSlug: 'b',
      active: true,
      effort: 'high',
      source: 'test',
      quality: { intelligence: 10, coding: 10, agenticCoding: 10, research: 0.09 },
    },
  ] as unknown as Parameters<typeof setupProviderTest>[0]['benchmarks'];
  const implementTurn = {
    messages: [{ role: 'user', content: 'implement the parser' }],
  } as unknown as Context;

  type UiMock = {
    select: ReturnType<typeof vi.fn>;
    input: ReturnType<typeof vi.fn>;
    notify: ReturnType<typeof vi.fn>;
  };
  function makeUi(over: Partial<UiMock> = {}): UiMock {
    return {
      select: vi.fn(async () => undefined),
      input: vi.fn(async () => undefined),
      notify: vi.fn(),
      ...over,
    };
  }
  async function semiHarness(ui?: UiMock): Promise<ProviderTestHarness> {
    return setupProviderTest({
      dir: temp.path,
      config: semiConfig,
      benchmarks: semiBenchmarks,
      ...(ui ? { ctx: { hasUI: true, ui: ui as unknown as ExtensionContext['ui'] } } : {}),
    });
  }
  const incumbent = () => ({ registryId: 'beta/second', viaFallback: false, accumulatedCost: 0 });

  it('accepts the switch when the user picks "Use <new>"', async () => {
    const ui = makeUi({ select: vi.fn(async (_t: string, opts: string[]) => opts[0]) });
    const harness = await semiHarness(ui);
    harness.session.setLastServed(incumbent());
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);

    await harness.serve(implementTurn);

    expect(ui.select).toHaveBeenCalledTimes(1);
    expect(ui.input).not.toHaveBeenCalled();
    expect(harness.streamedModels()).toEqual(['alpha/first']);
    // "Use" keeps the router's own cause; it is not a hold or a pin.
    expect(harness.getProviderState().lastDecision?.cause).not.toBe('semi-hold');
    expect(harness.getProviderState().lastDecision?.cause).not.toBe('manual-override');
  });

  it('keeps the incumbent for this turn only when the user declines', async () => {
    const ui = makeUi({ select: vi.fn(async (_t: string, opts: string[]) => opts[1]) });
    const harness = await semiHarness(ui);
    harness.session.setLastServed(incumbent());
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);

    await harness.serve(implementTurn);

    const decision = harness.getProviderState().lastDecision;
    expect(decision?.cause).toBe('semi-hold');
    // The measured row is labelled with its effort.
    expect(decision?.chosen).toBe('beta/second:high');
    expect(decision?.fallbackChain).toEqual(['beta/second:high']);
    expect(harness.streamedModels()).toEqual(['beta/second']);
    // A hold is transient: it must not create a persistent manual pin.
    expect(harness.session.getManualModel()).toBeUndefined();
  });

  it('pins a specific model (acts as /router-manual) when the user picks one', async () => {
    const ui = makeUi({
      select: vi.fn(async (_t: string, opts: string[]) => opts[2]),
      input: vi.fn(async () => 'beta/second'),
    });
    const harness = await semiHarness(ui);
    harness.session.setLastServed(incumbent());
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);

    await harness.serve(implementTurn);

    const decision = harness.getProviderState().lastDecision;
    expect(decision?.cause).toBe('manual-override');
    expect(decision?.chosen).toBe('beta/second:high');
    expect(harness.streamedModels()).toEqual(['beta/second']);
    // The pin persists so subsequent turns take the manual path.
    expect(harness.session.getManualModel()).toBe('beta/second');
  });

  it('does not prompt on the first pick (no incumbent to switch from)', async () => {
    const ui = makeUi();
    const harness = await semiHarness(ui);
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);

    await harness.serve(implementTurn);

    expect(ui.select).not.toHaveBeenCalled();
    expect(harness.streamedModels()).toEqual(['alpha/first']);
  });

  it('does not prompt when the routed pick equals the incumbent', async () => {
    const ui = makeUi();
    const harness = await semiHarness(ui);
    harness.session.setLastServed({ registryId: 'alpha/first', viaFallback: false, accumulatedCost: 0 });
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);

    await harness.serve(implementTurn);

    expect(ui.select).not.toHaveBeenCalled();
    expect(harness.streamedModels()).toEqual(['alpha/first']);
  });

  it('is a no-op without an interactive UI', async () => {
    const harness = await semiHarness(); // no ctx.ui
    harness.session.setLastServed(incumbent());
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);

    await harness.serve(implementTurn);

    // Semi cannot ask, so it must degrade to the router's pick, never block.
    expect(harness.streamedModels()).toEqual(['alpha/first']);
    expect(harness.getProviderState().lastDecision?.cause).not.toBe('semi-hold');
  });

  it('cancels the turn when the switch prompt is dismissed', async () => {
    const ui = makeUi();
    const harness = await semiHarness(ui);
    harness.session.setLastServed(incumbent());
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);

    await harness.serve(implementTurn);

    expect(ui.select).toHaveBeenCalledTimes(1);
    expect(harness.streamedModels()).toEqual([]);
    expect(harness.outStream.events.some((event) => event.type === 'error')).toBe(true);
  });

  it('pins provider/id:thinking as a manual override', async () => {
    const ui = makeUi({
      select: vi.fn(async (_t: string, opts: string[]) => opts[2]),
      input: vi.fn(async () => 'beta/second:high'),
    });
    const harness = await semiHarness(ui);
    harness.session.setLastServed(incumbent());
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);

    await harness.serve(implementTurn);

    expect(harness.getProviderState().lastDecision?.cause).toBe('manual-override');
    expect(harness.session.getManualModel()).toBe('beta/second:high');
    expect(harness.streamedModels()).toEqual(['beta/second']);
    expect(harness.delegatedCall().options?.reasoning).toBe('high');
  });

  it('asks before serving a fallback candidate', async () => {
    const ui = makeUi({ select: vi.fn(async (_t: string, opts: string[]) => opts[0]) });
    const harness = await semiHarness(ui);
    harness.scriptReply((model) => {
      if (`${model.provider}/${model.id}` === 'alpha/first') {
        return asStream([{ type: 'error', error: { errorMessage: '421' } }]);
      }
      return asStream([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);
    });

    await harness.serve(implementTurn);

    expect(ui.select).toHaveBeenCalledTimes(1);
    expect(harness.streamedModels()).toEqual(['alpha/first', 'beta/second']);
  });

  it('keeps manual-override cause when a specific fallback model serves', async () => {
    const ui = makeUi({
      select: vi.fn(async (_t: string, opts: string[]) => opts[2]),
      input: vi.fn(async () => 'beta/second'),
    });
    const harness = await semiHarness(ui);
    harness.scriptReply((model) => {
      if (`${model.provider}/${model.id}` === 'alpha/first') {
        return asStream([{ type: 'error', error: { errorMessage: '421' } }]);
      }
      return asStream([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);
    });

    await harness.serve(implementTurn);

    expect(ui.input).toHaveBeenCalledTimes(1);
    expect(harness.streamedModels()).toEqual(['alpha/first', 'beta/second']);
    expect(harness.getProviderState().lastDecision?.chosen).toBe('beta/second:high');
    expect(harness.getProviderState().lastDecision?.cause).toBe('manual-override');
  });

  it('serves a specific fallback model at its selected thinking level', async () => {
    const ui = makeUi({
      select: vi.fn(async (_t: string, opts: string[]) => opts[2]),
      input: vi.fn(async () => 'beta/second:high'),
    });
    const harness = await semiHarness(ui);
    harness.scriptReply((model) => {
      if (`${model.provider}/${model.id}` === 'alpha/first') {
        return asStream([{ type: 'error', error: { errorMessage: '421' } }]);
      }
      return asStream([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);
    });

    await harness.serve(implementTurn);

    expect(harness.streamedModels()).toEqual(['alpha/first', 'beta/second']);
    expect(harness.delegatedCall(1).options?.reasoning).toBe('high');
    expect(harness.getProviderState().lastDecision?.chosen).toBe('beta/second:high');
    expect(harness.getProviderState().lastDecision?.cause).toBe('manual-override');
  });

  it('cancels a fallback switch when the user declines', async () => {
    const ui = makeUi({ select: vi.fn(async (_t: string, opts: string[]) => opts[1]) });
    const harness = await semiHarness(ui);
    harness.scriptReply((model) => {
      if (`${model.provider}/${model.id}` === 'alpha/first') {
        return asStream([{ type: 'error', error: { errorMessage: '421' } }]);
      }
      return asStream([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);
    });

    await harness.serve(implementTurn);

    expect(ui.select).toHaveBeenCalledTimes(1);
    expect(harness.streamedModels()).toEqual(['alpha/first']);
    expect(harness.outStream.events.some((event) => event.type === 'error')).toBe(true);
  });
});

describe('a thinking-level change the router did not write pins the served model', () => {
  // Stateful stand-in for Pi's session thinking level: the router's footer
  // sync writes it, and Pi sends it back as `options.reasoning` (omitted for `off`).
  let level: string;
  let harness: ProviderTestHarness;
  const implement = { messages: [{ role: 'user', content: 'implement the parser' }] } as unknown as Context;
  const piReasoning = (): Parameters<ProviderTestHarness['serve']>[1] =>
    (level === 'off' ? {} : { reasoning: level } as Parameters<ProviderTestHarness['serve']>[1]);

  beforeEach(async () => {
    level = 'off';
    harness = await setupProviderTest({
      dir: temp.path,
      pi: {
        setThinkingLevel: (next: string) => { level = next; },
        getThinkingLevel: () => level,
      } as unknown as ExtensionAPI,
    });
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);
  });

  const nextTurn = (): void => {
    harness.resetEventStream();
    vi.mocked(streamSimple).mockClear();
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);
  };

  it('pins the previously served model at the newly selected level', async () => {
    await harness.serve(implement, piReasoning());
    const served = harness.getProviderState().lastServed!.registryId;
    const target = level === 'high' ? 'low' : 'high';

    nextTurn();
    level = target;
    await harness.serve(implement, piReasoning());

    expect(harness.session.getManualModel()).toBe(`${served}:${target}`);
    expect(harness.streamedModels()).toEqual([served]);
    expect(harness.delegatedCall().options?.reasoning).toBe(target);
    expect(harness.getProviderState().lastDecision?.cause).toBe('manual-override');
  });

  it('does not pin when Pi echoes the level the router synced', async () => {
    await harness.serve(implement, piReasoning());

    nextTurn();
    await harness.serve(implement, piReasoning());

    expect(harness.session.getManualModel()).toBeUndefined();
  });

  it('does not pin before any model has served', async () => {
    level = 'high';
    await harness.serve(implement, piReasoning());

    expect(harness.session.getManualModel()).toBeUndefined();
  });

  it('moves an existing pin to the new level, clamped to what the model supports', async () => {
    harness.session.setManualModel('alpha/first:low');
    await harness.serve(implement, piReasoning());

    nextTurn();
    level = 'xhigh';
    await harness.serve(implement, piReasoning());

    expect(harness.session.getManualModel()).toBe('alpha/first:high');
    expect(harness.delegatedCall().options?.reasoning).toBe('high');
  });

  // Another extension (for example a background memory agent) can call the
  // session model with its own abort signal and its own reasoning level. That
  // level applies to its request only: it is not a thinking-level change, and
  // the router must not write it into Pi's session level.
  it('serves a request with its own signal at its level, without a pin or a session change', async () => {
    level = 'high';
    await harness.serve(implement, piReasoning());
    const sessionLevel = level;
    const other = sessionLevel === 'low' ? 'high' : 'low';

    nextTurn();
    await harness.serve(implement, { reasoning: other, signal: new AbortController().signal } as Parameters<ProviderTestHarness['serve']>[1]);

    expect(harness.delegatedCall().options?.reasoning).toBe(other);
    expect(harness.session.getManualModel()).toBeUndefined();
    expect(level).toBe(sessionLevel);

    nextTurn();
    await harness.serve(implement, piReasoning());

    expect(harness.session.getManualModel()).toBeUndefined();
    expect(harness.getProviderState().lastDecision?.cause).not.toBe('manual-override');
    // Delegation omits `reasoning` for `off`.
    expect(harness.delegatedCall().options?.reasoning).toBe(sessionLevel === 'off' ? undefined : sessionLevel);
  });

  it('serves a request at a level other than the session level without a pin or a session change', async () => {
    level = 'high';
    await harness.serve(implement, piReasoning());
    const sessionLevel = level;
    const other = sessionLevel === 'low' ? 'high' : 'low';

    nextTurn();
    await harness.serve(implement, { reasoning: other } as Parameters<ProviderTestHarness['serve']>[1]);

    expect(harness.delegatedCall().options?.reasoning).toBe(other);
    expect(harness.session.getManualModel()).toBeUndefined();
    expect(level).toBe(sessionLevel);
  });
});

describe('incumbent keeps serving across unresolved entries', () => {
  // Gathering an unresolved entry keeps the selected work's model and task type.
  let harness: ProviderTestHarness;
  let tree: SessionTree;

  beforeEach(async () => {
    tree = new SessionTree();
    harness = await setupProviderTest({
      dir: temp.path,
      ctx: contextForTree(tree) as never,
      config: { lowConfidenceThreshold: 0.99 },
      benchmarks: [
        {
          registryId: 'alpha/strong',
          benchSlug: 'strong',
          active: true,
          quality: { intelligence: 95, coding: 95, agenticCoding: 95, research: 0.855 },
          source: 'test',
        },
        {
          registryId: 'beta/cheap',
          benchSlug: 'cheap',
          active: true,
          quality: { intelligence: 60, coding: 60, agenticCoding: 60, research: 0.54 },
          source: 'test',
        },
      ],
      models: [
        registryModel('alpha/strong', { contextWindow: 200000, maxTokens: 8192 }),
        registryModel('beta/cheap', { contextWindow: 200000, maxTokens: 8192 }),
      ],
      pi: { setThinkingLevel: vi.fn() } as unknown as ExtensionAPI,
    });
  });

  it('keeps the selected work’s model and task type across two unresolved entries', async () => {
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);
    const selectedContext = await prepareSelectedWork(harness, tree, 'implement the retry logic across the module');
    harness.resetEventStream();
    await harness.serve(selectedContext);
    expect(harness.getProviderState().lastDecision?.dimension).toBe('implement');
    expect(harness.getProviderState().lastServed?.registryId).toBe('alpha/strong');

    async function nextEntry(prompt: string) {
      tree.assistant('done');
      tree.user(prompt, Date.now() + tree.getBranch().length);
      const messages = tree.getBranch().filter((e) => e.type === 'message')
        .map((e) => ({ role: e.message!.role, content: e.message!.content, timestamp: e.message!.timestamp }));
      harness.resetEventStream();
      await harness.serve({ messages } as unknown as Context);
      return harness.getProviderState().lastDecision;
    }
    // The incumbent serves each later entry at the selected work's task type.
    const turn2 = await nextEntry('give me today’s weather forecast');
    expect(turn2?.dimension).toBe('implement');
    expect(harness.getProviderState().lastServed?.registryId).toBe('alpha/strong');

    const turn3 = await nextEntry('what is a good pancake topping?');
    expect(turn3?.dimension).toBe('implement');
    expect(harness.getProviderState().lastServed?.registryId).toBe('alpha/strong');
  });
});

describe('router/auto advertised contextWindow', () => {
  it('defaults to the largest window among routable (allowlisted) models, not every registry model', async () => {
    const harness = await setupProviderTest({
      dir: temp.path,
      // The huge window belongs to a provider the allowlist excludes; it must
      // not leak into the advertised default.
      config: { models: ['alpha/*'] },
      models: [
        registryModel('alpha/small', { contextWindow: 250000, maxTokens: 4096 }),
        registryModel('zeta/huge', { contextWindow: 1_000_000, maxTokens: 200000 }),
      ],
      includeRouterModel: false,
      pi: { setThinkingLevel: vi.fn() } as unknown as ExtensionAPI,
    });

    const routerModel = harness.providerOptions.models?.find(
      (m) => (m as { id: string }).id === 'auto',
    ) as { contextWindow?: number } | undefined;
    expect(routerModel?.contextWindow).toBe(250000);
  });

  it('advertises the real routable max even when it sits below the synthetic 200k fallback', async () => {
    // No floor at DEFAULT_CONTEXT_WINDOW: a genuinely small routable maximum
    // must be advertised as-is, not inflated to 200k.
    const harness = await setupProviderTest({
      dir: temp.path,
      config: { models: ['alpha/*'] },
      models: [
        registryModel('alpha/small', { contextWindow: 50000, maxTokens: 2048 }),
        registryModel('zeta/huge', { contextWindow: 1_000_000, maxTokens: 200000 }),
      ],
      includeRouterModel: false,
      pi: { setThinkingLevel: vi.fn() } as unknown as ExtensionAPI,
    });

    const routerModel = harness.providerOptions.models?.find(
      (m) => (m as { id: string }).id === 'auto',
    ) as { contextWindow?: number } | undefined;
    expect(routerModel?.contextWindow).toBe(50000);
  });

  it('falls back to the synthetic default, never a disallowed model, when nothing is routable', async () => {
    // An allowlist matching zero registry models must not leak an excluded
    // provider's window into the advertised capacity; the synthetic
    // DEFAULT_CONTEXT_WINDOW placeholder is used instead.
    const harness = await setupProviderTest({
      dir: temp.path,
      config: { models: ['nonexistent/*'] },
      models: [
        registryModel('alpha/small', { contextWindow: 50000, maxTokens: 2048 }),
        registryModel('zeta/huge', { contextWindow: 1_000_000, maxTokens: 200000 }),
      ],
      includeRouterModel: false,
      pi: { setThinkingLevel: vi.fn() } as unknown as ExtensionAPI,
    });

    const routerModel = harness.providerOptions.models?.find(
      (m) => (m as { id: string }).id === 'auto',
    ) as { contextWindow?: number } | undefined;
    expect(routerModel?.contextWindow).toBe(200000);
  });

  it('clamps an oversized override to the actual routable max, even when that max is below 200k', async () => {
    const harness = await setupProviderTest({
      dir: temp.path,
      config: { models: ['alpha/*'], routerContextWindow: 9_000_000 },
      models: [
        registryModel('alpha/small', { contextWindow: 50000, maxTokens: 2048 }),
        registryModel('zeta/huge', { contextWindow: 1_000_000, maxTokens: 200000 }),
      ],
      includeRouterModel: false,
      pi: { setThinkingLevel: vi.fn() } as unknown as ExtensionAPI,
    });

    const routerModel = harness.providerOptions.models?.find(
      (m) => (m as { id: string }).id === 'auto',
    ) as { contextWindow?: number } | undefined;
    expect(routerModel?.contextWindow).toBe(50000);
  });

  it('clamps a routerContextWindow override to the largest routable window, never above it', async () => {
    const harness = await setupProviderTest({
      dir: temp.path,
      config: { models: ['alpha/*'], routerContextWindow: 5_000_000 },
      models: [
        registryModel('alpha/small', { contextWindow: 250000, maxTokens: 4096 }),
        registryModel('zeta/huge', { contextWindow: 1_000_000, maxTokens: 200000 }),
      ],
      includeRouterModel: false,
      pi: { setThinkingLevel: vi.fn() } as unknown as ExtensionAPI,
    });

    const routerModel = harness.providerOptions.models?.find(
      (m) => (m as { id: string }).id === 'auto',
    ) as { contextWindow?: number } | undefined;
    expect(routerModel?.contextWindow).toBe(250000);
  });

  it('honours a routerContextWindow override within the routable range', async () => {
    const harness = await setupProviderTest({
      dir: temp.path,
      config: { models: ['alpha/*'], routerContextWindow: 30000 },
      models: [
        registryModel('alpha/small', { contextWindow: 50000, maxTokens: 4096 }),
      ],
      includeRouterModel: false,
      pi: { setThinkingLevel: vi.fn() } as unknown as ExtensionAPI,
    });

    const routerModel = harness.providerOptions.models?.find(
      (m) => (m as { id: string }).id === 'auto',
    ) as { contextWindow?: number } | undefined;
    expect(routerModel?.contextWindow).toBe(30000);
  });
});

describe('provider auth filtering', () => {
  let harness: ProviderTestHarness;

  async function setup(authed: string[]) {
    const credentials: Record<string, ResolvedRequestAuth> = {};
    for (const model of REGISTRY_MODELS) {
      credentials[`${model.provider}/${model.id}`] = authed.includes(model.provider)
        ? { ok: true, apiKey: 'k', headers: {} }
        : { ok: false, error: 'not logged in' };
    }
    harness = await setupProviderTest({
      dir: temp.path,
      includeRouterModel: false,
      credentials,
    });
  }

  const context = { messages: [{ role: 'user', content: 'hi' }] } as unknown as Context;

  it('keeps an auth-failing top candidate in the chain and lets delegation serve fallback', async () => {
    await setup(['beta']);
    writeFileSync(join(temp.path, 'benchmarks.json'), benchStoreJson({
      version: 2,
      syncedAt: Date.now(),
      aliases: {},
      models: [
        { registryId: 'alpha/first', benchSlug: 'alpha-first', active: true, source: 'test', quality: { intelligence: 99, coding: 99, agenticCoding: 99, research: 0.891 } },
        { registryId: 'beta/second', benchSlug: 'beta-second', active: true, source: 'test', quality: { intelligence: 19, coding: 19, agenticCoding: 19, research: 0.171 } },
      ],
    }));
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);

    await harness.serve(
      { messages: [{ role: 'user', content: 'implement parser' }] } as unknown as Context,
    );

    const { lastDecision } = harness.getProviderState();
    expect(lastDecision?.fallbackChain.join(',')).toContain('alpha/first');
    expect(lastDecision?.fallbackChain.join(',')).toContain('beta/second');
    // The cause-precedence row must agree with the log and the rendered detail.
    const handles = await fetchDecisionContractHandles(temp.path);
    expectDecisionContract({ ...handles, match: { chosen: expect.stringMatching(/^beta\/second(:|$)/), cause: 'error-fallback' } });

    // Credential failures spend no provider requests; only the fallback reaches the provider.
    expect(harness.streamedModels()).toEqual(['beta/second']);
  });

  it('reports exhausted fallbacks when no provider is authenticated', async () => {
    await setup([]);
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);

    await harness.serve(context);

    expect(harness.streamedModels()).toHaveLength(0);
    const errors = harness.outStream.events.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(1);
    expect(JSON.stringify(errors[0])).toMatch(/All routing fallbacks exhausted/i);
  });
});

describe('provider status reporting', () => {
  let harness: ProviderTestHarness;
  let statuses: Array<[string, string | undefined]>;
  let notifications: Array<[string, string | undefined]>;

  beforeEach(async () => {
    statuses = [];
    notifications = [];
    harness = await setupProviderTest({
      dir: temp.path,
      includeRouterModel: false,
      ctx: {
        ui: {
          setStatus: (k: string, v?: string) => statuses.push([k, v]),
          notify: (m: string, t?: string) => notifications.push([m, t]),
        },
      } as unknown as ExtensionContext,
    });
  });

  const context = { messages: [{ role: 'user', content: 'hi' }] } as unknown as Context;

  it('publishes the serving model to the status line', async () => {
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);

    await harness.serve(context);

    const texts = statuses.map(([, v]) => v ?? '');
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.some((t) => /beta\/second|alpha\/first/.test(t))).toBe(true);
  });

  it('notifies the TUI when a model is picked (prompt default on)', async () => {
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);

    await harness.serve(context);

    expect(notifications.length).toBe(1);
    expect(notifications[0][0]).toMatch(/pi8 → (beta\/second|alpha\/first)/);
    expect(notifications[0][1]).toBe('info');
  });

  it('does not re-notify when the same model serves consecutive turns', async () => {
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);

    await harness.serve(context);
    harness.outStream.ended = false;
    await harness.serve(context);

    // Same model both turns → notify only on the first pick, not the repeat.
    expect(notifications.length).toBe(1);
  });

  it('publishes the serving model for a tool-call-only turn (no text/thinking deltas)', async () => {
    // An "implement" step often opens directly with an edit/write call and
    // never emits text_delta/thinking_delta. The status widget and decision
    // log must still record which model served it.
    harness.scriptReply([
      { type: 'toolcall_start' },
      { type: 'toolcall_delta' },
      { type: 'toolcall_end' },
      { type: 'done' },
    ]);

    await harness.serve(context);

    const texts = statuses.map(([, v]) => v ?? '');
    expect(texts.some((t) => /beta\/second|alpha\/first/.test(t))).toBe(true);

    expect(harness.getProviderState().lastServed?.registryId).toMatch(/beta\/second|alpha\/first/);
  });

  it('publishes and logs one consistent fallback decision', async () => {
    const attempted: string[] = [];
    harness.scriptReply((model) => {
      attempted.push(`${model.provider}/${model.id}`);
      if (attempted.length === 1) return asStream([{ type: 'error', error: { errorMessage: '421' } }]);
      return asStream([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);
    });

    await harness.serve(context);

    const final = statuses[statuses.length - 1][1] ?? '';
    expect(final).toContain('(fallback #2)');

    // Keys name an action; the delegated call names its model.
    const model = (key: string | undefined) => key?.split(':')[0];
    const decision = harness.getProviderState().lastDecision;
    expect(model(decision?.chosen)).toBe(attempted[1]);
    expect(model(decision?.fallbackChain[0])).toBe(attempted[1]);
    expect(new Set(decision?.fallbackChain).size).toBe(decision?.fallbackChain.length);
    expect(new Set(decision?.fallbackChain.map(model))).toEqual(new Set(attempted));
    expect(decision?.cause).toBe('error-fallback');

    const { readRecentEntries } = await import('../host/decisionlog.js');
    const logged = readRecentEntries(1, temp.path)[0];
    expect(logged).toMatchObject({
      chosen: decision?.chosen,
      cause: 'error-fallback',
      viaFallback: true,
    });
    // The served key names the fallback model; its effort suffix is present only when an effort was sent.
    expect(logged.served?.split(':')[0]).toBe(attempted[1]);
    expect(model(logged.chain[0])).toBe(attempted[1]);
  });

  it('keeps the original decision when the top pick serves', async () => {
    let served = '';
    harness.scriptReply((model) => {
      served = `${model.provider}/${model.id}`;
      return asStream([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);
    });

    await harness.serve(context);

    const decision = harness.getProviderState().lastDecision;
    expect(decision?.chosen.split(':')[0]).toBe(served);
    expect(decision?.fallbackChain[0]).toBe(decision?.chosen);
    expect(decision?.cause).not.toBe('error-fallback');

    const { readRecentEntries } = await import('../host/decisionlog.js');
    const logged = readRecentEntries(1, temp.path)[0];
    expect(logged.cause).toBe(decision?.cause);
    expect(logged.chain).toEqual(decision?.fallbackChain);
  });
});

describe('incumbent continuation and deep context', () => {
  let harness: ProviderTestHarness;

  async function setup(tree?: SessionTree) {
    harness = await setupProviderTest({
      dir: temp.path,
      ctx: tree ? contextForTree(tree) as never : undefined,
      models: [
        registryModel('alpha/cheap', { contextWindow: 200000, maxTokens: 8192, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 } }),
        registryModel('beta/strong', { contextWindow: 200000, maxTokens: 8192, cost: { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 } }),
      ],
    });
  }

  it('serves a follow-up by the incumbent and keeps it stable through tool turns', async () => {
    const tree = new SessionTree();
    await setup(tree);
    const branchContext = () => ({ messages: tree.getBranch().filter((e) => e.type === 'message')
      .map((e) => ({ role: e.message!.role, content: e.message!.content, timestamp: e.message!.timestamp })) }) as unknown as Context;

    harness.scriptReply([{ type: 'text_delta', delta: 'served' }, { type: 'done' }]);

    const earlier = await prepareSelectedWork(harness, tree, 'Implement the pending API authentication changes.');
    harness.resetEventStream();
    await harness.serve(earlier);
    expect(harness.getProviderState().lastDecision?.dimension).toBe('implement');
    const incumbent = harness.session.context.getIncumbent();
    expect(incumbent).toBeDefined();
    tree.assistant('Next I will implement the approved API authentication changes.');
    tree.user('ok go for it', Date.now() + 1);
    harness.resetEventStream();
    await harness.serve(branchContext());
    const firstDecision = harness.getProviderState().lastDecision;
    // Turn 1's row must agree with the log and the rendered detail.
    const firstHandles = await fetchDecisionContractHandles(temp.path);
    expectDecisionContract({
      ...firstHandles,
      match: { dimension: firstDecision?.dimension, cause: firstDecision?.cause },
    });

    tree.message({ role: 'assistant', content: [{ type: 'toolCall', id: 't', name: 'read', arguments: {} }] });
    tree.message({ role: 'toolResult', toolCallId: 't', toolName: 'read',
      content: [{ type: 'text', text: 'large noisy output' }] } as never);
    harness.resetEventStream();
    await harness.serve(branchContext());
    const secondDecision = harness.getProviderState().lastDecision;

    expect(firstDecision?.chosen.startsWith(incumbent!.registryId)).toBe(true);
    expect(secondDecision?.chosen).toBe(firstDecision?.chosen);
    // Stability through the tool loop is a user-visible contract: the log and
    // the rendered detail must agree with the in-memory decision on turn 2 too.
    expect(secondDecision?.dimension).toBe(firstDecision?.dimension);
    expect(secondDecision?.cause).toBe(firstDecision?.cause);
    const secondHandles = await fetchDecisionContractHandles(temp.path);
    expectDecisionContract({
      ...secondHandles,
      match: { dimension: secondDecision?.dimension, cause: secondDecision?.cause },
    });
  });

  it('never raises a gather entry on a deep context', async () => {
    await setup();

    // Long context does not raise the task type while identity is unresolved.
    const prompt = 'lorem ipsum dolor sit amet '.repeat(20_000);
    const ctx = { messages: [{ role: 'user', content: prompt }] } as unknown as Context;

    harness.scriptReply([{ type: 'text_delta', delta: 'served' }, { type: 'done' }]);

    await harness.serve(ctx);

    const decision = harness.getProviderState().lastDecision;
    expect(decision).not.toHaveProperty('routedUp');
    const handles = await fetchDecisionContractHandles(temp.path);
    expectDecisionContract({ ...handles, match: { dimension: 'gather', cause: 'investigation' } });
  });
});

describe('context acquisition', () => {
  let harness: ProviderTestHarness;

  interface RouteTurnOpts {
    estimatedContextTokens?: number;
    /** Every serving model fails before any output. */
    serveFails?: boolean;
    /** These serving models (`provider/id`) fail before any output. */
    failModels?: string[];
  }

  interface Session {
    routeTurn(prompt: string, opts?: RouteTurnOpts): Promise<RoutingDecision | undefined>;
    routeTurnAgainWithSameUserEntry(opts?: RouteTurnOpts): Promise<RoutingDecision | undefined>;
    readDecisionRecords(): Promise<Array<Record<string, unknown>>>;
    /** Context of the last serving request, as delegated. */
    servedContext: Context | undefined;
    /** Options of the last serving request, as delegated. */
    servedOptions: { toolChoice?: string } | undefined;
    /** Context Pi passed to the router for the last invocation. */
    piContext: Context | undefined;
  }

  interface RoutingDecision {
    dimension: string;
    cause: string;
    chosen: string;
    fallbackChain: string[];
    routedUp?: boolean;
    routedDown?: boolean;
    reasoningHandoff?: { minimum: number; pending: boolean; id: string; owner?: string; trajectoryFired?: boolean };
    executionContract?: { handoffId?: string };
    previousHandoffId?: string;
    deliverable?: string;
  }

  async function newSession(): Promise<Session> {
    harness = await setupProviderTest({
      dir: temp.path,
      // A cheaper model leads on research. A model at about five times the
      // price leads on intelligence and agentic coding. Phase and task
      // difficulty distinguish them; the cost feature scores the price ratio.
      benchmarks: [
        {
          registryId: 'alpha/cheap',
          benchSlug: 'alpha-cheap',
          active: true,
          quality: { intelligence: 20, coding: 60, agenticCoding: 60, knowledge: 40, research: 0.9 },
          costPerTask: 0.02,
          outputSpeedTps: 100,
          priceInputPer1M: 0.1,
          priceOutputPer1M: 0.2,
          source: 'test',
        },
        {
          registryId: 'beta/strong',
          benchSlug: 'beta-strong',
          active: true,
          quality: { intelligence: 70, coding: 78, agenticCoding: 90, knowledge: -10, research: 0.1 },
          costPerTask: 0.1,
          outputSpeedTps: 100,
          priceInputPer1M: 0.5,
          priceOutputPer1M: 1,
          source: 'test',
        },
      ],
      models: [
        registryModel('alpha/cheap', {
          contextWindow: 200000,
          maxTokens: 8192,
          cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
        }),
        registryModel('beta/strong', {
          contextWindow: 200000,
          maxTokens: 8192,
          cost: { input: 0.5, output: 1, cacheRead: 0, cacheWrite: 0 },
        }),
      ],
    });

    let turnCounter = 0;
    let lastCtx: Context | undefined;

    const session: Session = {
      servedContext: undefined,
      servedOptions: undefined,
      piContext: undefined,
      async routeTurn(prompt, opts = {}) {
        turnCounter += 1;
        const messages: Array<Record<string, unknown>> = [
          { role: 'user', content: prompt, timestamp: turnCounter },
        ];
        if (opts.estimatedContextTokens) {
          // ~4 chars/token in the estimator; over-provision so the threshold
          // is cleared regardless of exact estimator constants.
          const filler = 'x'.repeat(Math.max(0, opts.estimatedContextTokens * 5));
          messages.push({ role: 'assistant', content: filler, timestamp: turnCounter + 0.5 });
        }
        lastCtx = { messages } as unknown as Context;
        return invokeTurn(session, lastCtx, opts);
      },
      async routeTurnAgainWithSameUserEntry(opts = {}) {
        return invokeTurn(session, lastCtx!, opts);
      },
      async readDecisionRecords() {
        const { readFileSync } = await import('node:fs');
        const { DECISION_LOG_FILE } = await import('../host/decisionlog.js');
        return readFileSync(join(temp.path, DECISION_LOG_FILE), 'utf8').trim().split('\n')
          .map((line) => JSON.parse(line) as Record<string, unknown>);
      },
    };
    return session;
  }

  async function invokeTurn(
    session: Session,
    ctx: Context,
    opts: RouteTurnOpts,
  ): Promise<RoutingDecision | undefined> {
    harness.resetEventStream();
    harness.scriptReply((model: Model<Api>, callContext: Context, callOptions?: unknown) => {
      session.servedContext = callContext;
      session.servedOptions = callOptions as { toolChoice?: string } | undefined;
      if (opts.serveFails || opts.failModels?.includes(`${model.provider}/${model.id}`)) {
        return asStream([{ type: 'error', error: { errorMessage: 'manual failure' } }]);
      }
      return asStream([{ type: 'text_delta', delta: 'served' }, { type: 'done' }]);
    });

    session.piContext = ctx;
    await harness.serve(ctx);
    const state = harness.getProviderState();
    return state.lastDecision as unknown as RoutingDecision | undefined;
  }

  it('collects unresolved work without creating a work item', async () => {
    const session = await newSession();
    const first = await session.routeTurn('implement a CSV exporter');
    expect(first).toMatchObject({ dimension: 'gather', cause: 'investigation' });
    expect(harness.session.context.getLedger().items.size).toBe(0);
    expect(harness.session.getWorkPhaseState()?.pendingIdentity).toBeDefined();
  });

  it('keeps one bounded choice set through repeated invocations of an unresolved entry', async () => {
    const session = await newSession();
    await session.routeTurn('implement the CSV exporter');
    const pending = harness.session.getWorkPhaseState()?.pendingIdentity;
    await session.routeTurnAgainWithSameUserEntry();
    expect(harness.session.getWorkPhaseState()?.pendingIdentity).toEqual(pending);
    expect(harness.session.context.getLedger().items.size).toBe(0);
  });

  it('does not reuse a previous entry’s unresolved identity as a new entry’s identity', async () => {
    const session = await newSession();
    await session.routeTurn('implement a CSV exporter');
    const firstKey = harness.session.getWorkPhaseState()?.intentKey;
    await session.routeTurn('design a backup scheduler');
    expect(harness.session.getWorkPhaseState()?.intentKey).not.toBe(firstKey);
    expect(harness.session.getWorkPhaseState()?.pendingIdentity?.entryKey).toBe(harness.session.getWorkPhaseState()?.intentKey);
    expect(harness.session.context.getLedger().items.size).toBe(0);
  });

  describe('context handoff', () => {
    const PLAN_PROMPT = 'design the architecture and plan the migration roadmap for this system';
    const routerCtx = { cwd: '/repo', model: { provider: 'router', id: 'auto' } } as never;
    const handoff = (alternatives: number, deliverable = 'plan') => ({
      outcome: 'ready',
      deliverable,
      complexity: 'trivial', scope: 'bounded',
      findings: 'the retry wrapper swallows timeouts',
      question: 'where should the timeout surface',
      difficulty: { alternatives, stakes: 1, spread: 1, knowledge: 1, uncertainty: 1 },
    });
    async function submitPrepared(params: Record<string, unknown>) {
      const complete = { workItemId: 'NEW_WORK_ITEM', topicId: 'NEW_TOPIC', topicTitle: 'Work',
        workItemTitle: 'Requested work', ...params };
      const facts = await prepareHandoffFacts(complete, routerCtx, harness.session,
        async () => ({ stdout: '', stderr: '', code: 0 }) as never);
      return submitContextHandoff(complete, routerCtx, harness.session, facts);
    }

    it('keeps a gather entry an investigation, with no handoff owed', async () => {
      const session = await newSession();
      const first = await session.routeTurn('investigate the flaky test');
      expect(first?.dimension).toBe('gather');
      expect(first?.cause).toBe('investigation');
      expect((await session.routeTurnAgainWithSameUserEntry())?.dimension).toBe('gather');
    });

    it('declares a gather answer without creating work or an incumbent', async () => {
      const session = await newSession();
      const first = await session.routeTurn('investigate the flaky test');
      expect(first?.dimension).toBe('gather');
      expect((await submitPrepared({ ...handoff(1), outcome: 'answer', deliverable: 'gather' })).accepted).toBe(true);
      expect(harness.session.context.getLedger().items.size).toBe(0);
      expect(harness.session.context.getIncumbent()).toBeUndefined();
      expect(harness.session.getWorkPhaseState()?.contextAnswer).toBe('gather');
      expect((await session.routeTurnAgainWithSameUserEntry())?.dimension).toBe('gather');
    });

    it('uses collecting-context capabilities only until the model declares a direct gather answer', async () => {
      const session = await newSession();
      const trace = () => harness.getProviderState().lastDecision?.unified?.top?.find((t) => t.key === 'alpha/cheap');
      await session.routeTurn('investigate the flaky test');
      expect(harness.session.getWorkPhaseState()?.contextStatus).toBe('acquiring');
      expect(trace()?.features).toMatchObject({ reasoningFit: 0.4, researchFit: 0.5 });
      expect(trace()?.capabilityShortfall).toBe(0);
      expect((await submitPrepared({ ...handoff(1), outcome: 'answer', deliverable: 'gather' })).accepted).toBe(true);
      // The entry stays restricted to read tools, but writing the answer is the gather deliverable.
      expect((await session.routeTurnAgainWithSameUserEntry())?.dimension).toBe('gather');
      expect(harness.session.getWorkPhaseState()?.contextStatus).toBe('acquiring');
      expect(trace()?.features.reasoningFit).toBe(0);
      expect(trace()?.features.researchFit).toBe(1);
      expect(trace()?.capabilityShortfall).toBeCloseTo(7 / 3, 5);
    });

    it.each([[1, 'alpha/cheap'], [5, 'beta/strong']] as const)(
      'routes an investigation handoff with reasoning level %i to the model its rubric requires',
      async (level, investigator) => {
        const session = await newSession();
        await session.routeTurn('investigate the flaky test');
        const rubric = { alternatives: level, stakes: level, spread: level, knowledge: level, uncertainty: level };
        expect((await submitPrepared({ ...handoff(level, 'gather'), difficulty: rubric })).accepted).toBe(true);
        expect(harness.session.getWorkPhaseState()?.reasoningHandoff).toMatchObject({ target: 'gather', rubric });
        const investigating = await session.routeTurnAgainWithSameUserEntry();
        expect(investigating).toMatchObject({ dimension: 'gather', cause: 'investigation-handoff', chosen: investigator });
        expect(investigating?.reasoningHandoff).toMatchObject({ target: 'gather', pending: false, owner: investigator });
        // The investigator is scored with the rubric's demand, not the collecting-context target.
        expect(harness.getProviderState().lastDecision?.unified).toMatchObject({ difficulty: level === 1 ? 0 : 1 });
        expect(harness.getProviderState().lastDecision?.unified?.top?.find((t) => t.key === 'alpha/cheap')?.features.researchFit).toBe(1);
      },
    );

    it('investigates a plan request until the handoff, then records the planner as the boundary owner', async () => {
      const session = await newSession();
      const first = await session.routeTurn(PLAN_PROMPT);
      expect(first).toMatchObject({ dimension: 'gather', cause: 'investigation', deliverable: 'gather' });
      expect((await session.routeTurnAgainWithSameUserEntry())?.dimension).toBe('gather');

      expect((await submitPrepared(handoff(1))).accepted).toBe(true);
      const planning = await session.routeTurnAgainWithSameUserEntry();
      expect(planning).toMatchObject({ dimension: 'plan', cause: 'investigation-handoff' });
      // The invocation that takes the boundary records its owner, in the
      // decision `/router-why` reads and in the decision log.
      expect(planning?.reasoningHandoff).toMatchObject({ pending: false, owner: planning?.chosen });
      expect(harness.session.getWorkPhaseState()?.reasoningHandoff)
        .toMatchObject({ pending: false, owner: planning?.chosen });
      const logged = (await session.readDecisionRecords())
        .filter((r) => r.dimension === 'plan')
        .map((r) => r.reasoningHandoff as { pending?: boolean; owner?: string } | undefined);
      expect(logged.at(-1)).toMatchObject({ pending: false, owner: planning?.chosen });
      // A different second handoff no longer applies.
      expect((await submitPrepared(handoff(2))).accepted).toBe(false);
    });

    it('selects the planning phase from the accepted task declaration', async () => {
      const session = await newSession();
      await session.routeTurn(PLAN_PROMPT);
      expect((await submitPrepared({ ...handoff(1), complexity: 'moderate', scope: 'open-ended' })).accepted).toBe(true);
      const planning = await session.routeTurnAgainWithSameUserEntry();
      expect(planning).toMatchObject({ dimension: 'plan', unified: { ranked: 2 } });
      expect(harness.session.getWorkPhaseState()?.reasoningHandoff?.rubric).toMatchObject({ alternatives: 1 });
    });

    it('plans with the model that leads on intelligence', async () => {
      const session = await newSession();
      await session.routeTurn(PLAN_PROMPT);
      expect((await submitPrepared(handoff(5))).accepted).toBe(true);
      expect((await session.routeTurnAgainWithSameUserEntry())?.chosen).toBe('beta/strong');
    });

    it('releases the incumbent once: the planner that served keeps the phase', async () => {
      const session = await newSession();
      await session.routeTurn(PLAN_PROMPT);
      await submitPrepared(handoff(5));
      const planner = (await session.routeTurnAgainWithSameUserEntry())?.chosen;
      // Lowering the declared difficulty after the boundary served cannot move the phase to a cheaper model.
      const state = harness.session.getWorkPhaseState()!;
      const easiest = { alternatives: 1, stakes: 1, spread: 1, knowledge: 1, uncertainty: 1 };
      harness.session.commitWorkPhaseState({ ...state, reasoningHandoff: { ...state.reasoningHandoff!, rubric: easiest } });
      expect((await session.routeTurnAgainWithSameUserEntry())?.chosen).toBe(planner);
    });

    describe('a plan submitted while the planning step is still owed', () => {
      // A plan phase for a change request keeps a minimum until a qualifying planner serves.
      const REFERENCED = 'implement the corrected race-condition logic across the codebase from scratch';
      const plan = {
        steps: [{ kind: 'edit', path: 'src/a.ts', change: 'retry the flaky call' }],
        remainingWork: { openDecisions: 1, spread: 1, verification: 1, knowledge: 1, coupling: 1 },
      };
      const contractRecords = async (session: Session) => (await session.readDecisionRecords())
        .map((r) => r.executionContract as { action?: string; rejectReason?: string } | undefined)
        .filter((c) => c != null);

      it('accepts a plan from a qualifying planner before its serve settles the step', async () => {
        const session = await newSession();
        await session.routeTurn(REFERENCED);
        await submitPrepared(handoff(5));
        await session.routeTurnAgainWithSameUserEntry();
        expect(harness.session.getLastServed()?.registryId).toBe('beta/strong');
        // The tool can run before the invocation settles its serve.
        const state = harness.session.getWorkPhaseState()!;
        harness.session.commitWorkPhaseState({
          ...state, deliverable: 'implement',
          reasoningHandoff: { ...state.reasoningHandoff!, pending: true, owner: undefined },
        });
        expect(submitExecutionContract(plan, routerCtx, harness.session, EXISTING_TARGETS).accepted).toBe(true);
        expect((await contractRecords(session)).some((record) => record?.action === 'accept')).toBe(true);
      });
    });

    it('keeps the boundary pending when no candidate serves it', async () => {
      const session = await newSession();
      await session.routeTurn(PLAN_PROMPT);
      await submitPrepared(handoff(5));
      await session.routeTurnAgainWithSameUserEntry({ serveFails: true });
      expect(harness.session.getWorkPhaseState()?.reasoningHandoff?.pending).toBe(true);
    });

    it('routes a review deliverable through its investigation to review', async () => {
      const session = await newSession();
      const first = await session.routeTurn('please review this pull request for security issues');
      expect(first).toMatchObject({ dimension: 'gather', cause: 'investigation', deliverable: 'gather' });
      await submitPrepared(handoff(2, 'review'));
      expect((await session.routeTurnAgainWithSameUserEntry())?.dimension).toBe('review');
    });

    it('chooses work before serving an implementation', async () => {
      const session = await newSession();
      const first = await session.routeTurn(
        'Trace the race condition across the codebase from scratch, then fix and implement the corrected logic.',
      );
      expect(first).toMatchObject({ dimension: 'gather', cause: 'investigation' });
      expect(harness.getProviderState().lastDecision?.workContext).toBeUndefined();
      expect((await submitPrepared(handoff(1, 'implement'))).accepted).toBe(true);
      const executing = await session.routeTurnAgainWithSameUserEntry();
      expect(executing).toMatchObject({ dimension: 'implement', cause: 'investigation-handoff' });
      expect(harness.getProviderState().lastDecision?.workContext?.workItemId).toBe(harness.session.getWorkPhaseState()?.workItemId);
    });

    it('collects context when semantic wording is ambiguous', async () => {
      const session = await newSession();
      const first = await session.routeTurn('Fix the scheduler race and implement the corrected logic.');
      expect(first).toMatchObject({ dimension: 'gather', cause: 'investigation' });
      expect((await submitPrepared(handoff(1, 'implement'))).accepted).toBe(true);
      expect((await session.routeTurnAgainWithSameUserEntry())?.dimension).toBe('implement');
    });

    it('records the selected work only after a ready handoff', async () => {
      const session = await newSession();
      await session.routeTurn('trace the scheduler race, then fix it');
      expect(harness.session.context.getLedger().items.size).toBe(0);
      expect((await submitPrepared(handoff(1, 'implement'))).accepted).toBe(true);
      const workItemId = harness.session.getWorkPhaseState()!.workItemId!;
      expect(harness.session.context.getLedger().items.get(workItemId)?.openContext).toEqual([]);
      await session.routeTurnAgainWithSameUserEntry();
      const next = await session.routeTurn('ok go ahead');
      // The incumbent serves the next entry; the selected work stays recorded.
      expect(harness.session.context.getLedger().items.has(workItemId)).toBe(true);
      expect(next?.cause).not.toBe('investigation');
    });

    it('does not invent an implementation contract for a plan-only request', async () => {
      const session = await newSession();
      await session.routeTurn(PLAN_PROMPT);
      expect((await submitPrepared(handoff(1))).accepted).toBe(true);
      await session.routeTurnAgainWithSameUserEntry();
      const plan = {
        steps: [{ kind: 'edit', path: 'src/a.ts', change: 'retry the flaky call' }],
        remainingWork: { openDecisions: 1, spread: 1, verification: 1, knowledge: 1, coupling: 1 },
      };
      expect(submitExecutionContract(plan, routerCtx, harness.session, EXISTING_TARGETS).accepted).toBe(false);
      expect(harness.session.getWorkPhaseState()?.contract).toBeUndefined();
    });

    it('applies planner struggle within the reasoning phase and logs it at phase end', async () => {
      const session = await newSession();
      await session.routeTurn(PLAN_PROMPT);
      await submitPrepared(handoff(1));
      await session.routeTurnAgainWithSameUserEntry();
      const served = harness.session.getLastServed()!;
      setStruggleAfterRecovery(
      harness.session,
        { escalate: true, tfi: 1, signals: [{ kind: 'aor', severity: 'severe', evidenceIds: ['a:o'], evidenceCount: 1 }] },
        served.thinkingLevel ? `${served.registryId}:${served.thinkingLevel}` : served.registryId,
        'plan',
        false,
      );
      const repicked = await session.routeTurnAgainWithSameUserEntry() as RoutingDecision & { trajectoryFriction?: { fromModel: string } };
      // The struggle is friction evidence of the exact served model in the plan decision.
      expect(repicked).toMatchObject({ dimension: 'plan' });
      expect(repicked?.trajectoryFriction?.fromModel.split(':')[0]).toBe(served.registryId);
      expect(repicked?.reasoningHandoff?.trajectoryFired).toBe(true);

      await session.routeTurn('now plan the rollout for the second region as well');
      const phaseEnd = (await session.readDecisionRecords())
        .map((r) => r.investigationHandoff as { action?: string; handoff?: { trajectoryFired?: boolean } } | undefined)
        .find((h) => h?.action === 'phase-end');
      expect(phaseEnd?.handoff?.trajectoryFired).toBe(true);
    });

    it('keeps the investigation note on the entry message, byte-identical, and supersedes it after the handoff', async () => {
      const session = await newSession();
      await session.routeTurn(PLAN_PROMPT);
      const userBlocks = () => {
        const messages = session.servedContext!.messages;
        const entry = messages.filter((m) => m.role === 'user').at(-1)!;
        return entry.content as Array<{ type: string; text: string }>;
      };
      const first = userBlocks();
      // The tools note comes first: the request must say that the router tools are on.
      expect(first.map((b) => b.text)).toEqual([PLAN_PROMPT, ROUTER_TOOLS_ON_NOTE, expect.stringContaining('hand_off_context')]);
      expect(first[2]!.text).toContain('Do not write the plan, review, change, or investigation yourself');
      // Pi's own transcript never carries the note.
      expect(session.piContext!.messages[0]!.content).toBe(PLAN_PROMPT);
      await session.routeTurnAgainWithSameUserEntry();
      expect(userBlocks()).toEqual(first);

      await submitPrepared(handoff(1));
      await session.routeTurnAgainWithSameUserEntry();
      // The sent note keeps its bytes, so the cached prefix holds; the next
      // note follows it and tells the model not to follow it.
      const after = userBlocks();
      expect(after.slice(0, 3)).toEqual(first);
      expect(after[3]!.text).toMatch(/^Router: Do not follow the earlier router notes for this request\.\nRouter: call complete_work/);
      expect(session.piContext!.messages[0]!.content).toBe(PLAN_PROMPT);
    });

    it('has a pinned model acquire the context too, then serve the deliverable', async () => {
      const session = await newSession();
      harness.session.setManualModel('beta/strong');
      const first = await session.routeTurn(PLAN_PROMPT);
      expect(first).toMatchObject({ dimension: 'gather', cause: 'manual-override', chosen: 'beta/strong' });
      expect(harness.session.getWorkPhaseState()?.contextStatus).toBe('acquiring');
      const entry = session.servedContext!.messages.filter((m) => m.role === 'user').at(-1)!;
      expect(JSON.stringify(entry.content)).toContain('hand_off_context');

      expect((await submitPrepared(handoff(1))).accepted).toBe(true);
      const planning = await session.routeTurnAgainWithSameUserEntry();
      expect(planning).toMatchObject({ dimension: 'plan', cause: 'manual-override', chosen: 'beta/strong' });
      expect(harness.session.getWorkPhaseState()?.contextStatus).toBe('served');
    });

    it('ends acquisition at its request limit with one tool-free clarification request, then dispatches nothing', async () => {
      const session = await newSession();
      await session.routeTurn(PLAN_PROMPT);
      harness.session.commitWorkPhaseState({
        ...harness.session.getWorkPhaseState()!, contextRequests: ACQUISITION_REQUEST_LIMIT,
      });
      const asking = await session.routeTurnAgainWithSameUserEntry();
      expect(asking).toMatchObject({ dimension: 'gather', cause: 'investigation' });
      expect(asking?.fallbackChain).toHaveLength(1);
      expect(session.servedOptions?.toolChoice).toBe('none');
      const entry = session.servedContext!.messages.filter((m) => m.role === 'user').at(-1)!;
      expect(JSON.stringify(entry.content)).toContain('Reply to the user now');
      expect(harness.session.getWorkPhaseState()).toMatchObject({ contextStatus: 'clarification-only', clarificationDispatched: true });

      const requests = harness.streamedModels().length;
      await session.routeTurnAgainWithSameUserEntry();
      expect(harness.streamedModels()).toHaveLength(requests);
      const actions = (await session.readDecisionRecords())
        .map((r) => (r.investigationHandoff as { action?: string } | undefined)?.action)
        .filter(Boolean);
      expect(actions).toContain('budget-exhausted');
    });

    it('retries a clarification request that did not serve', async () => {
      const session = await newSession();
      await session.routeTurn(PLAN_PROMPT);
      harness.session.commitWorkPhaseState({
        ...harness.session.getWorkPhaseState()!, contextStatus: 'clarification-only',
      });
      await session.routeTurnAgainWithSameUserEntry({ serveFails: true });
      expect(harness.session.getWorkPhaseState()?.clarificationDispatched).toBeUndefined();

      const asking = await session.routeTurnAgainWithSameUserEntry();
      expect(asking).toMatchObject({ dimension: 'gather', cause: 'investigation' });
      expect(session.servedOptions?.toolChoice).toBe('none');
      expect(harness.session.getWorkPhaseState()?.clarificationDispatched).toBe(true);
    });

    it('counts each acquisition request, fallback attempts included', async () => {
      const session = await newSession();
      await session.routeTurn(PLAN_PROMPT, { serveFails: true });
      const requests = harness.streamedModels().length;
      expect(requests).toBeGreaterThanOrEqual(2);
      expect(harness.session.getWorkPhaseState()?.contextRequests).toBe(requests);
    });

    it('logs the handoff lifecycle and joins the next entry to it, never logging findings', async () => {
      const session = await newSession();
      await session.routeTurn(PLAN_PROMPT);
      await submitPrepared(handoff(3));
      await session.routeTurnAgainWithSameUserEntry();
      const next = await session.routeTurn('now plan the rollout for the second region as well');
      expect(next?.previousHandoffId).toBeDefined();
      const records = await session.readDecisionRecords();
      const actions = records
        .map((r) => (r.investigationHandoff as { action?: string } | undefined)?.action)
        .filter(Boolean);
      expect(actions).toEqual(['accept', 'served', 'phase-end']);
      expect(JSON.stringify(records)).not.toContain('swallows timeouts');
    });

    describe('the incumbent', () => {
      async function served(): Promise<Session> {
        const session = await newSession();
        await session.routeTurn(PLAN_PROMPT);
        await submitPrepared(handoff(5));
        await session.routeTurnAgainWithSameUserEntry();
        return session;
      }

      it('is the model chosen outside collecting context, never the one that collected it', async () => {
        const session = await newSession();
        await session.routeTurn(PLAN_PROMPT);
        expect(harness.session.context.getIncumbent()).toBeUndefined();
        await submitPrepared(handoff(5));
        await session.routeTurnAgainWithSameUserEntry();
        expect(harness.session.context.getIncumbent()).toMatchObject({ registryId: 'beta/strong', dimension: 'plan' });
      });

      it('records the work item the handoff chose with the incumbent', async () => {
        await served();
        const workItemId = harness.session.getWorkPhaseState()?.workItemId;
        expect(workItemId).toBeDefined();
        expect(harness.session.context.getIncumbent()?.workItemId).toBe(workItemId);
      });

      it('serves every later entry with all tools, without collecting context', async () => {
        const session = await served();
        const next = await session.routeTurn('please handle the pending adjustment');
        expect(next?.chosen.startsWith('beta/strong')).toBe(true);
        expect(next?.cause).not.toBe('investigation');
        expect(harness.session.getWorkPhaseState()).toMatchObject({ incumbentServes: true });
        expect(harness.session.getWorkPhaseState()?.contextStatus).toBeUndefined();
      });

      it('hands off to change phase, and the router chooses the next model', async () => {
        const session = await served();
        await session.routeTurn('please handle the pending adjustment');
        expect((await submitPrepared(handoff(1, 'implement'))).accepted).toBe(true);
        const next = await session.routeTurnAgainWithSameUserEntry();
        expect(next).toMatchObject({ dimension: 'implement', cause: 'investigation-handoff' });
      });

      it('attaches the same active-work note to delegated requests without changing transcript or system messages', async () => {
        const session = await served();
        await session.routeTurnAgainWithSameUserEntry();
        const first = JSON.stringify(session.servedContext!.messages);
        expect(first).toContain('Your own suggestions, next steps, offers');
        await session.routeTurnAgainWithSameUserEntry();
        expect(JSON.stringify(session.servedContext!.messages)).toBe(first);
        expect(JSON.stringify(session.piContext)).not.toContain('Router:');
        expect(session.servedContext!.messages.filter((m) => m.role === 'system'))
          .toEqual(session.piContext!.messages.filter((m) => m.role === 'system'));
      });

      describe('completed work', () => {
        async function completed() {
          const session = await served();
          const workItemId = harness.session.context.getLedger().activeWorkItemId!;
          expect(submitCompleteWork({ outcome: 'done' }, routerCtx, harness.session).accepted).toBe(true);
          return { session, workItemId };
        }

        it('keeps the post-completion reply on the same entry and model without replyPending', async () => {
          const { session, workItemId } = await completed();
          const key = harness.session.getWorkPhaseState()!.intentKey;
          const reply = await session.routeTurnAgainWithSameUserEntry();
          expect(reply?.chosen).toBe('beta/strong');
          expect(harness.session.getWorkPhaseState()).toMatchObject({
            intentKey: key, completion: { workItemId, status: 'done' },
          });
          expect(harness.session.context.getLedger().activeWorkItemId).toBeUndefined();
          expect(gateCompletedWorkToolCall({ toolName: 'write', input: {} }, harness.session)?.block).toBe(true);
        });

        it('answers about done work on the incumbent without reopening or sending extra acquisition requests', async () => {
          const { session, workItemId } = await completed();
          const count = harness.streamedModels().length;
          const decision = await session.routeTurn('explain the migration tradeoffs');
          expect(decision?.chosen).toBe('beta/strong');
          expect(harness.streamedModels()).toHaveLength(count + 1);
          expect(harness.session.getWorkPhaseState()).toMatchObject({ priorCompletion: { workItemId } });
          expect(harness.session.getWorkPhaseState()?.contextStatus).toBeUndefined();
          expect(harness.session.context.getLedger().items.get(workItemId)?.status).toBe('done');
          expect(harness.session.context.getLedger().activeWorkItemId).toBeUndefined();
          const user = session.servedContext!.messages.filter((m) => m.role === 'user').at(-1)!;
          expect(JSON.stringify(user.content)).toContain(workItemId);
          expect(JSON.stringify(user.content)).toContain('answer it directly');
          expect(JSON.stringify(session.piContext)).not.toContain('Router:');
          expect(gateCompletedWorkToolCall({ toolName: 'edit', input: {} }, harness.session)?.block).toBe(true);
        });

        it('refuses a handoff to the completed item it owns and points to reopen_work, without a refusal count', async () => {
          const { session, workItemId } = await completed();
          await session.routeTurn('add the pending adjustment to this migration');
          const before = harness.session.getWorkPhaseState()!;
          const topicId = harness.session.context.getLedger().items.get(workItemId)!.topic.id;
          const result = await submitPrepared({ ...handoff(1, 'implement'), workItemId, topicId });
          expect(result).toMatchObject({ accepted: false, text: expect.stringContaining('reopen_work') });
          expect(harness.session.getWorkPhaseState()).toMatchObject({ priorCompletion: { workItemId } });
          expect(harness.session.getWorkPhaseState()?.contextDenials).toBe(before.contextDenials);
          expect(harness.session.context.getLedger().items.get(workItemId)?.status).toBe('done');
          expect(harness.session.context.getLedger().activeWorkItemId).toBeUndefined();
        });

        it('hands off unrelated work to a new item without reopening the completed one', async () => {
          const { session, workItemId } = await completed();
          await session.routeTurn('implement a CSV exporter');
          expect((await submitPrepared(handoff(1, 'implement'))).accepted).toBe(true);
          const ledger = harness.session.context.getLedger();
          expect(ledger.activeWorkItemId).not.toBe(workItemId);
          expect(ledger.items.get(workItemId)?.status).toBe('done');
          expect(harness.session.getWorkPhaseState()?.priorCompletion).toBeUndefined();
          await session.routeTurnAgainWithSameUserEntry();
          expect(harness.session.context.getIncumbent()?.workItemId).toBe(ledger.activeWorkItemId);
        });

        it('keeps completed ownership and the completed-work gate after a fallback answers', async () => {
          const { session, workItemId } = await completed();
          await session.routeTurn('explain what the migration does', { failModels: ['beta/strong'] });
          const incumbent = harness.session.context.getIncumbent()!;
          expect(incumbent.registryId).not.toBe('beta/strong');
          expect(incumbent.workItemId).toBe(workItemId);
          await session.routeTurn('make another change to it');
          expect(harness.session.getWorkPhaseState()?.priorCompletion).toEqual({ workItemId });
          expect(gateCompletedWorkToolCall({ toolName: 'write', input: {} }, harness.session)?.block).toBe(true);
          expect(harness.session.context.getLedger().items.get(workItemId)?.status).toBe('done');
        });

        it('does not reinterpret a legacy incumbent without a work item as completed ownership', async () => {
          const { session } = await completed();
          harness.session.context.recordIncumbent({ registryId: 'beta/strong' }, 'plan', 'legacy');
          await session.routeTurn('a follow-up question');
          expect(harness.session.getWorkPhaseState()?.priorCompletion).toBeUndefined();
        });
      });

      it('is never a pinned model', async () => {
        const session = await newSession();
        harness.session.setManualModel('alpha/cheap');
        await session.routeTurn('please handle the pending adjustment');
        expect(harness.session.context.getIncumbent()).toBeUndefined();
      });
    });
  });

  describe('execution contract handoff', () => {
    const PLAN_PROMPT = 'design the architecture and plan the migration roadmap for this system';
    const routerCtx = { cwd: '/repo', model: { provider: 'router', id: 'auto' } } as never;
    const EASY = { openDecisions: 1, spread: 1, verification: 1, knowledge: 1, coupling: 1 };
    // A real design decision: its minimum is the frontier ratio.
    const DESIGN_HANDOFF = {
      outcome: 'ready',
      deliverable: 'plan', complexity: 'hard', scope: 'open-ended',
      findings: 'the migration touches every service',
      question: 'which migration order keeps the system up',
      difficulty: { alternatives: 5, stakes: 5, spread: 5, knowledge: 5, uncertainty: 5 },
    };
    const smallPlan = {
      steps: [
        { kind: 'edit', path: 'src/a.ts', change: 'reject expired tokens' },
        { kind: 'verify', verifier: 'test' },
      ],
      remainingWork: EASY,
    };

    async function planned(implementationRequest = true): Promise<Session> {
      const session = await newSession();
      const first = await session.routeTurn(PLAN_PROMPT);
      expect(first?.dimension).toBe('gather');
      expect(first?.cause).toBe('investigation');
      const params = { ...DESIGN_HANDOFF, workItemId: 'NEW_WORK_ITEM', topicId: 'NEW_TOPIC',
        topicTitle: 'Work', workItemTitle: 'Migration roadmap' };
      const facts = await prepareHandoffFacts(params, routerCtx, harness.session,
        async () => ({ stdout: '', stderr: '', code: 0 }) as never);
      expect(submitContextHandoff(params, routerCtx, harness.session, facts).accepted).toBe(true);
      const planning = await session.routeTurnAgainWithSameUserEntry();
      expect(planning?.dimension).toBe('plan');
      expect(planning?.chosen).toBe('beta/strong');
      if (implementationRequest) {
        // Contract tests begin with a served plan phase for an implementation request.
        const state = harness.session.getWorkPhaseState()!;
        harness.session.commitWorkPhaseState({ ...state, deliverable: 'implement' });
      }
      return session;
    }

    async function resolvedImplementation(session: Session, prompt: string, complexity = 'trivial'): Promise<RoutingDecision | undefined> {
      const incumbent = harness.session.context.getIncumbent();
      const first = await session.routeTurn(prompt);
      // With no incumbent the entry collects context; an incumbent serves it and hands off.
      if (incumbent) expect(first?.chosen.startsWith(incumbent.registryId)).toBe(true);
      else expect(first?.dimension).toBe('gather');
      const params = { outcome: 'ready', deliverable: 'implement', complexity, scope: 'bounded', workItemId: 'NEW_WORK_ITEM',
        topicId: 'NEW_TOPIC', topicTitle: 'Implementation', workItemTitle: 'Requested change',
        findings: 'read the request', question: 'implement the change' };
      const facts = await prepareHandoffFacts(params, routerCtx, harness.session,
        async () => ({ stdout: '', stderr: '', code: 0 }) as never);
      expect(submitContextHandoff(params, routerCtx, harness.session, facts).accepted).toBe(true);
      return session.routeTurnAgainWithSameUserEntry();
    }

    function breakWithUndeclaredEdit(): void {
      handleContractToolCall({ toolName: 'edit', input: { path: 'src/other.ts' } }, { cwd: '/repo' }, harness.session);
    }

    describe('declared facts', () => {
      const HARD_FACTS = {
        check: { commands: ['npm run secret-check'], state: 'fails' },
        changes: { modify: ['src/secret-a.ts', 'src/secret-b.ts'], create: [] },
        decisions: ['secret decision one', 'secret decision two', 'secret decision three'],
        unknowns: ['secret unknown'],
        answers: { rewrites: 'Y', ordering: 'Y', mapping: 'N' },
        domains: ['backend'],
      };

      async function handOff(facts?: unknown) {
        const session = await newSession();
        await session.routeTurn(PLAN_PROMPT);
        const params = { ...DESIGN_HANDOFF, workItemId: 'NEW_WORK_ITEM', topicId: 'NEW_TOPIC',
          topicTitle: 'Work', workItemTitle: 'Migration roadmap', ...(facts ? { facts } : {}) };
        const measured = await prepareHandoffFacts(params, routerCtx, harness.session,
          async () => ({ stdout: '', stderr: '', code: 0 }) as never);
        expect(submitContextHandoff(params, routerCtx, harness.session, measured).accepted).toBe(true);
        const planning = await session.routeTurnAgainWithSameUserEntry();
        return { session, planning, state: harness.session.getWorkPhaseState()! };
      }

      it('keeps the declaration in state and logs only codes', async () => {
        const { session, state } = await handOff(HARD_FACTS);
        expect(state.changeFacts?.declared?.decisions).toEqual(HARD_FACTS.decisions);
        const records = await session.readDecisionRecords();
        const accept = records.map((r) => r.investigationHandoff as { action?: string; facts?: FactsLog; evidence?: { version: number; declaredFacts: { decisions?: number } } } | undefined)
          .find((h) => h?.action === 'accept');
        expect(accept?.facts?.declared).toMatchObject({ checkCommands: 1, checkState: 'fails', modify: 2, create: 0, decisions: 3, unknowns: 1 });
          expect(accept?.evidence).toMatchObject({ version: 1, declaredFacts: { decisions: 3 } });
        expect(accept?.facts?.shadow.requirement).toBeGreaterThan(0);
        expect(JSON.stringify(records)).not.toContain('secret');
      });

      it('does not route on the shadow requirement', async () => {
        const plain = await handOff();
        const withFacts = await handOff({ ...HARD_FACTS, decisions: [], answers: { mapping: 'Y', rewrites: 'N' } });
        expect(withFacts.state.reasoningHandoff?.rubric).toEqual(plain.state.reasoningHandoff?.rubric);
        expect(withFacts.planning?.chosen).toBe(plain.planning?.chosen);
      });

      it('logs plan facts without adding a capability minimum', async () => {
        await planned();
        expect(submitExecutionContract(smallPlan, routerCtx, harness.session, EXISTING_TARGETS).accepted).toBe(true);
        await planned();
        const facts = { decisions: ['secret open decision'], precedent: 'src/secret.ts', answers: { mapping: 'Y' } };
        expect(submitExecutionContract({ ...smallPlan, facts }, routerCtx, harness.session, EXISTING_TARGETS, { files: 1 }).accepted).toBe(true);
        const contract = harness.session.getWorkPhaseState()!.contract!;
        expect(contract.facts?.declared).toMatchObject({ modify: 1, create: 0, checkCommands: 1, decisions: 1, precedent: true });
        expect(contract.facts?.shadow.requirement).toBeGreaterThan(0);
        expect(contract).toMatchObject({ release: true });
        expect(JSON.stringify(contractMeta(harness.session.getWorkPhaseState()!))).not.toContain('secret');
      });
    });

    describe.each(['legacy', 'cheapest-sufficient'] as const)('a settled plan under the %s policy', (version) => {
      beforeEach(() => { vi.stubEnv('PI8_POLICY_VERSION', version); });
      afterEach(() => { vi.unstubAllEnvs(); });
      // The same closed plan must be released by either measured submitter.
      const settledPlan = { ...smallPlan, remainingWork: { openDecisions: 3, spread: 3, verification: 3, knowledge: 3, coupling: 3 } };
      // Different benchmark quality cannot change a closed plan's release permission.
      beforeEach(async () => {
        const { loadStore, saveStore } = await import('../bench/store.js');
        const measured: Record<string, { intelligence: number; agenticCoding: number }> = {
          'alpha/cheap': { intelligence: 30, agenticCoding: 29 },
          'beta/strong': { intelligence: 55, agenticCoding: 55 },
        };
        restoreSettledIntelligence = () => {
          const store = loadStore();
          if (store) saveStore({ ...store, syncedAt: store.syncedAt + 1, models: store.models.map((row) => ({ ...row, quality: { ...row.quality, ...measured[row.registryId] } })) });
        };
      });

      let restoreSettledIntelligence = (): void => {};
      it('releases a closed plan even from a weaker measured submitter', async () => {
        const session = await planned();
        restoreSettledIntelligence();
        // A routed request expands the candidates from the restored rows.
        await session.routeTurnAgainWithSameUserEntry();
        harness.session.updateLastServed({ registryId: 'alpha/cheap', thinkingLevel: undefined });
        const result = submitExecutionContract(settledPlan, routerCtx, harness.session, EXISTING_TARGETS);
        expect(result.accepted).toBe(true);
        expect(result.text).toContain('Execution plan accepted');
        // The submitter may also serve the next step; a final reply there ends the run with no edits.
        expect(result.text).toContain(CONTINUE_TURN);
        expect(harness.session.getWorkPhaseState()?.contract).toMatchObject({ release: true, releasePending: true });
        expect(harness.session.getWorkPhaseState()?.contract?.keepReason).toBeUndefined();
      });

      it('releases the same closed plan from a stronger measured submitter', async () => {
        const session = await planned();
        restoreSettledIntelligence();
        // A routed request expands the candidates from the restored rows.
        await session.routeTurnAgainWithSameUserEntry();
        expect(submitExecutionContract(settledPlan, routerCtx, harness.session, EXISTING_TARGETS).accepted).toBe(true);
        const contract = harness.session.getWorkPhaseState()?.contract;
        expect(contract?.release).toBe(true);
        expect(contract?.keepReason).toBeUndefined();
      });
    });

    it('keeps plan/review after a mutation call without an accepted plan', async () => {
      const session = await planned();
      const state = harness.session.getWorkPhaseState()!;
      harness.session.commitWorkPhaseState({ ...state, observedMutationTools: state.observedMutationTools + 1 });
      const next = await session.routeTurnAgainWithSameUserEntry();
      expect(next?.dimension).toBe('plan');
      expect(next?.chosen).toBe('beta/strong');
      expect(harness.getProviderState().lastDecision?.mutationObserved).toBe(true);
    });

    it.skipIf(candidatePolicyRun)('hands a small accepted plan to a cheaper executor on the next invocation', async () => {
      const session = await planned();
      expect(submitExecutionContract(smallPlan, routerCtx, harness.session, EXISTING_TARGETS).accepted).toBe(true);
      const executing = await session.routeTurnAgainWithSameUserEntry();
      expect(executing?.dimension).toBe('implement');
      expect(executing?.cause).toBe('execution-contract');
      expect(executing?.chosen).toBe('alpha/cheap');
      expect(harness.getProviderState().lastDecision?.executionContract).toMatchObject({ status: 'active', release: true });
      // The executor keeps serving the rest of the entry.
      expect((await session.routeTurnAgainWithSameUserEntry())?.chosen).toBe('alpha/cheap');
    });

    describe('under the candidate policy', () => {
      beforeEach(() => { vi.stubEnv('PI8_POLICY_VERSION', 'cheapest-sufficient'); });
      afterEach(() => { vi.unstubAllEnvs(); });

      it.each([false, true])('excludes an executor regardless of replacement measurement: estimated=%s', async (estimated) => {
        const session = await planned();
        const { loadStore, saveStore } = await import('../bench/store.js');
        const store = loadStore()!;
        saveStore({ ...store, syncedAt: store.syncedAt + 1, models: store.models.map((row) => row.registryId === 'alpha/cheap'
          ? { ...row, quality: { ...row.quality, intelligence: 60 }, qualityEstimated: estimated }
          : row) });
        const state = harness.session.getWorkPhaseState()!;
        harness.session.commitWorkPhaseState({ ...state, excludedExecutors: ['beta/strong'] });
        expect(submitExecutionContract(smallPlan, routerCtx, harness.session, EXISTING_TARGETS).accepted).toBe(true);
        const next = await session.routeTurnAgainWithSameUserEntry();
        expect(next?.chosen).toBe('alpha/cheap');
        expect(next?.fallbackChain).not.toContain('beta/strong');
      });

      it('scores the replaced rows when the store keeps its timestamp and row count', async () => {
        const session = await planned();
        const { loadStore, saveStore } = await import('../bench/store.js');
        const { createHash } = await import('node:crypto');
        const store = loadStore()!;
        const replaced = { ...store, models: store.models.map((row) => row.registryId === 'alpha/cheap'
          ? { ...row, quality: { ...row.quality, intelligence: 60 }, qualityEstimated: false }
          : row) };
        saveStore(replaced);
        const state = harness.session.getWorkPhaseState()!;
        harness.session.commitWorkPhaseState({ ...state, excludedExecutors: ['beta/strong'] });
        expect(submitExecutionContract(smallPlan, routerCtx, harness.session, EXISTING_TARGETS).accepted).toBe(true);
        const next = await session.routeTurnAgainWithSameUserEntry();
        expect(next?.chosen).toBe('alpha/cheap');
        const digest = createHash('sha256').update(JSON.stringify(loadStore() ?? null)).digest('hex');
        expect(harness.getProviderState().lastDecision?.unified?.benchmarkSnapshotDigest).toBe(digest);
      });

      it('recomputes a resumed route when the benchmark snapshot changed', async () => {
        const session = await planned();
        const saved = await session.routeTurnAgainWithSameUserEntry();
        expect(harness.getProviderState().lastDecision?.unified?.benchmarkSnapshotDigest).toBeDefined();
        void saved;
        harness.session.setManualModel('alpha/first');
        expect(harness.session.resumeManual()).toBe(true);
        const { loadStore, saveStore } = await import('../bench/store.js');
        const store = loadStore()!;
        saveStore({ ...store, models: store.models.map((row) => row.registryId === 'alpha/cheap'
          ? { ...row, quality: { ...row.quality, intelligence: 60 } }
          : row) });
        const next = await session.routeTurnAgainWithSameUserEntry();
        expect(next?.cause).not.toBe('resume');
      });

      it('resumes a route when the benchmark snapshot is unchanged', async () => {
        const session = await planned();
        await session.routeTurnAgainWithSameUserEntry();
        harness.session.setManualModel('alpha/first');
        expect(harness.session.resumeManual()).toBe(true);
        expect((await session.routeTurnAgainWithSameUserEntry())?.cause).toBe('resume');
      });

      it('records selection identities and counts without task text or capability minimums', async () => {
        const session = await planned();
        submitExecutionContract(smallPlan, routerCtx, harness.session, EXISTING_TARGETS);
        await session.routeTurnAgainWithSameUserEntry();
        const decision = harness.getProviderState().lastDecision!;
        const { loadStore } = await import('../bench/store.js');
        const { createHash } = await import('node:crypto');
        const digest = createHash('sha256').update(JSON.stringify(loadStore() ?? null)).digest('hex');
        expect(decision.unified?.benchmarkSnapshotDigest).toBe(digest);
        expect(decision.capabilityEvidence).toBeUndefined();
        const records = await session.readDecisionRecords();
        const record = records.filter((row) => row.kind == null && row.dimension === 'implement').at(-1)!;
        expect(record.unified).toEqual(decision.unified);
        expect(JSON.stringify(record.unified)).not.toContain('src/a.ts');
      });

      it('hands a small accepted plan to a cheaper executor', async () => {
        const session = await planned();
        expect(submitExecutionContract(smallPlan, routerCtx, harness.session, EXISTING_TARGETS).accepted).toBe(true);
        const executing = await session.routeTurnAgainWithSameUserEntry();
        expect(executing).toMatchObject({ dimension: 'implement', cause: 'execution-contract', chosen: 'alpha/cheap', unified: { ranked: 2 } });
        expect(executing).not.toHaveProperty('policyVersion');
        const meta = harness.getProviderState().lastDecision?.executionContract;
        expect(meta).toMatchObject({ status: 'active', release: true });
      });

      it('replaces an executor that two broken plans excluded with another model', async () => {
        const session = await planned();
        submitExecutionContract(smallPlan, routerCtx, harness.session, EXISTING_TARGETS);
        expect((await session.routeTurnAgainWithSameUserEntry())?.chosen).toBe('alpha/cheap');
        breakWithUndeclaredEdit();
        await session.routeTurnAgainWithSameUserEntry();
        submitExecutionContract(smallPlan, routerCtx, harness.session, EXISTING_TARGETS);
        expect((await session.routeTurnAgainWithSameUserEntry())?.chosen).toBe('alpha/cheap');
        breakWithUndeclaredEdit();
        await session.routeTurnAgainWithSameUserEntry();
        expect(harness.session.getWorkPhaseState()?.excludedExecutors).toEqual(['alpha/cheap']);

        submitExecutionContract(smallPlan, routerCtx, harness.session, EXISTING_TARGETS);
        const escalated = await session.routeTurnAgainWithSameUserEntry();
        expect(escalated).toMatchObject({ dimension: 'implement', chosen: 'beta/strong' });
        expect(escalated?.fallbackChain).not.toContain('alpha/cheap');
      });

      it('releases a plan when an unrelated excluded executor left the pool', async () => {
        const session = await planned();
        const state = harness.session.getWorkPhaseState()!;
        harness.session.commitWorkPhaseState({ ...state, excludedExecutors: ['gone/model'] });
        submitExecutionContract(smallPlan, routerCtx, harness.session, EXISTING_TARGETS);
        const contract = harness.session.getWorkPhaseState()?.contract;
        expect(contract).toMatchObject({ release: true });
        expect(contract?.keepReason).toBeUndefined();
        const next = await session.routeTurnAgainWithSameUserEntry();
        expect(next).toMatchObject({ dimension: 'implement', chosen: 'alpha/cheap' });
      });
    });

    it('releases the incumbent once: the executor that served keeps the plan', async () => {
      const session = await planned();
      submitExecutionContract(smallPlan, routerCtx, harness.session, EXISTING_TARGETS);
      expect(harness.session.getWorkPhaseState()?.contract?.releasePending).toBe(true);
      await session.routeTurnAgainWithSameUserEntry({ serveFails: true });
      expect(harness.session.getWorkPhaseState()?.contract?.releasePending).toBe(true);
      harness.session.clearBlacklistedModels();
      expect((await session.routeTurnAgainWithSameUserEntry())?.chosen).toBe('alpha/cheap');
      expect(harness.session.getWorkPhaseState()?.contract?.releasePending).toBe(false);
    });

    it('hands a plan off from an implement entry, and returns a break to implementation', async () => {
      const session = await planned();
      const implementing = await resolvedImplementation(session, 'implement a function to parse the pending adjustment payload', 'hard');
      expect(implementing?.dimension).toBe('implement');
      expect(implementing?.chosen).toBe('beta/strong');
      expect(submitExecutionContract(smallPlan, routerCtx, harness.session, EXISTING_TARGETS).accepted).toBe(true);
      expect((await session.routeTurnAgainWithSameUserEntry())?.chosen).toBe('alpha/cheap');
      breakWithUndeclaredEdit();
      const restored = await session.routeTurnAgainWithSameUserEntry();
      expect(restored?.dimension).toBe('implement');
      expect(restored?.chosen).toBe('beta/strong');
    });

    it('returns an undeclared edit to the submitter at its task type, then clears the plan', async () => {
      const session = await planned();
      submitExecutionContract(smallPlan, routerCtx, harness.session, EXISTING_TARGETS);
      expect((await session.routeTurnAgainWithSameUserEntry())?.chosen).toBe('alpha/cheap');
      // Declared targets never break the plan.
      handleContractToolCall({ toolName: 'edit', input: { path: './src/a.ts' } }, { cwd: '/repo' }, harness.session);
      expect(harness.session.getWorkPhaseState()?.contract?.status).toBe('active');
      breakWithUndeclaredEdit();
      const restored = await session.routeTurnAgainWithSameUserEntry();
      expect(restored?.dimension).toBe('plan');
      expect(restored?.chosen).toBe('beta/strong');
      expect(harness.getProviderState().lastDecision?.executionContract)
        .toMatchObject({ status: 'broken', breakReason: 'undeclared-target', breaker: 'alpha/cheap' });
      expect(harness.session.getWorkPhaseState()?.contract).toBeUndefined();
      const after = await session.routeTurnAgainWithSameUserEntry();
      expect(after?.dimension).toBe('plan');
      expect(harness.getProviderState().lastDecision?.executionContract).toBeUndefined();
    });

    it('returns a shell write by the executor to the submitter without a strike', async () => {
      const session = await planned();
      submitExecutionContract(smallPlan, routerCtx, harness.session, EXISTING_TARGETS);
      expect((await session.routeTurnAgainWithSameUserEntry())?.chosen).toBe('alpha/cheap');
      const bash = (command: string) =>
        handleContractToolCall({ toolName: 'bash', input: { command } }, { cwd: '/repo' }, harness.session);
      bash('npx vitest run src/a.test.ts');
      expect(harness.session.getWorkPhaseState()?.contract?.status).toBe('active');
      bash('printf x > src/d.ts');
      expect(harness.session.getWorkPhaseState()?.contract)
        .toMatchObject({ status: 'broken', breakReason: 'unattributed-mutation', breaker: 'alpha/cheap' });
      expect(harness.session.getWorkPhaseState()?.contractStrikes).toBeUndefined();
      const restored = await session.routeTurnAgainWithSameUserEntry();
      expect(restored?.dimension).toBe('plan');
      expect(restored?.chosen).toBe('beta/strong');
    });

    it('lets the submitter write from a shell while it keeps the plan', async () => {
      const session = await planned();
      submitExecutionContract({ ...smallPlan, remainingWork: { ...EASY, openDecisions: 5 } }, routerCtx, harness.session, EXISTING_TARGETS);
      expect((await session.routeTurnAgainWithSameUserEntry())?.chosen).toBe('beta/strong');
      handleContractToolCall({ toolName: 'bash', input: { command: 'sed -i s/a/b/ src/a.ts' } }, { cwd: '/repo' }, harness.session);
      expect(harness.session.getWorkPhaseState()?.contract?.status).toBe('active');
    });

    it('keeps a broken plan pending when its permitted submitter fails', async () => {
      const session = await planned();
      submitExecutionContract(smallPlan, routerCtx, harness.session, EXISTING_TARGETS);
      await session.routeTurnAgainWithSameUserEntry();
      breakWithUndeclaredEdit();
      const failed = await session.routeTurnAgainWithSameUserEntry({ failModels: ['beta/strong'] });
      expect(failed?.fallbackChain).toEqual(['beta/strong']);
      expect(harness.session.getLastServed()).toBeUndefined();
      expect(harness.session.getWorkPhaseState()?.contract?.status).toBe('broken');
      harness.session.clearBlacklistedModels();
      expect((await session.routeTurnAgainWithSameUserEntry())?.chosen).toBe('beta/strong');
      expect(harness.session.getWorkPhaseState()?.contract).toBeUndefined();
    });

    it('keeps a broken plan bound to its submitter until a handback invocation serves', async () => {
      const session = await planned();
      submitExecutionContract(smallPlan, routerCtx, harness.session, EXISTING_TARGETS);
      await session.routeTurnAgainWithSameUserEntry();
      breakWithUndeclaredEdit();
      const failed = await session.routeTurnAgainWithSameUserEntry({ serveFails: true });
      expect(failed?.chosen).toBe('beta/strong');
      expect(harness.session.getWorkPhaseState()?.contract?.status).toBe('broken');
      // The provider recovers; the next invocation still owes the handback.
      harness.session.blacklist.clearBlacklistedModels();
      const retried = await session.routeTurnAgainWithSameUserEntry();
      expect(retried?.dimension).toBe('plan');
      expect(retried?.chosen).toBe('beta/strong');
      expect(harness.getProviderState().lastDecision?.executionContract).toMatchObject({ status: 'broken' });
      expect(harness.session.getWorkPhaseState()?.contract).toBeUndefined();
    });

    it.skipIf(candidatePolicyRun)('lets an executor break a plan once, then routes later plans to a stronger model', async () => {
      const session = await planned();
      submitExecutionContract(smallPlan, routerCtx, harness.session, EXISTING_TARGETS);
      expect((await session.routeTurnAgainWithSameUserEntry())?.chosen).toBe('alpha/cheap');
      breakWithUndeclaredEdit();
      await session.routeTurnAgainWithSameUserEntry();

      // First break: the same executor may try again.
      submitExecutionContract(smallPlan, routerCtx, harness.session, EXISTING_TARGETS);
      expect((await session.routeTurnAgainWithSameUserEntry())?.chosen).toBe('alpha/cheap');
      breakWithUndeclaredEdit();
      await session.routeTurnAgainWithSameUserEntry();
      expect(harness.session.getWorkPhaseState()?.excludedExecutors).toEqual(['alpha/cheap']);

      // The second break excludes the executor from implementation. It cannot
      // occur in either the selection or the availability fallback chain.
      submitExecutionContract(smallPlan, routerCtx, harness.session, EXISTING_TARGETS);
      const escalated = await session.routeTurnAgainWithSameUserEntry();
      expect(escalated?.dimension).toBe('implement');
      expect(escalated?.chosen).toBe('beta/strong');
      expect(escalated?.fallbackChain).not.toContain('alpha/cheap');
    });

    it.skipIf(candidatePolicyRun)('releases a plan when an excluded executor is no longer in the pool', async () => {
      const session = await planned();
      const state = harness.session.getWorkPhaseState()!;
      harness.session.commitWorkPhaseState({ ...state, excludedExecutors: ['gone/model'] });
      submitExecutionContract(smallPlan, routerCtx, harness.session, EXISTING_TARGETS);
      expect(harness.session.getWorkPhaseState()?.contract).toMatchObject({ release: true });
      const next = await session.routeTurnAgainWithSameUserEntry();
      expect(next?.dimension).toBe('implement');
      expect(next?.chosen).toBe('alpha/cheap');
    });

    it('treats executor struggle as a broken plan', async () => {
      const session = await planned();
      submitExecutionContract(smallPlan, routerCtx, harness.session, EXISTING_TARGETS);
      expect((await session.routeTurnAgainWithSameUserEntry())?.chosen).toBe('alpha/cheap');
      setStruggleAfterRecovery(
      harness.session,
        { escalate: true, tfi: 1, signals: [{ kind: 'aor', severity: 'severe', evidenceIds: ['a:o'], evidenceCount: 1 }] },
        'alpha/cheap',
        'implement',
        false,
      );
      const next = await session.routeTurnAgainWithSameUserEntry();
      expect(next?.dimension).toBe('plan');
      expect(next?.chosen).toBe('beta/strong');
      expect(harness.getProviderState().lastDecision?.executionContract).toMatchObject({ status: 'broken', breakReason: 'struggle' });
    });

    it('treats a second submission during execution as a re-plan', async () => {
      const session = await planned();
      submitExecutionContract(smallPlan, routerCtx, harness.session, EXISTING_TARGETS);
      await session.routeTurnAgainWithSameUserEntry();
      const again = submitExecutionContract(smallPlan, routerCtx, harness.session, EXISTING_TARGETS);
      expect(again.accepted).toBe(false);
      expect(harness.session.getWorkPhaseState()?.contract).toMatchObject({ status: 'broken', breakReason: 'replan' });
      expect((await session.routeTurnAgainWithSameUserEntry())?.chosen).toBe('beta/strong');
    });

    it('keeps the submitter executing a plan too large to hand off', async () => {
      const session = await planned();
      const large = {
        steps: ['a', 'b', 'c', 'd', 'e', 'f'].map((f) => ({ kind: 'edit', path: `${f}.ts`, change: 'rename' })),
        remainingWork: EASY,
      };
      expect(submitExecutionContract(large, routerCtx, harness.session, EXISTING_TARGETS).accepted).toBe(true);
      const next = await session.routeTurnAgainWithSameUserEntry();
      expect(next?.dimension).toBe('implement');
      expect(next?.chosen).toBe('beta/strong');
    });

    function editResult(path: string, isError = false): void {
      trackContractToolResult({ toolName: 'edit', toolCallId: `e-${path}`, input: { path }, isError }, { cwd: '/repo' }, harness.session);
    }

    it('keeps the submitter when the rubric says design choices remain', async () => {
      const session = await planned();
      const open = { ...smallPlan, remainingWork: { ...EASY, openDecisions: 5 } };
      const kept = submitExecutionContract(open, routerCtx, harness.session, EXISTING_TARGETS).text;
      expect(kept).toContain('keeps executing it');
      expect(kept).toContain(CONTINUE_TURN);
      const next = await session.routeTurnAgainWithSameUserEntry();
      expect(next?.dimension).toBe('implement');
      expect(next?.chosen).toBe('beta/strong');
      expect(harness.getProviderState().lastDecision?.executionContract)
        .toMatchObject({ release: false, keepReason: 'open-decisions' });
    });

    it('returns an executed plan to the submitter for review until the entry ends', async () => {
      const session = await planned();
      submitExecutionContract(smallPlan, routerCtx, harness.session, EXISTING_TARGETS);
      expect((await session.routeTurnAgainWithSameUserEntry())?.chosen).toBe('alpha/cheap');
      editResult('src/a.ts', true);
      expect(harness.session.getWorkPhaseState()?.contract?.status).toBe('active');
      editResult('src/a.ts');
      expect(harness.session.getWorkPhaseState()?.contract)
        .toMatchObject({ status: 'executed', executedReason: 'complete', executor: 'alpha/cheap' });

      const review = await session.routeTurnAgainWithSameUserEntry();
      expect(review?.dimension).toBe('review');
      expect(review?.cause).toBe('execution-contract');
      expect(review?.chosen).toBe('beta/strong');
      expect(harness.getProviderState().lastDecision?.executionContract).toMatchObject({ status: 'executed' });
      expect((await session.routeTurnAgainWithSameUserEntry())?.chosen).toBe('beta/strong');
    });

    it('marks a plan submitted by a model that served through a fallback as temporary', async () => {
      await planned();
      const served = harness.session.getLastServed()!;
      harness.session.setLastServed({ ...served, viaFallback: true });
      submitExecutionContract(smallPlan, routerCtx, harness.session, EXISTING_TARGETS);
      expect(harness.session.getWorkPhaseState()?.contract?.submitterTemporary).toBe(true);
    });

    it('records the review verifier result and logs the outcome when the entry ends', async () => {
      const session = await planned();
      submitExecutionContract(smallPlan, routerCtx, harness.session, EXISTING_TARGETS);
      await session.routeTurnAgainWithSameUserEntry();
      editResult('src/a.ts');
      await session.routeTurnAgainWithSameUserEntry();
      const test = (toolCallId: string, text: string) => trackContractToolResult(
        { toolName: 'bash', toolCallId, input: { command: 'npx vitest run' }, content: [{ type: 'text', text }] },
        { cwd: '/repo' },
        harness.session,
      );
      test('t1', '1 failed');
      test('t2', 'all passed');
      expect(harness.session.getWorkPhaseState()?.contract?.reviewVerifier).toBe('fail');
      editResult('src/a.ts');

      await session.routeTurn('thanks, now summarize what changed');
      const outcomes = (await session.readDecisionRecords())
        .filter((record) => (record.executionContract as { action?: string } | undefined)?.action === 'outcome');
      expect(outcomes.map((record) => record.executionContract)).toEqual([
        expect.objectContaining({
          outcome: 'fixed',
          meta: expect.objectContaining({ executor: 'alpha/cheap', reviewVerifier: 'fail', rubric: EASY }),
        }),
      ]);
    });

    it('counts a new plan during review as rework against the executor', async () => {
      const session = await planned();
      const executeOnce = async () => {
        submitExecutionContract(smallPlan, routerCtx, harness.session, EXISTING_TARGETS);
        expect((await session.routeTurnAgainWithSameUserEntry())?.chosen).toBe('alpha/cheap');
        editResult('src/a.ts');
        expect((await session.routeTurnAgainWithSameUserEntry())?.dimension).toBe('review');
      };
      await executeOnce();
      await executeOnce();
      expect(harness.session.getWorkPhaseState()?.contractStrikes).toEqual({ cheap: 1 });
      submitExecutionContract(smallPlan, routerCtx, harness.session, EXISTING_TARGETS);
      expect(harness.session.getWorkPhaseState()?.excludedExecutors).toEqual(['alpha/cheap']);
      const escalated = await session.routeTurnAgainWithSameUserEntry();
      expect(escalated?.chosen).toBe('beta/strong');
      expect(escalated?.fallbackChain).not.toContain('alpha/cheap');
    });

    it('executes a plan whose executor used up its invocation budget', async () => {
      const session = await planned();
      submitExecutionContract(smallPlan, routerCtx, harness.session, EXISTING_TARGETS);
      let decision = await session.routeTurnAgainWithSameUserEntry();
      for (let i = 0; i < 12 && decision?.dimension === 'implement'; i += 1) {
        decision = await session.routeTurnAgainWithSameUserEntry();
      }
      expect(decision?.dimension).toBe('review');
      // No edit named the executor; the model that served its invocations did.
      expect(harness.session.getWorkPhaseState()?.contract)
        .toMatchObject({ status: 'executed', executedReason: 'budget', executor: 'alpha/cheap' });
    });

    it('continues as implementation when only the submitter served a released plan', async () => {
      const session = await planned();
      submitExecutionContract(smallPlan, routerCtx, harness.session, EXISTING_TARGETS);
      harness.session.blacklist.blacklistModel('alpha/cheap');
      expect((await session.routeTurnAgainWithSameUserEntry())?.chosen).toBe('beta/strong');
      editResult('src/a.ts');
      expect(harness.session.getWorkPhaseState()?.contract).toMatchObject({ status: 'executed', release: true });
      expect(harness.session.getWorkPhaseState()?.contract?.executor).toBeUndefined();
      const next = await session.routeTurnAgainWithSameUserEntry();
      expect(next?.dimension).toBe('implement');
      expect(next?.cause).toBe('execution-contract');
    });

    it('rejects a plan for a plan or review deliverable', async () => {
      const session = await planned(false);
      const result = submitExecutionContract(smallPlan, routerCtx, harness.session, EXISTING_TARGETS);
      expect(result.accepted).toBe(false);
      expect(result.text).toContain('asks for a plan');
      expect((await session.routeTurnAgainWithSameUserEntry())?.dimension).toBe('plan');
    });

    it('accepts a plan after an implementation is selected', async () => {
      const session = await newSession();
      await resolvedImplementation(session, 'implement the pending adjustment payload');
      expect(submitExecutionContract(smallPlan, routerCtx, harness.session, EXISTING_TARGETS).accepted).toBe(true);
      expect((await session.routeTurnAgainWithSameUserEntry())?.dimension).toBe('implement');
    });

    it('accepts a plan when a vague request is identified as implementation at the handoff', async () => {
      const session = await newSession();
      await resolvedImplementation(session, 'please handle the pending adjustment');
      expect(submitExecutionContract(smallPlan, routerCtx, harness.session, EXISTING_TARGETS).accepted).toBe(true);
    });

    it('rejects a handoff during an investigation and outside router/auto', async () => {
      const session = await newSession();
      await session.routeTurn('investigate the flaky test');
      expect(submitExecutionContract(smallPlan, routerCtx, harness.session, EXISTING_TARGETS).text)
        .toContain('only to planning, review, or implementation');
      const other = { cwd: '/repo', model: { provider: 'beta', id: 'strong' } } as never;
      expect(submitExecutionContract(smallPlan, other, harness.session, EXISTING_TARGETS).text).toContain('has no effect');
    });
  });

  it('reuses the unresolved work choice on later tool-loop turns of the same entry', async () => {
    const session = await newSession();
    const first = await session.routeTurn('list the main features of docs/plan.md');
    const second = await session.routeTurnAgainWithSameUserEntry();

    expect(first?.dimension).toBe('gather');
    expect(second?.dimension).toBe('gather');
    expect(harness.session.getWorkPhaseState()?.pendingIdentity).toBeDefined();
  });

describe('deep context', () => {
  it('holds the work choice unresolved at a large context size', async () => {
    const session = await newSession();
    const first = await session.routeTurn('investigate the flaky test', {
      estimatedContextTokens: 120_000,
    });
    const after = await session.routeTurnAgainWithSameUserEntry();
    expect(first?.dimension).toBe('gather');
    expect(after?.dimension).toBe('gather');
    expect(after?.cause).toBe(first?.cause);
    expect(harness.session.getWorkPhaseState()?.pendingIdentity).toBeDefined();
  });

});

});

describe('unified pre-output recovery integration', () => {
  async function recoveryHarness(credentials?: Record<string, ResolvedRequestAuth | Error>, third = false) {
    const ids = third ? ['alpha/first', 'beta/second', 'gamma/third'] : ['alpha/first', 'beta/second'];
    const h = await setupProviderTest({ dir: temp.path, credentials,
      models: ids.map((id) => registryModel(id, {
        reasoning: true, thinkingLevelMap: { off: 'off', low: null, medium: null, high: 'high', xhigh: null, max: null },
        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      })),
      benchmarks: ids.map((registryId) => ({ registryId, benchSlug: registryId, active: true, effort: 'high' as const, source: 'aa',
        quality: { intelligence: 50, coding: 50, agenticCoding: 50, research: 0.8 },
      })),
    });
    const block = 'abcdefghij'.repeat(13).slice(0, 128);
    h.scriptReply((model) => asStream(model.provider === 'alpha' ? [
      { type: 'thinking_delta', delta: Array.from({ length: 800 }, () => 'alpha').join(' ') },
      ...Array.from({ length: 3 }, () => ({ type: 'thinking_delta', delta: block })),
      { type: 'text_delta', delta: 'source answer' }, { type: 'done' },
    ] : [{ type: 'text_delta', delta: 'recovery answer' }, { type: 'done' }]));
    return h;
  }

  it('uses loop friction to select an equal-quality actor without the legacy stronger test', async () => {
    const h = await recoveryHarness();
    await h.serve({ messages: [{ role: 'user', content: 'examine this request' }] } as Context);
    expect(h.streamedModels()).toEqual(['alpha/first', 'beta/second']);
    expect(h.outStream.events.filter((event) => event.type === 'text_delta')).toEqual([{ type: 'text_delta', delta: 'recovery answer' }]);
    expect(h.outStream.events.filter((event) => event.type === 'done')).toHaveLength(1);
    expect(h.outStream.events.some((event) => event.type === 'thinking_delta')).toBe(false);
    expect(h.getProviderState().blacklistedModels).toEqual([]);
    expect(h.getProviderState().blacklistedProviders).toEqual([]);
    expect(h.delegatedCall(0).options?.signal?.aborted).toBe(true);
    expect(h.session.getLastDecision()).toMatchObject({ dimension: 'gather', cause: 'investigation', unified: { constraintsEnforced: true },
      trajectoryFriction: { preOutput: true } });
    expect(h.session.getWorkPhaseState()?.boundaryAuthorization?.state).toBe('served');
  });

  it.each(['text', 'tool-call', 'thinking-overflow'] as const)('does not select recovery after committed %s', async (committed) => {
    const h = await recoveryHarness();
    const prefix = committed === 'text' ? [{ type: 'text_delta', delta: 'visible' }]
      : committed === 'tool-call' ? [{ type: 'toolcall_start' }]
      : [{ type: 'thinking_delta', delta: 'buffered' }, { type: 'thinking_delta', delta: 'x'.repeat(70_000) }];
    const block = 'abcdefghij'.repeat(13).slice(0, 128);
    h.scriptReply([...prefix,
      { type: 'thinking_delta', delta: Array.from({ length: 800 }, () => 'alpha').join(' ') },
      ...Array.from({ length: 3 }, () => ({ type: 'thinking_delta', delta: block })),
      { type: 'text_delta', delta: 'source answer' }, { type: 'done' },
    ]);
    await h.serve({ messages: [{ role: 'user', content: 'examine this request' }] } as Context);
    expect(h.streamedModels()).toEqual(['alpha/first']);
    expect(h.session.getLastDecision()?.trajectoryFriction).toBeUndefined();
    expect(h.outStream.events.some((event) => event.type === 'error')).toBe(false);
  });

  it('continues through the retained authorized ranking when the selected recovery target fails auth', async () => {
    const h = await recoveryHarness({ 'beta/second': { ok: false, error: 'credentials unavailable' } }, true);
    await h.serve({ messages: [{ role: 'user', content: 'examine this request' }] } as Context);
    expect(h.streamedModels()).toEqual(['alpha/first', 'gamma/third']);
    expect(h.outStream.events.filter((event) => event.type === 'text_delta')).toEqual([{ type: 'text_delta', delta: 'recovery answer' }]);
    expect(h.session.getWorkPhaseState()?.boundaryAuthorization?.state).toBe('served');
    expect(h.outStream.events.filter((event) => event.type === 'done')).toHaveLength(1);
  });

  it.each(['profile-change', 'user-cancel'] as const)('does not dispatch a recovery after %s during target auth', async (change) => {
    const caller = new AbortController();
    const credentials: Record<string, ResolvedRequestAuth | Error> = {};
    Object.defineProperty(credentials, 'beta/second', { get() {
      if (change === 'profile-change') savePreferences({ version: 1, settledImplementation: 'lower_cost' });
      else caller.abort();
      return { ok: true, apiKey: 'k', headers: {} };
    } });
    const h = await recoveryHarness(credentials);
    await h.serve({ messages: [{ role: 'user', content: 'examine this request' }] } as Context, { signal: caller.signal });
    expect(h.streamedModels()).toEqual(['alpha/first']);
    expect(h.outStream.events.filter((event) => event.type === 'text_delta')).toEqual([]);
    expect(h.outStream.events.filter((event) => event.type === 'error')).toHaveLength(1);
    expect(h.getProviderState().blacklistedModels).toEqual([]);
    expect(h.session.getWorkPhaseState()?.boundaryAuthorization?.state).toBe('pending');
  });
});

describe('reservation of every provider request', () => {
  async function twoModels(credentials?: Record<string, ResolvedRequestAuth | Error>) {
    const ids = ['alpha/first', 'beta/second'];
    return setupProviderTest({ dir: temp.path, credentials,
      models: ids.map((id) => registryModel(id, { cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } })),
      benchmarks: ids.map((registryId) => ({ registryId, benchSlug: registryId, active: true, source: 'aa',
        quality: { intelligence: 50, coding: 50, agenticCoding: 50, research: 0.8 },
      })),
    });
  }
  const request = { messages: [{ role: 'user', content: 'examine this request' }] } as Context;

  it('starts no request when the preference profile changed during authentication', async () => {
    const credentials: Record<string, ResolvedRequestAuth | Error> = {};
    for (const id of ['alpha/first', 'beta/second']) {
      Object.defineProperty(credentials, id, { get() {
        savePreferences({ version: 1, settledImplementation: 'lower_cost' });
        return { ok: true, apiKey: 'k', headers: {} };
      } });
    }
    const h = await twoModels(credentials);
    h.scriptReply([{ type: 'text_delta', delta: 'answer' }, { type: 'done' }]);
    await h.serve(request);
    expect(h.streamedModels()).toEqual([]);
    expect(h.outStream.events.filter((event) => event.type === 'text_delta')).toEqual([]);
    expect(h.outStream.events.filter((event) => event.type === 'error')).toHaveLength(1);
    expect(h.session.getWorkPhaseState()?.boundaryAuthorization?.state).toBe('pending');
  });

  it.each(['profile', 'assignment'] as const)('starts no fallback request when the %s changed during the first attempt', async (change) => {
    const h = await twoModels();
    h.scriptReply(() => {
      if (change === 'profile') savePreferences({ version: 1, settledImplementation: 'lower_cost' });
      else {
        const state = h.session.getWorkPhaseState()!;
        h.session.commitWorkPhaseState({ ...state, boundaryAuthorization: { ...state.boundaryAuthorization!,
          assignmentId: 'another', revision: state.boundaryAuthorization!.revision + 1 } });
      }
      return asStream([{ type: 'error', error: { errorMessage: 'Provider finish_reason: error' } }]);
    });
    await h.serve(request);
    expect(h.streamedModels()).toHaveLength(1);
    expect(h.outStream.events.filter((event) => event.type === 'text_delta')).toEqual([]);
    expect(h.outStream.events.filter((event) => event.type === 'error')).toHaveLength(1);
    expect(h.session.getWorkPhaseState()?.boundaryAuthorization?.state).not.toBe('served');
  });

  it('still falls back to the other authorized action when nothing changed', async () => {
    const h = await twoModels();
    let calls = 0;
    h.scriptReply(() => asStream(++calls === 1
      ? [{ type: 'error', error: { errorMessage: 'Provider finish_reason: error' } }]
      : [{ type: 'text_delta', delta: 'answer' }, { type: 'done' }]));
    await h.serve(request);
    expect(h.streamedModels()).toHaveLength(2);
    expect(new Set(h.streamedModels()).size).toBe(2);
    expect(h.outStream.events.filter((event) => event.type === 'text_delta')).toEqual([{ type: 'text_delta', delta: 'answer' }]);
    expect(h.session.getWorkPhaseState()?.boundaryAuthorization?.state).toBe('served');
  });
});

describe('trajectory capability escalation', () => {
  it('permits higher effort on the requesting model after recovery', async () => {
    const harness = await setupProviderTest({
      dir: temp.path,
      benchmarks: [
        { registryId: 'alpha/source', benchSlug: 'source-low', active: true, effort: 'low', quality: { intelligence: 50, research: 0.7 }, source: 'test' },
        { registryId: 'alpha/source', benchSlug: 'source-high', active: true, effort: 'high', quality: { intelligence: 80, research: 0.9 }, source: 'test' },
      ],
      models: [registryModel('alpha/source', {
        reasoning: true, contextWindow: 200000,
        thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: null },
      })],
    });
    const context = { messages: [{ role: 'user', content: 'investigate the failing check' }] } as unknown as Context;
    harness.session.setManualModel('alpha/source:low');
    harness.scriptReply([{ type: 'text_delta', delta: 'served' }, { type: 'done' }]);
    await harness.serve(context);
    expect(harness.session.getLastServed()?.thinkingLevel).toBe('low');
    expect(harness.session.resumeManual()).toBe(true);
    setStruggleAfterRecovery(harness.session, {
      escalate: true, tfi: 1,
      signals: [{ kind: 'aor', severity: 'severe', evidenceIds: ['check-a'], evidenceCount: 1 }],
    }, 'alpha/source:low', 'gather', false);
    harness.resetEventStream();
    await harness.serve(context);
    expect(harness.session.getLastDecision()?.chosen).toBe('alpha/source:high');
    expect(harness.delegatedCall(1).options?.reasoning).toBe('high');
    expect(harness.session.getLastDecision()?.trajectoryFriction?.unavailable).toBeUndefined();
  });

  it('repicks a strictly stronger model on the next invocation', async () => {
    const harness = await setupProviderTest({
      dir: temp.path,
      config: { switchMargin: 0.15 },
      benchmarks: [
        {
          registryId: 'alpha/source',
          benchSlug: 'source',
          active: true,
          quality: { intelligence: 90, coding: 90, agenticCoding: 90, research: 0.81 },
          source: 'test',
        },
        {
          registryId: 'gamma/strong',
          benchSlug: 'strong',
          active: true,
          quality: { intelligence: 95, coding: 95, agenticCoding: 95, research: 0.855 },
          source: 'test',
        },
      ],
      models: [
        registryModel('alpha/source', {
          contextWindow: 200000,
          maxTokens: 8192,
          cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
        }),
        registryModel('gamma/strong', {
          contextWindow: 200000,
          maxTokens: 8192,
          cost: { input: 100, output: 400, cacheRead: 0, cacheWrite: 0 },
        }),
      ],
    });
    harness.scriptReply([{ type: 'text_delta', delta: 'served' }, { type: 'done' }]);
    const context = {
      messages: [{ role: 'user', content: 'design a distributed rate limiter architecture' }],
    } as unknown as Context;
    await harness.serve(context);
    const served = harness.session.getLastServed();
    const fromModel = served?.registryId
      ? served.thinkingLevel ? `${served.registryId}:${served.thinkingLevel}` : served.registryId
      : harness.session.getLastDecision()?.chosen;
    setStruggleAfterRecovery(
      harness.session,
      {
        escalate: true,
        tfi: 1,
        signals: [{ kind: 'aor', severity: 'severe', evidenceIds: ['a:o'], evidenceCount: 1 }],
      },
      fromModel,
      harness.session.getLastDecision()?.dimension,
      false,
    );
    harness.outStream.events = [];
    harness.outStream.ended = false;
    vi.mocked(streamSimple).mockClear();
    harness.scriptReply([{ type: 'text_delta', delta: 'stronger' }, { type: 'done' }]);
    await harness.serve(context);
    const decision = harness.getProviderState().lastDecision;
    expect(decision?.chosen).toBe('gamma/strong');
    // A plan request investigates first; the investigation owns the task
    // type, so the repick changes the model, not the cause.
    expect(decision?.cause).toBe('investigation');
    expect(decision?.trajectoryFriction?.fromModel).toBe(fromModel);
  });

  it('gives the first struggle of a model a recovery attempt on that model, then escalates', async () => {
    const harness = await setupProviderTest({
      dir: temp.path,
      config: { switchMargin: 0.15 },
      benchmarks: [
        { registryId: 'alpha/source', benchSlug: 'source', active: true, quality: { intelligence: 90, coding: 90, agenticCoding: 90, research: 0.81 }, source: 'test' },
        { registryId: 'gamma/strong', benchSlug: 'strong', active: true, quality: { intelligence: 95, coding: 95, agenticCoding: 95, research: 0.855 }, source: 'test' },
      ],
      models: [
        registryModel('alpha/source', { contextWindow: 200000, maxTokens: 8192, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 } }),
        registryModel('gamma/strong', { contextWindow: 200000, maxTokens: 8192, cost: { input: 100, output: 400, cacheRead: 0, cacheWrite: 0 } }),
      ],
    });
    const context = { messages: [{ role: 'user', content: 'design a distributed rate limiter architecture' }] } as unknown as Context;
    const serveAgain = async () => {
      harness.outStream.events = [];
      harness.outStream.ended = false;
      vi.mocked(streamSimple).mockClear();
      harness.scriptReply([{ type: 'text_delta', delta: 'served' }, { type: 'done' }]);
      await harness.serve(context);
      return harness.getProviderState().lastDecision;
    };
    harness.scriptReply([{ type: 'text_delta', delta: 'served' }, { type: 'done' }]);
    await harness.serve(context);
    const first = harness.getProviderState().lastDecision!;
    const served = harness.session.getLastServed()!;
    const fromModel = served.thinkingLevel ? `${served.registryId}:${served.thinkingLevel}` : served.registryId;
    const struggle = (id: string) => ({
      escalate: true,
      tfi: 1,
      signals: [{ kind: 'aor' as const, severity: 'severe' as const, evidenceIds: [id], evidenceCount: 1 }],
    });

    harness.session.setPendingTrajectoryEscalation(struggle('a:o'), fromModel, first.dimension, false);
    const recovery = await serveAgain();
    expect(recovery?.chosen).toBe(first.chosen);
    expect(recovery?.trajectoryFriction).toBeUndefined();
    const sent = vi.mocked(streamSimple).mock.calls.at(-1)?.[1] as Context;
    expect(JSON.stringify(sent.messages)).toContain('The same check still fails after your corrections.');

    harness.session.setPendingTrajectoryEscalation(struggle('b:o'), fromModel, first.dimension, false);
    const escalation = await serveAgain();
    expect(escalation?.chosen).toBe('gamma/strong');
    expect(escalation?.trajectoryFriction?.fromModel).toBe(fromModel);
  });

  it('keeps pending evidence when the selected rework actor fails auth and another actor serves', async () => {
    const harness = await setupProviderTest({
      dir: temp.path,
      config: { switchMargin: 0.15 },
      credentials: { 'gamma/strong': { ok: false, error: 'denied' } },
      benchmarks: [
        {
          registryId: 'alpha/source',
          benchSlug: 'source',
          active: true,
          quality: { intelligence: 90, coding: 90, agenticCoding: 90, research: 0.81 },
          source: 'test',
        },
        {
          registryId: 'gamma/strong',
          benchSlug: 'strong',
          active: true,
          quality: { intelligence: 95, coding: 95, agenticCoding: 95, research: 0.855 },
          source: 'test',
        },
        {
          // Below the collecting-context reasoning target: the rework selects gamma first, and delta serves only as fallback.
          registryId: 'delta/cheap',
          benchSlug: 'cheap',
          active: true,
          quality: { intelligence: 15, coding: 50, agenticCoding: 50, research: 0.45 },
          source: 'test',
        },
      ],
      models: [
        registryModel('alpha/source', {
          contextWindow: 200000,
          maxTokens: 8192,
          cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
        }),
        registryModel('gamma/strong', {
          contextWindow: 200000,
          maxTokens: 8192,
          cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        }),
        registryModel('delta/cheap', {
          contextWindow: 200000,
          maxTokens: 8192,
          cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        }),
      ],
    });
    harness.scriptReply([{ type: 'text_delta', delta: 'served' }, { type: 'done' }]);
    const context = {
      messages: [{ role: 'user', content: 'design a distributed rate limiter architecture' }],
    } as unknown as Context;
    await harness.serve(context);
    const served = harness.session.getLastServed();
    const fromModel = served?.registryId
      ? served.thinkingLevel ? `${served.registryId}:${served.thinkingLevel}` : served.registryId
      : harness.session.getLastDecision()?.chosen;
    const pending = {
      escalate: true as const,
      tfi: 1,
      signals: [{ kind: 'aor' as const, severity: 'severe' as const, evidenceIds: ['a:o'], evidenceCount: 1 }],
    };
    setStruggleAfterRecovery(
      harness.session,
      pending,
      fromModel,
      harness.session.getLastDecision()?.dimension,
      false,
    );
    const stored = harness.session.peekPendingTrajectoryEscalation();
    expect(stored).toBeDefined();
    harness.outStream.events = [];
    harness.outStream.ended = false;
    vi.mocked(streamSimple).mockClear();
    harness.scriptReply([{ type: 'text_delta', delta: 'recovered' }, { type: 'done' }]);
    await harness.serve(context);
    expect(harness.getProviderState().lastDecision?.chosen).toBe('delta/cheap');
    expect(harness.session.peekPendingTrajectoryEscalation()).toBe(stored);
  });
});

describe('no-stronger escalation gate', () => {
  // A single benchmarked model: any escalation from it finds nothing stronger,
  // so the between-turn repick marks `trajectoryFriction.unavailable` and the
  // router keeps serving it. The gate only decides user involvement.
  async function soloHarness(
    cfg: Record<string, unknown>,
    ui?: { select: ReturnType<typeof vi.fn>; input: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn> },
  ): Promise<Awaited<ReturnType<typeof setupProviderTest>>> {
    return setupProviderTest({
      dir: temp.path,
      config: { ...cfg },
      benchmarks: [{
        registryId: 'alpha/solo',
        benchSlug: 'solo',
        active: true,
        quality: { intelligence: 80, coding: 80, agenticCoding: 80, research: 0.72 },
        source: 'test',
      }] as unknown as Parameters<typeof setupProviderTest>[0]['benchmarks'],
      models: [registryModel('alpha/solo', {
        contextWindow: 200000,
        maxTokens: 8192,
        cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
      })],
      ...(ui ? { ctx: { hasUI: true, ui: ui as unknown as ExtensionContext['ui'] } } : {}),
    });
  }
  const context = {
    messages: [{ role: 'user', content: 'design a distributed rate limiter architecture' }],
  } as unknown as Context;
  function makeUi(over: Partial<{ select: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn> }> = {}) {
    return { select: vi.fn(async () => undefined), input: vi.fn(async () => undefined), notify: vi.fn(), ...over };
  }
  function setPendingStruggle(harness: Awaited<ReturnType<typeof setupProviderTest>>): void {
    const served = harness.session.getLastServed();
    const fromModel = served?.registryId
      ? served.thinkingLevel ? `${served.registryId}:${served.thinkingLevel}` : served.registryId
      : harness.session.getLastDecision()?.chosen;
    setStruggleAfterRecovery(
      harness.session,
      { escalate: true, tfi: 1, signals: [{ kind: 'aor', severity: 'severe', evidenceIds: ['a:o'], evidenceCount: 1 }] },
      fromModel,
      harness.session.getLastDecision()?.dimension,
      false,
    );
    harness.outStream.events = [];
    harness.outStream.ended = false;
    vi.mocked(streamSimple).mockClear();
  }

  it('semi on: stops the turn when the user declines to continue', async () => {
    const ui = makeUi({ select: vi.fn(async (_t: string, opts: string[]) => opts[1]) });
    const harness = await soloHarness({ semi: true }, ui);
    harness.scriptReply([{ type: 'text_delta', delta: 'served' }, { type: 'done' }]);
    await harness.serve(context);
    setPendingStruggle(harness);
    harness.scriptReply([{ type: 'text_delta', delta: 'should not run' }, { type: 'done' }]);
    await harness.serve(context);

    expect(ui.select).toHaveBeenCalledTimes(1);
    expect(harness.streamedModels()).toEqual([]);
    const terminal = harness.outStream.events.find((e) => e.type === 'error');
    expect(terminal).toBeDefined();
    expect((terminal as { reason?: string }).reason).toBe('aborted');
  });

  it('semi on: continues with the current model when the user accepts', async () => {
    const ui = makeUi({ select: vi.fn(async (_t: string, opts: string[]) => opts[0]) });
    const harness = await soloHarness({ semi: true }, ui);
    harness.scriptReply([{ type: 'text_delta', delta: 'served' }, { type: 'done' }]);
    await harness.serve(context);
    setPendingStruggle(harness);
    harness.scriptReply([{ type: 'text_delta', delta: 'kept going' }, { type: 'done' }]);
    await harness.serve(context);

    expect(ui.select).toHaveBeenCalledTimes(1);
    expect(harness.streamedModels()).toEqual(['alpha/solo']);
  });

  it('semi off: warns and continues without a blocking prompt', async () => {
    const ui = makeUi();
    const harness = await soloHarness({ semi: false }, ui);
    harness.scriptReply([{ type: 'text_delta', delta: 'served' }, { type: 'done' }]);
    await harness.serve(context);
    setPendingStruggle(harness);
    harness.scriptReply([{ type: 'text_delta', delta: 'kept going' }, { type: 'done' }]);
    await harness.serve(context);

    expect(ui.select).not.toHaveBeenCalled();
    // The router also `notify`s routing status at 'info'; the struggle warning
    // is the only 'warning'-level notification.
    const warnings = ui.notify.mock.calls.filter((c) => c[1] === 'warning');
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]?.[0])).toContain('no permitted recovery action');
    expect(harness.streamedModels()).toEqual(['alpha/solo']);
  });
});

describe('session model blacklist', () => {
  it('adds failed models, removes one model, and clears all models', () => {
    defaultBlacklistState.blacklistModel('alpha/one');
    defaultBlacklistState.blacklistModel('beta/two');
    expect([...defaultBlacklistState.getBlacklistedModels()]).toEqual(['alpha/one', 'beta/two']);
    expect(defaultBlacklistState.removeBlacklistedModel('alpha/one')).toBe(true);
    expect([...defaultBlacklistState.getBlacklistedModels()]).toEqual(['beta/two']);
    defaultBlacklistState.clearBlacklistedModels();
    expect([...defaultBlacklistState.getBlacklistedModels()]).toEqual([]);
  });
});

describe('config-file blacklist — excluded from routing entirely', () => {
  let harness: ProviderTestHarness;

  async function setupWithConfig(config: Record<string, unknown>) {
    harness = await setupProviderTest({
      dir: temp.path,
      config,
      // Two providers, each with a "gemini"-named model, so a `*/gemini*`
      // pattern must exclude both regardless of provider.
      models: [
        registryModel('alpha/gemini-pro', { contextWindow: 200000, maxTokens: 8192, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 } }),
        registryModel('beta/gemini-flash', { contextWindow: 200000, maxTokens: 8192, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 } }),
        registryModel('gamma/other', { contextWindow: 200000, maxTokens: 8192, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 } }),
      ],
    });
    // Seed the session so config blacklist patterns are live (mirrors what
    // index.ts does on session_start). Import after setupProviderTest's
    // resetModules so this is the same blacklist module instance the router
    // reads.
    const { defaultBlacklistState } = await import('./blacklist.js');
    defaultBlacklistState.addSessionBlacklistPatterns((config.blacklist as string[]) ?? []);
  }

  it('excludes every matching model across providers for a `*/gemini*` pattern', async () => {
    await setupWithConfig({ blacklist: ['*/gemini*'] });

    const ctx = { messages: [{ role: 'user', content: 'hello' }] } as unknown as Context;
    harness.scriptReply([{ type: 'text_delta', delta: 'served' }, { type: 'done' }]);

    await harness.serve(ctx);

    const decision = harness.getProviderState().lastDecision;
    expect(decision).toBeDefined();
    expect(decision!.chosen).toBe('gamma/other');
    expect(decision!.fallbackChain).not.toContain('alpha/gemini-pro');
    expect(decision!.fallbackChain).not.toContain('beta/gemini-flash');
  });

  it('excludes a whole provider with a provider glob', async () => {
    await setupWithConfig({ blacklist: ['alpha/*'] });

    const ctx = { messages: [{ role: 'user', content: 'hello' }] } as unknown as Context;
    harness.scriptReply([{ type: 'text_delta', delta: 'served' }, { type: 'done' }]);

    await harness.serve(ctx);

    const decision = harness.getProviderState().lastDecision;
    expect(decision!.fallbackChain).not.toContain('alpha/gemini-pro');
  });

  it('reports "no routable models" when the blacklist matches everything', async () => {
    await setupWithConfig({ blacklist: ['*/*'] });

    const ctx = { messages: [{ role: 'user', content: 'hello' }] } as unknown as Context;

    await harness.serve(ctx);

    const errorEvent = harness.outStream.events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.error?.errorMessage ?? errorEvent!.error?.message).toContain('No routable models');
  });
});

describe('usage-limit provider blacklist — excluded from routing entirely', () => {
  let harness: ProviderTestHarness;

  beforeEach(async () => {
    harness = await setupProviderTest({
      dir: temp.path,
      models: [
        registryModel('alpha/one', { contextWindow: 200000, maxTokens: 8192, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 } }),
        registryModel('alpha/two', { contextWindow: 200000, maxTokens: 8192, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 } }),
        registryModel('beta/second', { contextWindow: 200000, maxTokens: 8192, cost: { input: 1, output: 5, cacheRead: 0, cacheWrite: 0 } }),
      ],
    });
    // Seed the provider exclusion against the same blacklist module instance
    // the router reads (setupProviderTest resets modules).
    const { defaultBlacklistState } = await import('./blacklist.js');
    defaultBlacklistState.blacklistProvider('alpha');
  });

  it('excludes every model of the blacklisted provider from the fallback chain', async () => {
    const ctx = { messages: [{ role: 'user', content: 'hello' }] } as unknown as Context;
    harness.scriptReply([{ type: 'text_delta', delta: 'served' }, { type: 'done' }]);

    await harness.serve(ctx);

    const decision = harness.getProviderState().lastDecision;
    expect(decision).toBeDefined();
    expect(decision!.chosen).toBe('beta/second');
    expect(decision!.fallbackChain).not.toContain('alpha/one');
    expect(decision!.fallbackChain).not.toContain('alpha/two');
  });

  it('reports "no routable models" naming the excluded provider when it is the only provider', async () => {
    const h = await setupProviderTest({
      dir: temp.path,
      models: [registryModel('alpha/only', { contextWindow: 200000, maxTokens: 8192, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 } })],
    });
    const { defaultBlacklistState } = await import('./blacklist.js');
    defaultBlacklistState.blacklistProvider('alpha');

    const ctx = { messages: [{ role: 'user', content: 'hello' }] } as unknown as Context;

    await h.serve(ctx);

    const errorEvent = h.outStream.events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    const msg = errorEvent!.error?.errorMessage ?? errorEvent!.error?.message;
    expect(msg).toContain('No routable models');
    expect(msg).toContain('alpha');
  });
});

// ─── Keyword classification without categorical evidence ───────────────

const SEEDED_BENCHMARKS = {
  version: 2,
  syncedAt: Date.now(),
  aliases: {},
  models: [
    { registryId: 'alpha/first', benchSlug: 'alpha-first', active: true, source: 'test', quality: { intelligence: 100, coding: 100, agenticCoding: 100, research: 0.9 } },
    { registryId: 'beta/second', benchSlug: 'beta-second', active: true, source: 'test', quality: { intelligence: 90, coding: 90, agenticCoding: 90, research: 0.81 } },
  ],
};

describe('an entry without an incumbent', () => {
  it.each(['спроектируй систему', 'implement the retry loop', 'review the diff', 'hello'])(
    'gathers without classifying %s', async (prompt) => {
    writeFileSync(join(temp.path, 'benchmarks.json'), benchStoreJson(SEEDED_BENCHMARKS), 'utf8');
    const harness = await setupProviderTest({ dir: temp.path });
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);

    await harness.serve({ messages: [{ role: 'user', content: prompt }] } as unknown as Context);

    const decision = harness.getProviderState().lastDecision;
    expect(decision?.dimension).toBe('gather');
    expect(decision?.cause).toBe('investigation');
    for (const key of ['confidence', 'routedUp', 'routedDown']) expect(decision).not.toHaveProperty(key);
  });
});

describe('gathering direct answers', () => {
  const context = { messages: [{ role: 'user', content: 'hello', timestamp: 1 }] } as unknown as Context;
  const records = async (): Promise<Array<Record<string, unknown>>> => {
    const { readFileSync } = await import('node:fs');
    const { DECISION_LOG_FILE } = await import('../host/decisionlog.js');
    return readFileSync(join(temp.path, DECISION_LOG_FILE), 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  };
  const actions = (rows: Array<Record<string, unknown>>) => rows
    .map((r) => (r.investigationHandoff as { action?: string } | undefined)?.action).filter(Boolean);

  it('streams one answer without a handoff, an incumbent, or retry telemetry', async () => {
    const harness = await setupProviderTest({ dir: temp.path, models: [registryModel('a/model')] });
    harness.scriptReply([{ type: 'text_delta', delta: 'visible answer' }, { type: 'done' }]);
    await harness.serve(context);
    expect(harness.streamedModels()).toEqual(['a/model']);
    expect(harness.outStream.events.filter((e) => e.type === 'text_delta').map((e) => (e as { delta: string }).delta))
      .toEqual(['visible answer']);
    expect(harness.outStream.events.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(harness.session.context.getIncumbent()).toBeUndefined();
    expect(harness.session.context.getLedger().items.size).toBe(0);
    const logged = await records();
    expect(actions(logged)).toEqual([]);
    expect(JSON.stringify(logged)).not.toContain('visible answer');
  });

  it('serves a declared direct answer once and remains gathering on the next entry', async () => {
    const harness = await setupProviderTest({ dir: temp.path, models: [registryModel('a/model')] });
    harness.scriptReply([{ type: 'toolcall_start' }, { type: 'done' }]);
    await harness.serve(context);
    const { submitContextHandoff } = await import('./context-handoff-tool.js');
    expect(submitContextHandoff({
      outcome: 'answer', deliverable: 'lightweight', complexity: 'trivial', scope: 'bounded',
    }, { model: { provider: 'router', id: 'auto' } } as unknown as ExtensionContext, harness.session).accepted).toBe(true);
    harness.resetEventStream();
    harness.scriptReply([{ type: 'text_delta', delta: 'declared answer' }, { type: 'done' }]);
    await harness.serve(context);
    expect(harness.streamedModels()).toEqual(['a/model', 'a/model']);
    expect(harness.outStream.events.filter((e) => e.type === 'text_delta')).toHaveLength(1);
    expect(harness.session.context.getIncumbent()).toBeUndefined();
    expect(actions(await records())).toContain('answer');
    harness.resetEventStream();
    harness.scriptReply([{ type: 'text_delta', delta: 'another entry' }, { type: 'done' }]);
    await harness.serve({ messages: [...context.messages, { role: 'user', content: 'next', timestamp: 2 }] } as unknown as Context);
    expect(harness.streamedModels()).toHaveLength(3);
    expect(harness.session.getWorkPhaseState()?.contextAnswer).toBeUndefined();
    expect(harness.session.context.getIncumbent()).toBeUndefined();
  });
});

describe('router-report counterfactual baseline', () => {
  const benchmarks: BenchModel[] = [
    {
      registryId: 'alpha/strong',
      benchSlug: 'strong',
      active: true,
      quality: { intelligence: 95, coding: 95, agenticCoding: 95, research: 0.855 },
      source: 'test',
    },
    {
      registryId: 'beta/cheap',
      benchSlug: 'cheap',
      active: true,
      quality: { intelligence: 60, coding: 60, agenticCoding: 60, research: 0.54 },
      source: 'test',
    },
  ];
  const models = [
    registryModel('alpha/strong', { contextWindow: 200000, maxTokens: 8192, cost: { input: 10, output: 50 } }),
    registryModel('beta/cheap', { contextWindow: 200000, maxTokens: 8192, cost: { input: 1, output: 5 } }),
  ];

  it('auto-picks the highest measured-capability routable candidate when no baselineModel is pinned', async () => {
    const harness = await setupProviderTest({
      dir: temp.path,
      benchmarks,
      models,
      pi: { setThinkingLevel: vi.fn() } as unknown as ExtensionAPI,
    });
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);
    await harness.serve(
      { messages: [{ role: 'user', content: 'implement the retry logic across the module' }] } as unknown as Context,
    );
    const decision = harness.getProviderState().lastDecision;
    expect(decision?.baseline?.registryId).toBe('alpha/strong');
    expect(decision?.baseline?.source).toBe('auto');
  });

  it('uses config.baselineModel when it is still in the routable pool', async () => {
    const harness = await setupProviderTest({
      dir: temp.path,
      config: { baselineModel: 'beta/cheap' },
      benchmarks,
      models,
      pi: { setThinkingLevel: vi.fn() } as unknown as ExtensionAPI,
    });
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);
    await harness.serve(
      { messages: [{ role: 'user', content: 'implement the retry logic across the module' }] } as unknown as Context,
    );
    const decision = harness.getProviderState().lastDecision;
    expect(decision?.baseline?.registryId).toBe('beta/cheap');
    expect(decision?.baseline?.source).toBe('config');
  });

  it('falls back to auto-pick when config.baselineModel is not in the routable pool', async () => {
    const harness = await setupProviderTest({
      dir: temp.path,
      config: { baselineModel: 'nonexistent/model' },
      benchmarks,
      models,
      pi: { setThinkingLevel: vi.fn() } as unknown as ExtensionAPI,
    });
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);
    await harness.serve(
      { messages: [{ role: 'user', content: 'implement the retry logic across the module' }] } as unknown as Context,
    );
    const decision = harness.getProviderState().lastDecision;
    expect(decision?.baseline?.registryId).toBe('alpha/strong');
    expect(decision?.baseline?.source).toBe('auto');
  });

  it('prices routedCost and baselineCost from the same observed tokens onto the decision log', async () => {
    const harness = await setupProviderTest({
      dir: temp.path,
      config: { baselineModel: 'alpha/strong' },
      benchmarks,
      models,
      pi: { setThinkingLevel: vi.fn() } as unknown as ExtensionAPI,
    });
    harness.scriptReply([
      { type: 'text_delta', delta: 'ok' },
      { type: 'done', message: { usage: { input: 100, output: 20, cacheRead: 0, cost: { total: 0 } } } },
    ]);
    await harness.serve(
      { messages: [{ role: 'user', content: 'the cheapest possible one-liner change' }] } as unknown as Context,
    );
    const { readRecentEntries } = await import('../host/decisionlog.js');
    const entry = readRecentEntries(1, temp.path)[0];
    expect(entry?.baselineModel).toBe('alpha/strong');
    expect(entry?.baselineSource).toBe('config');
    expect(typeof entry?.routedCost).toBe('number');
    // The answer's observed tokens price both costs on the same registry basis.
    expect(harness.streamedModels()).toHaveLength(1);
    expect(entry?.baselineCost).toBe((10 * 100 + 50 * 20) / 1_000_000);
  });
});
