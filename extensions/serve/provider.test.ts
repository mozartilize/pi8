/**
 * Provider registration and orchestration tests for `router/auto`.
 *
 * These tests cover provider-level orchestration and its integration with
 * delegation: route-up system-prompt injection, thinking-level re-adaptation,
 * registry model registration, concrete subagent delegation, status
 * reporting, and the decision-log/lastDecision consistency smoke for top-pick
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
import { buildSubagentProviderAuthFilter, expandModelCandidates } from './provider.js';
import { setDelegationTimeouts } from './delegation.js';
import { evaluateMutationCall } from '../routing/policy/mutation-gate.js';
import { classifyMutationCall } from '../routing/policy/mutation-detector.js';
import { createTempRouterDir } from '../test-support/temp-router-dir.js';
import { registryModel, routingDecision } from '../test-support/router-fixtures.js';
import {
  asStream,
  expectDecisionContract,
  fetchDecisionContractHandles,
  setupProviderTest,
  type ProviderTestHarness,
  type ResolvedRequestAuth,
} from '../test-support/provider-harness.js';
import type { BenchModel } from '../types.js';
import type { Dimension } from '../types.js';
import type { EmbeddingResult } from '../embed/embedding.js';
import { defaultBlacklistState } from './blacklist.js';

// Embedding engine mock: provider.ts pulls `embedAndClassify` from
// ./embedding.js. Only the embedding-blend describe below drives it; the
// blend only fires when config.embeddingClassifier is true, which the other
// tests never set, so a default undefined (no verdict) is a no-op for them.
const embeddingMock = vi.hoisted(() => ({ embedAndClassify: vi.fn() }));
vi.mock('../embed/embedding.js', () => ({
  embedAndClassify: embeddingMock.embedAndClassify,
}));

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
        quality: { intelligence: 39, coding: 52, agenticCoding: 30.3 },
      },
      {
        ...benchRow('max', 42.1),
        quality: { intelligence: 42.1, coding: 56.2, agenticCoding: 33.7 },
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

  it('applies model-wide knowledge to every supported reasoning effort', () => {
    const model = registryModel('p/model', {
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: 'low',
        medium: 'medium',
        high: 'high',
        xhigh: 'xhigh',
        max: 'max',
      },
    });
    const modelWideKnowledge: BenchModel = {
      ...benchRow('max', 0),
      benchSlug: 'model',
      effort: undefined,
      quality: { knowledge: -11.2 },
      source: 'benchlm',
    };

    const candidates = expandModelCandidates(model, [
      benchRow('high', 50),
      benchRow('max', 60),
      modelWideKnowledge,
    ]);
    const byEffort = new Map(candidates.map((candidate) => [candidate.effort, candidate]));

    expect(byEffort.get('max')?.bench?.quality.knowledge).toBe(-11.2);
    expect(byEffort.get('high')?.bench?.quality.knowledge).toBe(-11.2);
    expect(byEffort.get('high')?.knowledgeByEffort).toEqual({
      low: -11.2,
      medium: -11.2,
      high: -11.2,
      xhigh: -11.2,
      max: -11.2,
    });
  });

  it('serves an unlabelled flagship knowledge-only row at max', () => {
    const model = registryModel('p/model', {
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: 'low',
        medium: 'medium',
        high: 'high',
        xhigh: 'xhigh',
        max: 'max',
      },
    });
    const row: BenchModel = {
      ...benchRow('max', 0),
      effort: undefined,
      quality: { knowledge: -11.2 },
      source: 'benchlm',
    };

    const candidates = expandModelCandidates(model, [row]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.effort).toBe('max');
    expect(candidates[0]?.bench?.quality).toEqual({ knowledge: -11.2 });
    expect(candidates[0]?.knowledgeByEffort).toEqual({
      low: -11.2,
      medium: -11.2,
      high: -11.2,
      xhigh: -11.2,
      max: -11.2,
    });
  });

  it('prefers an exact effort knowledge score over the model-wide score', () => {
    const model = registryModel('p/model', {
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: 'low',
        medium: 'medium',
        high: 'high',
        xhigh: 'xhigh',
        max: 'max',
      },
    });
    const candidates = expandModelCandidates(model, [
      { ...benchRow('high', 50), quality: { intelligence: 50, knowledge: -9.7 } },
      benchRow('max', 60),
      {
        ...benchRow('max', 0),
        effort: undefined,
        quality: { knowledge: -11.2 },
        source: 'benchlm',
      },
    ]);

    expect(candidates[0]?.knowledgeByEffort).toEqual({
      low: -11.2,
      medium: -11.2,
      high: -9.7,
      xhigh: -11.2,
      max: -11.2,
    });
  });

  it('keeps effort-labelled knowledge-only rows distinct', () => {
    const model = registryModel('p/model', {
      reasoning: true,
      thinkingLevelMap: { off: 'off', high: 'high', max: 'max' },
    });
    const rows = [
      { ...benchRow('high', 0), quality: { knowledge: -9.7 }, source: 'benchlm' },
      { ...benchRow('max', 0), quality: { knowledge: -10 }, source: 'benchlm' },
    ];

    const candidates = expandModelCandidates(model, rows);

    expect(candidates.map((candidate) => candidate.effort)).toEqual(['high', 'max']);
    expect(candidates.map((candidate) => candidate.bench?.quality.knowledge)).toEqual([-9.7, -10]);
    expect(candidates.every((candidate) =>
      candidate.knowledgeByEffort?.high === -9.7
      && candidate.knowledgeByEffort.max === -10,
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
  contentText: (await importOriginal<typeof import('@earendil-works/pi-ai')>()).contentText,
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

const REGISTRY_MODELS = [
  registryModel('alpha/first', {
    contextWindow: 200000,
    maxTokens: 8192,
    reasoning: true,
    thinkingLevelMap: { off: 'off', low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null },
    cost: { input: 10, output: 50, cacheRead: 0, cacheWrite: 0 },
  }),
  registryModel('beta/second', {
    contextWindow: 200000,
    maxTokens: 8192,
    reasoning: true,
    thinkingLevelMap: { off: 'off', high: 'high', xhigh: null, max: 'max' },
    cost: { input: 1, output: 5, cacheRead: 0, cacheWrite: 0 },
  }),
];

describe('provider auth filtering', () => {
  it('fails closed when the registry has no snapshot auth', () => {
    const filter = buildSubagentProviderAuthFilter(undefined, [{ provider: 'unavailable', id: 'model' }]);
    expect(filter('unavailable')).toBe(false);
  });

  it('fails closed when no provider has configured credentials', () => {
    const registry = {
      getProviderAuthStatus: () => ({ configured: false }),
    } as unknown as ExtensionContext['modelRegistry'];
    const filter = buildSubagentProviderAuthFilter(registry, [{ provider: 'unavailable', id: 'model' }]);
    expect(filter('unavailable')).toBe(false);
  });

  it('uses the synchronous snapshot auth status — no async I/O', () => {
    const registry = {
      getProviderAuthStatus: (p: string) => ({ configured: p === 'configured-only' }),
    } as unknown as ExtensionContext['modelRegistry'];
    const filter = buildSubagentProviderAuthFilter(registry, [
      { provider: 'configured-only', id: 'model' },
      { provider: 'unconfigured', id: 'model' },
    ]);
    expect(filter('configured-only')).toBe(true);
    expect(filter('unconfigured')).toBe(false);
  });

  it('excludes the router provider itself', () => {
    const registry = {
      getProviderAuthStatus: () => ({ configured: true }),
    } as unknown as ExtensionContext['modelRegistry'];
    const filter = buildSubagentProviderAuthFilter(registry, [
      { provider: 'router', id: 'auto' },
    ]);
    expect(filter('router')).toBe(false);
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

  it('serves a manual pin without assessment or fallback candidates', async () => {
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
    // One call proves the assessment dispatch was skipped; the only call served the pin.
    expect(harness.streamedModels()).toEqual(['alpha/first']);
  });

  it('names failed models, not the allowlist, when every candidate is excluded', async () => {
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);
    await harness.serve(context);
    for (const key of harness.getProviderState().lastDecision!.fallbackChain) harness.session.blacklistModel(key);
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
      JSON.stringify({ models: ['beta/*'], consultRouter: false }),
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

  it('resume reuses the pre-pin auto route for one entry, then recomputes', async () => {
    // 1. An ordinary auto turn establishes the route resume will reuse.
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);
    await harness.serve(
      { messages: [{ role: 'user', content: 'implement the parser' }] } as unknown as Context,
    );
    const autoDecision = harness.getProviderState().lastDecision!;
    expect(autoDecision.cause).not.toBe('resume');

    // 2. Pin the other model (snapshots the pre-pin route), then resume.
    harness.session.setManualModel('alpha/first');
    expect(harness.session.resumeManual()).toBe(true);

    // 3. A fresh user entry reuses the snapshot verbatim, cause `resume`.
    harness.resetEventStream();
    harness.scriptReply([{ type: 'text_delta', delta: 'ok2' }, { type: 'done' }]);
    await harness.serve(
      { messages: [{ role: 'user', content: 'a completely different request now' }] } as unknown as Context,
    );
    const resumed = harness.getProviderState().lastDecision!;
    expect(resumed.cause).toBe('resume');
    expect(resumed.chosen).toBe(autoDecision.chosen);
    expect(resumed.fallbackChain).toEqual(autoDecision.fallbackChain);

    // 4. The one-shot is spent: the next entry classifies normally again.
    harness.resetEventStream();
    harness.scriptReply([{ type: 'text_delta', delta: 'ok3' }, { type: 'done' }]);
    await harness.serve(
      { messages: [{ role: 'user', content: 'yet another distinct instruction' }] } as unknown as Context,
    );
    expect(harness.getProviderState().lastDecision!.cause).not.toBe('resume');
  });

  it('surfaces no-data when no candidate has benchmark data and heuristic owns the decision', async () => {
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);

    await harness.serve(
      { messages: [{ role: 'user', content: 'summarize this file' }] } as unknown as Context,
    );

    // The cause-precedence row must agree across the in-memory decision, the
    // durable decision log (/router-why after restart), and the rendered detail.
    const handles = await fetchDecisionContractHandles(temp.path);
    expectDecisionContract({ ...handles, match: { cause: 'no-data' } });
  });

  it('uses JSON-configured dimension weights when serving a turn', async () => {
    writeFileSync(join(temp.path, 'config.json'), JSON.stringify({
      consultRouter: false,
      dimensionWeights: {
        implement: { quality: 1, cost: 0, speed: 0 },
      },
    }));
    writeFileSync(join(temp.path, 'benchmarks.json'), JSON.stringify({
      version: 2,
      syncedAt: Date.now(),
      aliases: {},
      models: [
        { registryId: 'alpha/first', benchSlug: 'alpha-first', active: true, source: 'test', quality: { intelligence: 100, coding: 100, agenticCoding: 100, } },
        { registryId: 'beta/second', benchSlug: 'beta-second', active: true, source: 'test', quality: { intelligence: 90, coding: 90, agenticCoding: 90, } },
      ],
    }));
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);

    await harness.serve(
      { messages: [{ role: 'user', content: 'implement the parser' }] } as unknown as Context,
    );

    // With default implement weights the much cheaper beta candidate wins;
    // the JSON override makes quality decisive.
    expect(harness.getProviderState().lastDecision?.chosen).toBe('alpha/first');
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

  // ─── concrete subagent model delegation ─────────────────────────────

  it('uses the served effort, not the scored key, for the incumbent capability floor', async () => {
    writeFileSync(join(temp.path, 'config.json'), JSON.stringify({ consultRouter: false }));
    writeFileSync(join(temp.path, 'benchmarks.json'), JSON.stringify({
      version: 2, syncedAt: Date.now(), aliases: {}, models: [
        { registryId: 'alpha/first', benchSlug: 'first-low', effort: 'low', active: true, source: 'test', quality: { intelligence: 75, coding: 75, agenticCoding: 38.8 } },
        { registryId: 'alpha/first', benchSlug: 'first-medium', effort: 'medium', active: true, source: 'test', quality: { intelligence: 80, coding: 76, agenticCoding: 46 } },
        { registryId: 'beta/second', benchSlug: 'second-high', effort: 'high', active: true, source: 'test', quality: { intelligence: 78, coding: 74, agenticCoding: 42.1 } },
      ],
    }));
    harness.session.setLastDecision(routingDecision(['alpha/first:low']));
    harness.session.setLastServed({ registryId: 'alpha/first', thinkingLevel: 'medium', viaFallback: false, accumulatedCost: 0 });
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);
    await harness.serve({ messages: [{ role: 'user', content: 'implement the parser' }] } as unknown as Context);
    expect(harness.getProviderState().lastDecision?.chosen).toBe('alpha/first:medium');
    expect(harness.getProviderState().lastDecision?.fallbackChain[0]).toBe('alpha/first:medium');
    expect(harness.getProviderState().lastDecision?.reason).toContain('kept current model');
  });

  it('serves the winning candidate at its measured effort', async () => {
    // This test counts streamSimple calls for the delegation walk; disable the
    // assessment so its provider call is not included.
    writeFileSync(join(temp.path, 'config.json'), JSON.stringify({ consultRouter: false }), 'utf8');
    // The store binds alpha/first to one effort-labelled row; expansion
    // produces the alpha/first:high candidate, and implement's floor
    // (medium) lets the measured high win — the effort must reach
    // streamSimple and the chain entry must carry it.
    writeFileSync(join(temp.path, 'benchmarks.json'), JSON.stringify({
      version: 2,
      syncedAt: Date.now(),
      aliases: {},
      models: [
        { registryId: 'alpha/first', benchSlug: 'first-high', active: true, effort: 'high', source: 'test', quality: { intelligence: 100, coding: 100, agenticCoding: 100 } },
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

  it('raises a measured low effort to the dimension minimum before serving', async () => {
    writeFileSync(join(temp.path, 'config.json'), JSON.stringify({ consultRouter: false }), 'utf8');
    writeFileSync(join(temp.path, 'benchmarks.json'), JSON.stringify({
      version: 2,
      syncedAt: Date.now(),
      aliases: {},
      models: [
        { registryId: 'alpha/first', benchSlug: 'first-low', active: true, effort: 'low', source: 'test', quality: { intelligence: 100, coding: 100, agenticCoding: 100 } },
      ],
    }));
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);

    await harness.serve(
      { messages: [{ role: 'user', content: 'implement the parser' }] } as unknown as Context,
      {},
    );

    // implement floor is medium: the low measurement is raised, never sent.
    expect(harness.delegatedCall().options?.reasoning).toBe('medium');
  });

  it('lets an explicit user reasoning level suppress the router effort choice', async () => {
    writeFileSync(join(temp.path, 'config.json'), JSON.stringify({ consultRouter: false }), 'utf8');
    writeFileSync(join(temp.path, 'benchmarks.json'), JSON.stringify({
      version: 2,
      syncedAt: Date.now(),
      aliases: {},
      models: [
        { registryId: 'alpha/first', benchSlug: 'first-low', active: true, effort: 'low', source: 'test', quality: { intelligence: 100, coding: 100, agenticCoding: 100 } },
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

  it('re-adapts thinking level across dimension changes when Pi echoes back the last resolved level', async () => {
    // Pi's ctx.thinkingLevel mirrors whatever level the router actually used
    // last turn ("the current effective level"), not a dedicated flag for
    // "the user explicitly changed this". A turn-1 resolved level
    // legitimately reappears as turn-2's incoming `options.reasoning` even
    // though the user never touched the thinking-level control — that must
    // still be treated as inherited, not as an explicit override, so a
    // dimension change (review -> plan) still resolves through the new
    // dimension's own floor rather than pinning the echoed level.
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);

    const reviewContext = {
      messages: [{ role: 'user', content: 'please review this pull request for security issues' }],
    } as unknown as Context;
    await harness.serve(reviewContext, {});
    const firstReasoning = harness.delegatedCall().options?.reasoning;
    expect(firstReasoning).toBe('medium');

    harness.resetEventStream();
    vi.mocked(streamSimple).mockClear();
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);

    const planContext = {
      messages: [
        { role: 'user', content: 'design the architecture and plan the migration roadmap for this system' },
      ],
    } as unknown as Context;
    // Simulate Pi carrying forward the effective level it saw last turn.
    await harness.serve(planContext, { reasoning: firstReasoning });
    const secondReasoning = harness.delegatedCall().options?.reasoning;
    expect(secondReasoning).toBe('medium');
  });

  it('syncs Pi\'s own thinking-level state to the resolved level', async () => {
    // The footer/session state only updates via pi.setThinkingLevel; without
    // this call it would keep showing whatever level the user last set
    // manually, never reflecting what the router actually picked per-turn.
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);

    const reviewContext = {
      messages: [{ role: 'user', content: 'please review this pull request for security issues' }],
    } as unknown as Context;
    await harness.serve(reviewContext, {});

    expect(setThinkingLevelSpy).toHaveBeenCalledWith('medium');
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

  it('a concrete subagent model survives a provider stream error by falling back', async () => {
    // Subagents receive the selected concrete model directly. The fallback
    // loop still protects that spawn when its first provider attempt fails.
    let call = 0;
    harness.scriptReply(() => {
      call += 1;
      if (call === 1) {
        return asStream([
          { type: 'error', error: { errorMessage: 'Provider finish_reason: error' } },
        ]);
      }
      return asStream([{ type: 'text_delta', delta: 'review ok' }, { type: 'done' }]);
    });

    await harness.serve(context, undefined, { id: 'reviewer' } as Model<Api>);

    expect(call).toBe(2);
    expect(harness.outStream.events.filter((e) => e.type === 'error')).toHaveLength(0);
    expect(
      harness.outStream.events.some((e) => e.type === 'text_delta' && e.delta === 'review ok'),
    ).toBe(true);
  });

  it('classifies concrete subagent calls normally instead of treating ids as roles', async () => {
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);

    await harness.serve(context, undefined, { id: 'first' } as Model<Api>);

    const handles = await fetchDecisionContractHandles(temp.path);
    expectDecisionContract({ ...handles, match: { dimension: 'lightweight', cause: 'no-data' } });
  });

  it('flags context pressure against the chosen model window (not registry max)', async () => {
    writeFileSync(join(temp.path, 'config.json'), JSON.stringify({ lowConfidenceThreshold: 0 }, null, 2));
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);

    const longContext = {
      messages: [{ role: 'user', content: `analyze this ${'a'.repeat(500000)}` }],
    } as unknown as Context;

    await harness.serve(longContext);

    // Both depth escalation and context pressure fire on a deep cheap-tier
    // context. Depth escalation owns the cause because it actually changed
    // the routed dimension; pressure remains as advisory metadata.
    const { lastDecision } = harness.getProviderState();
    const handles = await fetchDecisionContractHandles(temp.path);
    expectDecisionContract({ ...handles, match: { cause: 'context-depth', dimension: 'implement' } });
    expect(lastDecision?.contextPressure?.usageRatio).toBeGreaterThanOrEqual(0.6);
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
    expect(lastDecision?.contextPressure).toBeDefined();
    expect(lastDecision?.reason).not.toContain('[manual:');
    expect(lastDecision?.reason).toContain('[context nearly full: prefer a fresh planner subagent]');
  });
});

describe('semi-automatic confirmation gate', () => {
  // Force `alpha/first` to be the routed pick so a `beta/second` incumbent is a
  // real switch; `beta/second` stays a routable candidate (it just loses on
  // quality), so the "keep" path has something to serve.
  const semiConfig = {
    semi: true,
    consultRouter: false,
    dimensionWeights: { implement: { quality: 1, cost: 0, speed: 0 } },
  };
  // Both measured (no unknown-quality upgrade): quality weight 1 then makes
  // alpha/first the unambiguous winner over the weaker beta/second.
  const semiBenchmarks = [
    {
      registryId: 'alpha/first',
      benchSlug: 'a',
      active: true,
      source: 'test',
      quality: { intelligence: 100, coding: 100, agenticCoding: 100 },
    },
    {
      registryId: 'beta/second',
      benchSlug: 'b',
      active: true,
      source: 'test',
      quality: { intelligence: 10, coding: 10, agenticCoding: 10 },
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
    expect(decision?.chosen).toBe('beta/second');
    expect(decision?.fallbackChain).toEqual(['beta/second']);
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
    expect(decision?.chosen).toBe('beta/second');
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
    expect(harness.getProviderState().lastDecision?.chosen).toBe('beta/second');
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
      config: { consultRouter: false },
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
});

describe('incumbent effort floor carries across invocations', () => {
  // The effort floor is a secondary field on a decision (it does not change
  // `dimension`), so a naive carry that reads only `getLastDecision()?.dimension`
  // silently drops it one turn after it was set. This must survive an
  // arbitrary number of subsequent turns, not just one hop.
  let harness: ProviderTestHarness;

  beforeEach(async () => {
    harness = await setupProviderTest({
      dir: temp.path,
      // A high threshold keeps every cheap-phrased follow-up below it, so the
      // incumbent capability floor holds across turns regardless of the real
      // classifier's confidence output for short prompts.
      config: { consultRouter: false, lowConfidenceThreshold: 0.99 },
      benchmarks: [
        {
          registryId: 'alpha/strong',
          benchSlug: 'strong',
          active: true,
          quality: { intelligence: 95, coding: 95, agenticCoding: 95 },
          source: 'test',
        },
        {
          registryId: 'beta/cheap',
          benchSlug: 'cheap',
          active: true,
          quality: { intelligence: 60, coding: 60, agenticCoding: 60 },
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

  it('keeps a stronger dimension as the effort floor two turns after it was resolved', async () => {
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);
    await harness.serve(
      { messages: [{ role: 'user', content: 'implement the retry logic across the module' }] } as unknown as Context,
    );
    expect(harness.getProviderState().lastDecision?.dimension).toBe('implement');
    expect(harness.getProviderState().lastServed?.registryId).toBe('alpha/strong');

    // Turn 2: a fresh, cheap-phrased entry. The incumbent capability floor
    // keeps alpha/strong served, and its own resolved dimension ('gather') is
    // weaker than the carried incumbent dimension ('implement'), so this
    // turn's decision gets an `effortFloorDimension` distinct from its own
    // `dimension` — exactly the case the naive carry loses.
    harness.outStream.events = [];
    harness.outStream.ended = false;
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);
    await harness.serve(
      { messages: [{ role: 'user', content: 'what about that' }] } as unknown as Context,
    );
    const turn2 = harness.getProviderState().lastDecision;
    expect(turn2?.dimension).toBe('gather');
    expect(turn2?.effortFloorDimension).toBe('implement');

    // Turn 3: another fresh, cheap-phrased entry. With the fix, the floor
    // carried into this turn's `incumbentResolvedDimension` is turn 2's
    // *effective* dimension ('implement'), not its raw `dimension` ('gather').
    harness.outStream.events = [];
    harness.outStream.ended = false;
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);
    await harness.serve(
      { messages: [{ role: 'user', content: 'and one more thing' }] } as unknown as Context,
    );
    const turn3 = harness.getProviderState().lastDecision;
    expect(turn3?.dimension).toBe('gather');
    expect(turn3?.effortFloorDimension).toBe('implement');
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
    // This test counts streamSimple calls for the delegation walk; disable the
    // assessment so its provider call is not included.
    writeFileSync(join(temp.path, 'config.json'), JSON.stringify({ consultRouter: false }), 'utf8');
    writeFileSync(join(temp.path, 'benchmarks.json'), JSON.stringify({
      version: 2,
      syncedAt: Date.now(),
      aliases: {},
      models: [
        { registryId: 'alpha/first', benchSlug: 'alpha-first', active: true, source: 'test', quality: { intelligence: 99, coding: 99, agenticCoding: 99, } },
        { registryId: 'beta/second', benchSlug: 'beta-second', active: true, source: 'test', quality: { intelligence: 50, coding: 50, agenticCoding: 50, } },
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
    expectDecisionContract({ ...handles, match: { chosen: 'beta/second', cause: 'error-fallback' } });

    // Credential failures are handled before streamSimple; the served fallback streams.
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

    const decision = harness.getProviderState().lastDecision;
    expect(decision?.chosen).toBe(attempted[1]);
    expect(decision?.fallbackChain[0]).toBe(attempted[1]);
    expect(new Set(decision?.fallbackChain).size).toBe(decision?.fallbackChain.length);
    expect(new Set(decision?.fallbackChain)).toEqual(new Set(attempted));
    expect(decision?.cause).toBe('error-fallback');

    const { readRecentEntries } = await import('../host/decisionlog.js');
    const logged = readRecentEntries(1, temp.path)[0];
    expect(logged).toMatchObject({
      chosen: attempted[1],
      served: attempted[1],
      cause: 'error-fallback',
      viaFallback: true,
    });
    expect(logged.chain[0]).toBe(attempted[1]);
  });

  it('keeps the original decision when the top pick serves', async () => {
    let served = '';
    harness.scriptReply((model) => {
      served = `${model.provider}/${model.id}`;
      return asStream([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);
    });

    await harness.serve(context);

    const decision = harness.getProviderState().lastDecision;
    expect(decision?.chosen).toBe(served);
    expect(decision?.fallbackChain[0]).toBe(served);
    expect(decision?.cause).not.toBe('error-fallback');

    const { readRecentEntries } = await import('../host/decisionlog.js');
    const logged = readRecentEntries(1, temp.path)[0];
    expect(logged.cause).toBe(decision?.cause);
    expect(logged.chain).toEqual(decision?.fallbackChain);
  });
});

describe('M4/M4b — consult and model escalation on first prompt', () => {
  let harness: ProviderTestHarness;

  async function setupWithConfig(config: Record<string, unknown>) {
    harness = await setupProviderTest({
      dir: temp.path,
      config,
      models: [
        registryModel('alpha/cheap', { contextWindow: 200000, maxTokens: 8192, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 } }),
        registryModel('beta/strong', { contextWindow: 200000, maxTokens: 8192, cost: { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 } }),
      ],
    });
  }

  it('routes a thin continuation from prior context and keeps it stable through tool turns', async () => {
    await setupWithConfig({ consultRouter: true });
    const baseMessages = [
      { role: 'user', content: 'Prepare the pending API authentication changes.', timestamp: 1 },
      {
        role: 'assistant',
        content: 'Next I will implement the approved API authentication changes.',
        timestamp: 2,
      },
      { role: 'user', content: 'ok go for it', timestamp: 3 },
    ];

    harness.scriptReply([{ type: 'text_delta', delta: 'served' }, { type: 'done' }]);

    await harness.serve({ messages: baseMessages } as unknown as Context);
    const firstDecision = harness.getProviderState().lastDecision;
    // Turn 1's row must agree with the log and the rendered detail.
    const firstHandles = await fetchDecisionContractHandles(temp.path);
    expectDecisionContract({
      ...firstHandles,
      match: { dimension: firstDecision?.dimension, cause: firstDecision?.cause },
    });

    harness.outStream.events = [];
    harness.outStream.ended = false;
    await harness.serve({
      messages: [
        ...baseMessages,
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 't', name: 'read', arguments: {} }],
          timestamp: 4,
        },
        {
          role: 'toolResult',
          toolCallId: 't',
          toolName: 'read',
          content: [{ type: 'text', text: 'large noisy output' }],
          timestamp: 5,
        },
      ],
    } as unknown as Context);
    const secondDecision = harness.getProviderState().lastDecision;

    expect(firstDecision?.dimension).toBe('implement');
    expect(firstDecision?.cause).toBe('continuation-context');
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

  it('raises gather one tier once the live context exceeds the depth threshold', async () => {
    await setupWithConfig({
      consultRouter: false,
      depthEscalationTokens: 1000,
    });

    // ~5400 chars ≈ 1350 tokens, no keyword evidence → gather heuristic fallback.
    const prompt = 'lorem ipsum dolor sit amet '.repeat(200);
    const ctx = { messages: [{ role: 'user', content: prompt }] } as unknown as Context;

    harness.scriptReply([{ type: 'text_delta', delta: 'served' }, { type: 'done' }]);

    await harness.serve(ctx);

    const decision = harness.getProviderState().lastDecision;
    expect(decision).toBeDefined();
    expect(decision!.routedUp).toBe(true);
    const handles = await fetchDecisionContractHandles(temp.path);
    expectDecisionContract({ ...handles, match: { dimension: 'implement', cause: 'context-depth' } });
  });

  it('leaves a shallow gather context below the depth threshold alone', async () => {
    await setupWithConfig({
      consultRouter: false,
      depthEscalationTokens: 1000,
    });

    const ctx = {
      messages: [{ role: 'user', content: 'lorem ipsum dolor' }],
    } as unknown as Context;

    harness.scriptReply([{ type: 'text_delta', delta: 'served' }, { type: 'done' }]);

    await harness.serve(ctx);

    const handles = await fetchDecisionContractHandles(temp.path);
    expectDecisionContract({ ...handles, match: { dimension: 'gather', cause: 'no-data' } });
  });

  it('respects the depthEscalation opt-out', async () => {
    await setupWithConfig({
      consultRouter: false,
      depthEscalation: false,
      depthEscalationTokens: 1,
    });

    const prompt = 'lorem ipsum dolor sit amet '.repeat(200);
    const ctx = { messages: [{ role: 'user', content: prompt }] } as unknown as Context;

    harness.scriptReply([{ type: 'text_delta', delta: 'served' }, { type: 'done' }]);

    await harness.serve(ctx);

    const handles = await fetchDecisionContractHandles(temp.path);
    expectDecisionContract({ ...handles, match: { dimension: 'gather', cause: 'no-data' } });
  });

  it('does not raise a dimension already above gather', async () => {
    await setupWithConfig({
      consultRouter: false,
      depthEscalationTokens: 1,
    });

    const ctx = {
      messages: [{ role: 'user', content: 'implement a function to parse the pending adjustment payload' }],
    } as unknown as Context;

    harness.scriptReply([{ type: 'text_delta', delta: 'served' }, { type: 'done' }]);

    await harness.serve(ctx);

    const handles = await fetchDecisionContractHandles(temp.path);
    expectDecisionContract({ ...handles, match: { dimension: 'implement', cause: 'no-data' } });
  });

  it('routes prompt text containing "!escalate" through the ordinary depth path', async () => {
    await setupWithConfig({
      consultRouter: false,
      depthEscalationTokens: 1,
    });

    const ctx = {
      messages: [{ role: 'user', content: '!escalate lorem ipsum dolor sit amet' }],
    } as unknown as Context;

    harness.scriptReply([{ type: 'text_delta', delta: 'served' }, { type: 'done' }]);

    await harness.serve(ctx);

    // Depth escalation still fires on context size; the literal token in the
    // prompt contributes nothing.
    const handles = await fetchDecisionContractHandles(temp.path);
    expectDecisionContract({ ...handles, match: { dimension: 'implement', cause: 'context-depth' } });
  });

  it('applies depth escalation when the assessment is unavailable', async () => {
    await setupWithConfig({
      consultRouter: true,
      depthEscalationTokens: 1000,
    });

    const prompt = 'lorem ipsum dolor sit amet '.repeat(200);
    const ctx = { messages: [{ role: 'user', content: prompt }] } as unknown as Context;

    harness.scriptReply([{ type: 'text_delta', delta: 'served' }, { type: 'done' }]);

    await harness.serve(ctx);

    const decision = harness.getProviderState().lastDecision;
    expect(decision).toBeDefined();
    expect(decision!.assessment).toBeUndefined();
    const handles = await fetchDecisionContractHandles(temp.path);
    expectDecisionContract({ ...handles, match: { dimension: 'implement', cause: 'context-depth' } });
  });
});

describe('assessment orchestration', () => {
  let harness: ProviderTestHarness;

  interface RouteTurnOpts {
    estimatedContextTokens?: number;
    assessorReply?: string;
    assessorNeverResponds?: boolean;
    assessorUsageLimit?: boolean;
    assessorDelayMs?: number;
    assessorGate?: Promise<void>;
  }

  interface Session {
    routeTurn(prompt: string, opts?: RouteTurnOpts): Promise<RoutingDecision | undefined>;
    routeTurnAgainWithSameUserEntry(): Promise<RoutingDecision | undefined>;
    assessmentDispatchCount: number;
    latchGeneration: number;
    lastMetricRecord: Record<string, unknown> | undefined;
    metricRecordCount: number;
    readAssessmentMetrics(): Promise<void>;
  }

  interface RoutingDecision {
    dimension: string;
    cause: string;
    chosen: string;
    fallbackChain: string[];
    routedUp?: boolean;
    routedDown?: boolean;
    fallbackReason?: string;
    assessment?: unknown;
  }

  async function newSession(config: Record<string, unknown>): Promise<Session> {
    harness = await setupProviderTest({
      dir: temp.path,
      config,
      // Seed benchmark rows so the no-data cause does not mask heuristic causes.
      benchmarks: [
        {
          registryId: 'alpha/cheap',
          benchSlug: 'alpha-cheap',
          active: true,
          quality: { intelligence: 0.5, coding: 0.5, agenticCoding: 0.5 },
          priceInputPer1M: 0.1,
          priceOutputPer1M: 0.2,
          source: 'test',
        },
        {
          registryId: 'beta/strong',
          benchSlug: 'beta-strong',
          active: true,
          quality: { intelligence: 0.9, coding: 0.9, agenticCoding: 0.9 },
          priceInputPer1M: 2,
          priceOutputPer1M: 8,
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
          cost: { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 },
        }),
      ],
    });

    let turnCounter = 0;
    let lastCtx: Context | undefined;

    const session: Session = {
      assessmentDispatchCount: 0,
      latchGeneration: 0,
      lastMetricRecord: undefined,
      metricRecordCount: 0,
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
      async routeTurnAgainWithSameUserEntry() {
        return invokeTurn(session, lastCtx!, {});
      },
      async readAssessmentMetrics() {
        await new Promise((resolve) => setTimeout(resolve, 20));
        try {
          const { readFileSync } = await import('node:fs');
          const { DECISION_LOG_FILE } = await import('../host/decisionlog.js');
          const raw = readFileSync(join(temp.path, DECISION_LOG_FILE), 'utf8').trim();
          const records = raw
            .split('\n')
            .map((line) => {
              try {
                return JSON.parse(line) as Record<string, unknown>;
              } catch {
                return undefined;
              }
            })
            .filter((e): e is Record<string, unknown> => e?.kind === 'assessment-metric');
          session.lastMetricRecord = records.at(-1);
          session.metricRecordCount = records.length;
        } catch {
          session.lastMetricRecord = undefined;
        }
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
    harness.scriptReply((_model: Model<Api>, callContext: Context) => {
      const userText =
        typeof callContext.messages[0]?.content === 'string'
          ? callContext.messages[0].content
          : '';
      if (userText.includes('You are a routing assessor')) {
        session.assessmentDispatchCount += 1;
        if (opts.assessorNeverResponds) {
          return {
            [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
          } as never;
        }
        if (opts.assessorUsageLimit) {
          return asStream([
            {
              type: 'error',
              error: {
                stopReason: 'error',
                errorMessage:
                  '429: {"type":"GoUsageLimitError","message":"Weekly usage limit reached. Resets in 5 days."}',
              },
            },
          ]);
        }
        const reply = opts.assessorReply
          ?? 'Kind: gather\nComplexity: routine\nScope: bounded\nCompound: no\nConfidence: high\nReasoning: ok';
        // The terminal message carries the full answer, as a Pi provider's does.
        const answer = [
          { type: 'text_delta', delta: reply },
          {
            type: 'done',
            message: {
              stopReason: 'stop',
              content: [{ type: 'text', text: reply }],
              usage: { input: 120, output: 30, cacheRead: 0 },
            },
          },
        ];
        if (opts.assessorDelayMs != null || opts.assessorGate) {
          return (async function* () {
            if (opts.assessorGate) await opts.assessorGate;
            else await new Promise((resolve) => setTimeout(resolve, opts.assessorDelayMs));
            yield* answer;
          })() as never;
        }
        return asStream(answer);
      }
      return asStream([{ type: 'text_delta', delta: 'served' }, { type: 'done' }]);
    });

    await harness.serve(ctx);
    const state = harness.getProviderState();
    session.latchGeneration = (await import('./router-session-state.js')).defaultRouterSession.intent.getLatchGeneration();
    return state.lastDecision as unknown as RoutingDecision | undefined;
  }

  it('dispatches at most one assessment per user entry across the tool loop', async () => {
    const session = await newSession({ consultRouter: true });
    await session.routeTurn('investigate the flaky test');
    await session.routeTurnAgainWithSameUserEntry();
    await session.routeTurnAgainWithSameUserEntry();

    expect(session.assessmentDispatchCount).toBe(1);
  });

  it('dispatches a new assessment when a new user entry arrives', async () => {
    const session = await newSession({ consultRouter: true });
    await session.routeTurn('first request');
    await session.routeTurn('second request');
    expect(session.assessmentDispatchCount).toBe(2);
  });

  it('records the adopted entry assessment as a joinable metric', async () => {
    const session = await newSession({ consultRouter: true });
    await session.routeTurn('investigate the flaky test');
    await session.readAssessmentMetrics();

    expect(session.metricRecordCount).toBe(1);
    expect(session.lastMetricRecord).toMatchObject({
      kind: 'assessment-metric',
      heuristicDimension: 'gather',
      counterfactualDimension: 'gather',
    });
    expect(session.lastMetricRecord?.intentKey).toEqual(expect.any(String));
    expect(session.lastMetricRecord?.latchTransition).toBeUndefined();
  });

  it('updates assessor economics from successful reported usage', async () => {
    const session = await newSession({ consultRouter: true });
    await session.routeTurn('investigate the flaky test');
    expect(harness.session.getAssessorTokenEstimate({ input: 1_000, output: 80 })).toEqual({
      input: 120,
      output: 30,
    });
  });

  it('aborts an awaited assessment after the session resets', async () => {
    const session = await newSession({ consultRouter: true });
    let release!: () => void;
    const assessorGate = new Promise<void>((resolve) => { release = resolve; });
    const pendingTurn = session.routeTurn('old assessment request', { assessorGate });
    while (session.assessmentDispatchCount === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const { defaultRouterSession: state } = await import('./router-session-state.js');
    state.reset();
    release();
    await pendingTurn;

    expect(state.assessment.getTokenEstimate({ input: 1_000, output: 80 })).toEqual({
      input: 1_000,
      output: 80,
    });
    expect(state.intent.getCachedIntent()).toBeUndefined();
  });

  it('blacklists the assessor provider before scoring the turn', async () => {
    const session = await newSession({ consultRouter: true });
    const decision = await session.routeTurn('investigate the flaky test', { assessorUsageLimit: true });

    const { defaultBlacklistState } = await import('./blacklist.js');
    expect([...defaultBlacklistState.getBlacklistedProviders()]).toEqual(['alpha']);
    expect(decision?.fallbackChain.some((id) => id.startsWith('alpha/'))).toBe(false);
  });

  it('adopts a high-confidence bounded downward verdict', async () => {
    const session = await newSession({ consultRouter: true });
    const decision = await session.routeTurn('list the main features of docs/plan.md', {
      assessorReply:
        'Kind: lightweight\nComplexity: trivial\nScope: bounded\nCompound: no\nConfidence: high\nReasoning: bounded extraction',
    });
    expect(decision?.dimension).toBe('lightweight');
    expect(decision?.cause).toBe('router-consult');
    expect(decision?.routedDown).toBe(true);
  });

  it('keeps the heuristic and sets fallbackReason when unavailable', async () => {
    const session = await newSession({
      consultRouter: true,
      assessmentDeadlineMs: 60,
    });
    const decision = await session.routeTurn('investigate the flaky test', {
      assessorNeverResponds: true,
    });
    expect(decision?.cause).toBe('heuristic');
    expect(decision?.fallbackReason).toBe('expiry');
  });

  it('switches plan to implement only after a mutation call with a high-confidence implement verdict', async () => {
    const session = await newSession({ consultRouter: true });
    const prompt = 'design the architecture and plan the migration roadmap for this system';
    const first = await session.routeTurn(prompt, {
      assessorReply: 'Kind: implement\nComplexity: moderate\nScope: open-ended\nCompound: no\nConfidence: high\nReasoning: implement deliverable',
    });
    expect(first?.dimension).toBe('plan');
    const state = harness.session.getWorkPhaseState()!;
    const mutation = evaluateMutationCall({ toolName: 'write', toolCallId: 'edit-1', state, served: harness.session.getLastServed() });
    expect(mutation.block).toBe(false);
    harness.session.commitWorkPhaseState(mutation.nextState);
    // A call is enough; neither tool success nor a path-based guess is required.
    const released = await session.routeTurnAgainWithSameUserEntry();
    expect(released?.dimension).toBe('implement');
    expect(released?.cause).toBe('mutation-phase');
    expect(session.assessmentDispatchCount).toBe(1);
    const repeated = await session.routeTurnAgainWithSameUserEntry();
    expect(repeated?.dimension).toBe('implement');
    expect(repeated?.cause).toBe('mutation-phase');
  });

  it('releases review on an identified Bash write without requiring a successful result', async () => {
    const session = await newSession({ consultRouter: true });
    const first = await session.routeTurn('review the authentication flow for mistakes', {
      assessorReply: 'Kind: implement\nComplexity: moderate\nScope: bounded\nCompound: no\nConfidence: high\nReasoning: fix requested',
    });
    expect(first?.dimension).toBe('review');
    const detection = classifyMutationCall('bash', { command: 'printf x > notes.md' });
    expect(detection.confidence).toBe('high');
    const mutation = evaluateMutationCall({ toolName: 'bash', toolCallId: 'b1', state: harness.session.getWorkPhaseState(), served: harness.session.getLastServed(), detection });
    harness.session.commitWorkPhaseState(mutation.nextState);
    expect((await session.routeTurnAgainWithSameUserEntry())?.dimension).toBe('implement');
  });

  it('keeps a plan deliverable even if its mutation call writes a file', async () => {
    const session = await newSession({ consultRouter: true });
    const first = await session.routeTurn('design the architecture and plan the migration roadmap for this system', {
      assessorReply: 'Kind: plan\nComplexity: moderate\nScope: bounded\nCompound: no\nConfidence: high\nReasoning: plan deliverable',
    });
    expect(first?.dimension).toBe('plan');
    const mutation = evaluateMutationCall({ toolName: 'write', toolCallId: 'plan-1', state: harness.session.getWorkPhaseState(), served: harness.session.getLastServed() });
    harness.session.commitWorkPhaseState(mutation.nextState);
    const second = await session.routeTurnAgainWithSameUserEntry();
    expect(second?.dimension).toBe('plan');
    expect(second?.cause).not.toBe('mutation-phase');
  });

  it('does not lower the task type on a missing or low-confidence verdict', async () => {
    const session = await newSession({ consultRouter: true });
    const prompt = 'design the architecture and plan the migration roadmap for this system';
    const first = await session.routeTurn(prompt, {
      assessorReply: 'Kind: implement\nComplexity: moderate\nScope: bounded\nCompound: no\nConfidence: low\nReasoning: uncertain',
    });
    expect(first?.dimension).toBe('plan');
    const mutation = evaluateMutationCall({ toolName: 'edit', toolCallId: 'edit-1', state: harness.session.getWorkPhaseState(), served: harness.session.getLastServed() });
    harness.session.commitWorkPhaseState(mutation.nextState);
    expect((await session.routeTurnAgainWithSameUserEntry())?.dimension).toBe('plan');
  });

  it('keeps the plan task type when the assessment fails before a mutation', async () => {
    const session = await newSession({ consultRouter: true });
    const first = await session.routeTurn('design the architecture and plan the migration roadmap for this system', {
      assessorUsageLimit: true,
    });
    expect(first?.dimension).toBe('plan');
    const mutation = evaluateMutationCall({ toolName: 'write', toolCallId: 'plan-1', state: harness.session.getWorkPhaseState(), served: harness.session.getLastServed() });
    harness.session.commitWorkPhaseState(mutation.nextState);
    expect((await session.routeTurnAgainWithSameUserEntry())?.dimension).toBe('plan');
  });

  it('reuses the verdict on later tool-loop turns of the same entry', async () => {
    const session = await newSession({ consultRouter: true });
    const first = await session.routeTurn('list the main features of docs/plan.md', {
      assessorReply:
        'Kind: lightweight\nComplexity: trivial\nScope: bounded\nCompound: no\nConfidence: high\nReasoning: bounded extraction',
    });
    const second = await session.routeTurnAgainWithSameUserEntry();

    expect(first?.dimension).toBe('lightweight');
    expect(second?.dimension).toBe('lightweight');
    // The cached verdict is reused: no second assessment dispatch.
    expect(session.assessmentDispatchCount).toBe(1);
  });

  it('reuses the fallbackReason on later tool-loop turns of the same entry', async () => {
    const session = await newSession({
      consultRouter: true,
      assessmentDeadlineMs: 60,
    });
    await session.routeTurn('investigate the flaky test', { assessorNeverResponds: true });
    const second = await session.routeTurnAgainWithSameUserEntry();

    expect(second?.fallbackReason).toBe('expiry');
    expect(session.assessmentDispatchCount).toBe(1);
  });

  it('does not dispatch when consultRouter is false', async () => {
    const session = await newSession({ consultRouter: false });
    const decision = await session.routeTurn('investigate the flaky test');
    expect(session.assessmentDispatchCount).toBe(0);
    expect(decision?.cause).toBe('heuristic');
  });

describe('latch veto', () => {
  it('logs entry and latch metrics while vetoing the first latch', async () => {
    const session = await newSession({ consultRouter: true });
    const result = await session.routeTurn('investigate the flaky test', {
      estimatedContextTokens: 90_000,
      assessorReply:
        'Kind: gather\nComplexity: routine\nScope: bounded\nCompound: no\nConfidence: high\nReasoning: bounded',
    });

    expect(result?.dimension).toBe('gather');
    expect(result?.cause).toBe('heuristic');
    await session.readAssessmentMetrics();
    expect(session.metricRecordCount).toBe(2);
    expect(session.lastMetricRecord?.latchTransition).toBe(true);
    expect(session.lastMetricRecord?.wouldVetoLatch).toBe(true);
    expect(session.assessmentDispatchCount).toBe(1);
  });

  it('vetoes the first latch on a bounded high-confidence verdict', async () => {
    const session = await newSession({ consultRouter: true });
    const result = await session.routeTurn('investigate the flaky test', {
      estimatedContextTokens: 90_000,
      assessorReply:
        'Kind: gather\nComplexity: routine\nScope: bounded\nCompound: no\nConfidence: high\nReasoning: bounded',
    });
    expect(result?.dimension).toBe('gather');
    expect(result?.cause).toBe('heuristic');
    expect((result?.assessment as { vetoedLatch?: boolean } | undefined)?.vetoedLatch).toBe(true);
  });

  it('escalates on any other verdict', async () => {
    const session = await newSession({ consultRouter: true });
    const result = await session.routeTurn('investigate the flaky test', {
      estimatedContextTokens: 90_000,
      assessorReply:
        'Kind: gather\nComplexity: routine\nScope: open-ended\nCompound: no\nConfidence: high\nReasoning: broad',
    });
    expect(result?.cause).toBe('context-depth');
    expect((result?.assessment as { vetoedLatch?: boolean } | undefined)?.vetoedLatch).toBe(false);
  });

  it('escalates when the latch assessment is unavailable — failure is up', async () => {
    const session = await newSession({
      consultRouter: true,
      assessmentDeadlineMs: 60,
    });
    const result = await session.routeTurn('investigate the flaky test', {
      estimatedContextTokens: 90_000,
      assessorNeverResponds: true,
    });
    expect(result?.cause).toBe('context-depth');
    // An unavailable verdict is not a licence for a second dispatch.
    expect(session.assessmentDispatchCount).toBe(1);
  });

  it('bumps the latch generation exactly once per session, whichever way it resolves', async () => {
    const session = await newSession({ consultRouter: true });
    await session.routeTurn('investigate the flaky test', { estimatedContextTokens: 90_000 });
    await session.routeTurn('what is in this file?', { estimatedContextTokens: 120_000 });
    await session.routeTurn('investigate the flaky test', { estimatedContextTokens: 150_000 });
    expect(session.latchGeneration).toBe(1);
  });

  it('bumps the generation once even in fully deterministic mode', async () => {
    const session = await newSession({ consultRouter: false });
    await session.routeTurn('investigate the flaky test', { estimatedContextTokens: 90_000 });
    await session.routeTurn('investigate the flaky test', { estimatedContextTokens: 120_000 });
    // No assessments at all, but the latch evaluation still consumed its turn.
    expect(session.assessmentDispatchCount).toBe(0);
    expect(session.latchGeneration).toBe(1);
  });

  it('the veto holds for the whole tool loop after the latch bump', async () => {
    // Behavior test rewritten with redesign: the latch veto is session state
    // bound to the intent key, so it holds for the whole tool loop of the
    // vetoed entry rather than lasting only one invocation.  The cached
    // verdict is reused instead of invalidated.
    const session = await newSession({ consultRouter: true });
    await session.routeTurn('investigate the flaky test', {
      estimatedContextTokens: 90_000,
      assessorReply:
        'Kind: gather\nComplexity: routine\nScope: bounded\nCompound: no\nConfidence: high\nReasoning: bounded',
    });
    const after = await session.routeTurnAgainWithSameUserEntry();
    // The veto holds: dimension stays gather, cause stays heuristic.
    // At most one assessment dispatched (the ordinary entry assessment;
    // the latch reused its verdict).
    expect(session.assessmentDispatchCount).toBe(1);
    expect(after?.dimension).toBe('gather');
    expect(after?.cause).toBe('heuristic');
    expect(session.latchGeneration).toBe(1);
  });

  it('re-arms the latch on the next real user entry after a veto', async () => {
    const session = await newSession({ consultRouter: true });
    await session.routeTurn('investigate the flaky test', {
      estimatedContextTokens: 90_000,
      assessorReply:
        'Kind: gather\nComplexity: routine\nScope: bounded\nCompound: no\nConfidence: high\nReasoning: bounded',
    });
    const next = await session.routeTurn('investigate the flaky test', {
      estimatedContextTokens: 95_000,
      assessorReply:
        'Kind: gather\nComplexity: routine\nScope: open-ended\nCompound: no\nConfidence: high\nReasoning: broad',
    });
    // The veto applied only to the first latch evaluation; the next real user
    // entry escalates through the ordinary depth path again.
    expect(next?.dimension).toBe('implement');
    expect(next?.cause).toBe('context-depth');
  });

  it('a veto holds for the whole tool loop of the vetoed entry', async () => {
    const session = await newSession({ consultRouter: true });
    await session.routeTurn('investigate the flaky test', {
      estimatedContextTokens: 90_000,
      assessorReply:
        'Kind: gather\nComplexity: routine\nScope: bounded\nCompound: no\nConfidence: high\nReasoning: bounded',
    });
    // The next invocation in the same tool loop must reuse the veto — the
    // dimension stays gather (not bumped to implement by depth escalation)
    // and the cause stays heuristic (not overridden to context-depth).
    const after = await session.routeTurnAgainWithSameUserEntry();
    expect(after?.dimension).toBe('gather');
    expect(after?.cause).toBe('heuristic');
  });

  it('dispatches at most one assessment on a latch-transition user entry', async () => {
    const session = await newSession({ consultRouter: true });
    await session.routeTurn('investigate the flaky test', { estimatedContextTokens: 90_000 });
    await session.routeTurnAgainWithSameUserEntry();
    // The latch turn dispatches the ordinary assessment; the latch reuses its
    // verdict rather than dispatching a second one.  The tool-loop turn
    // reuses the cache rather than dispatching a third.  One total.
    expect(session.assessmentDispatchCount).toBe(1);
  });
});

});

describe('trajectory capability escalation', () => {
  it('repicks a strictly stronger model on the next invocation', async () => {
    const harness = await setupProviderTest({
      dir: temp.path,
      config: { consultRouter: false, switchMargin: 0.15 },
      benchmarks: [
        {
          registryId: 'alpha/source',
          benchSlug: 'source',
          active: true,
          quality: { intelligence: 90, coding: 90, agenticCoding: 90 },
          source: 'test',
        },
        {
          registryId: 'gamma/strong',
          benchSlug: 'strong',
          active: true,
          quality: { intelligence: 95, coding: 95, agenticCoding: 95 },
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
    harness.session.armTrajectoryEscalation(
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
    expect(decision?.cause).toBe('trajectory-escalation');
    expect(decision?.trajectoryFriction?.fromModel).toBe(fromModel);
  });

  it('does not consume pending evidence when a weaker recovery candidate serves', async () => {
    const harness = await setupProviderTest({
      dir: temp.path,
      config: { consultRouter: false, switchMargin: 0.15 },
      credentials: { 'gamma/strong': { ok: false, error: 'denied' } },
      benchmarks: [
        {
          registryId: 'alpha/source',
          benchSlug: 'source',
          active: true,
          quality: { intelligence: 90, coding: 90, agenticCoding: 90 },
          source: 'test',
        },
        {
          registryId: 'gamma/strong',
          benchSlug: 'strong',
          active: true,
          quality: { intelligence: 95, coding: 95, agenticCoding: 95 },
          source: 'test',
        },
        {
          registryId: 'delta/cheap',
          benchSlug: 'cheap',
          active: true,
          quality: { intelligence: 50, coding: 50, agenticCoding: 50 },
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
        registryModel('delta/cheap', {
          contextWindow: 200000,
          maxTokens: 8192,
          cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0 },
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
    harness.session.armTrajectoryEscalation(
      pending,
      fromModel,
      harness.session.getLastDecision()?.dimension,
      false,
    );
    const armed = harness.session.peekPendingTrajectoryEscalation();
    expect(armed).toBeDefined();
    harness.outStream.events = [];
    harness.outStream.ended = false;
    vi.mocked(streamSimple).mockClear();
    harness.scriptReply([{ type: 'text_delta', delta: 'recovered' }, { type: 'done' }]);
    await harness.serve(context);
    expect(harness.getProviderState().lastDecision?.chosen).toBe('delta/cheap');
    expect(harness.session.peekPendingTrajectoryEscalation()).toBe(armed);
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
      config: { consultRouter: false, ...cfg },
      benchmarks: [{
        registryId: 'alpha/solo',
        benchSlug: 'solo',
        active: true,
        quality: { intelligence: 80, coding: 80, agenticCoding: 80 },
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
  function armStruggle(harness: Awaited<ReturnType<typeof setupProviderTest>>): void {
    const served = harness.session.getLastServed();
    const fromModel = served?.registryId
      ? served.thinkingLevel ? `${served.registryId}:${served.thinkingLevel}` : served.registryId
      : harness.session.getLastDecision()?.chosen;
    harness.session.armTrajectoryEscalation(
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
    armStruggle(harness);
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
    armStruggle(harness);
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
    armStruggle(harness);
    harness.scriptReply([{ type: 'text_delta', delta: 'kept going' }, { type: 'done' }]);
    await harness.serve(context);

    expect(ui.select).not.toHaveBeenCalled();
    // The router also `notify`s routing status at 'info'; the struggle warning
    // is the only 'warning'-level notification.
    const warnings = ui.notify.mock.calls.filter((c) => c[1] === 'warning');
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]?.[0])).toContain('no stronger model');
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

// ─── Embedding classifier blend (confidence floor) ─────────────────────

const SEEDED_BENCHMARKS = {
  version: 2,
  syncedAt: Date.now(),
  aliases: {},
  models: [
    { registryId: 'alpha/first', benchSlug: 'alpha-first', active: true, source: 'test', quality: { intelligence: 100, coding: 100, agenticCoding: 100 } },
    { registryId: 'beta/second', benchSlug: 'beta-second', active: true, source: 'test', quality: { intelligence: 90, coding: 90, agenticCoding: 90 } },
  ],
};

/** Non-English prompt: keyword classifier has no categorical evidence → gather. */
const nonEnglishContext = (suffix: string) =>
  ({ messages: [{ role: 'user', content: `спроектируй систему ${suffix}` }] }) as unknown as Context;

function embeddingResult(overrides: { dimension: Dimension; confidence: number }): EmbeddingResult {
  return {
    dimension: overrides.dimension,
    confidence: overrides.confidence,
    scores: { lightweight: 0, gather: 0.2, plan: 0.1, implement: 0.9, review: 0.3 },
  };
}

function enableEmbeddingClassifier(extra: Record<string, unknown> = {}): void {
  writeFileSync(
    join(temp.path, 'config.json'),
    JSON.stringify({ consultRouter: false, embeddingClassifier: true, ...extra }),
    'utf8',
  );
  writeFileSync(join(temp.path, 'benchmarks.json'), JSON.stringify(SEEDED_BENCHMARKS), 'utf8');
}

describe('embedding classifier blend', () => {
  let harness: ProviderTestHarness;

  beforeEach(async () => {
    embeddingMock.embedAndClassify.mockReset();
    embeddingMock.embedAndClassify.mockResolvedValue(undefined);
    harness = await setupProviderTest({ dir: temp.path });
  });

  it('abstains on a low-confidence embedding — keyword gather unchanged', async () => {
    enableEmbeddingClassifier(); // default embeddingMinConfidence 0.15
    embeddingMock.embedAndClassify.mockResolvedValue(
      embeddingResult({ dimension: 'implement', confidence: 0.1 }),
    );
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);

    await harness.serve(nonEnglishContext('low'));

    const decision = harness.getProviderState().lastDecision;
    // Confidence 0.1 < floor 0.15 → abstain: keyword's gather stands, cause stays heuristic.
    expect(decision?.dimension).toBe('gather');
    expect(decision?.cause).toBe('heuristic');
    expect(embeddingMock.embedAndClassify).toHaveBeenCalledTimes(1);
    expect(harness.getProviderState().embeddingStats).toMatchObject({ fired: 1, promoted: 0, abstainedLowConf: 1, degraded: 0 });
  });

  it('promotes on a high-confidence stronger embedding with cause embedding-classify', async () => {
    enableEmbeddingClassifier();
    embeddingMock.embedAndClassify.mockResolvedValue(
      embeddingResult({ dimension: 'implement', confidence: 0.8 }),
    );
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);

    await harness.serve(nonEnglishContext('high'));

    const decision = harness.getProviderState().lastDecision;
    expect(decision?.dimension).toBe('implement');
    expect(decision?.cause).toBe('embedding-classify');
    expect(harness.getProviderState().embeddingStats).toMatchObject({ fired: 1, promoted: 1, abstainedLowConf: 0, degraded: 0 });
  });

  it('never lets a below-floor embedding lower the keyword dimension (R3)', async () => {
    // Confident but WEAKER than keyword gather — must still keep gather.
    enableEmbeddingClassifier();
    embeddingMock.embedAndClassify.mockResolvedValue(
      embeddingResult({ dimension: 'lightweight', confidence: 0.9 }),
    );
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);

    await harness.serve(nonEnglishContext('weak'));

    const decision = harness.getProviderState().lastDecision;
    expect(decision?.dimension).toBe('gather');
    expect(decision?.cause).toBe('heuristic');
    // Confident but weaker → kept keyword: fired, no promote, no abstain.
    expect(harness.getProviderState().embeddingStats).toMatchObject({ fired: 1, promoted: 0, abstainedLowConf: 0, degraded: 0 });
  });

  it('tallies a degraded outcome when inference returns no verdict', async () => {
    enableEmbeddingClassifier();
    embeddingMock.embedAndClassify.mockResolvedValue(undefined);
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);

    await harness.serve(nonEnglishContext('degrade'));

    const decision = harness.getProviderState().lastDecision;
    // No verdict → keyword stands (R2).
    expect(decision?.dimension).toBe('gather');
    expect(decision?.cause).toBe('heuristic');
    expect(harness.getProviderState().embeddingStats).toMatchObject({ fired: 0, promoted: 0, abstainedLowConf: 0, degraded: 1 });
  });
});

describe('multi-work phase engagement', () => {
  // Keyword-classifies as 'implement' AND satisfies the deterministic terminal
  // classifier's prerequisite -> sequence -> mutation structure with an
  // explicit frontier-complexity and open-scope cue, so terminal.compound,
  // .discountEligible, and .confidence:'high' all hold without defaulting.
  const compoundPrompt =
    'Trace the race condition across the codebase from scratch, then fix it, refactor it, and implement the corrected logic.';
  const compoundContext = { messages: [{ role: 'user', content: compoundPrompt, timestamp: 1 }] } as unknown as Context;
  const nonCompoundImplementContext = {
    messages: [{ role: 'user', content: 'implement the parser', timestamp: 1 }],
  } as unknown as Context;

  const multiWorkBenchmarks: BenchModel[] = [
    {
      registryId: 'alpha/first',
      benchSlug: 'alpha-first',
      active: true,
      quality: { intelligence: 95, coding: 95, agenticCoding: 95 },
      priceInputPer1M: 10,
      priceOutputPer1M: 50,
      source: 'test',
    },
    {
      registryId: 'beta/second',
      benchSlug: 'beta-second',
      active: true,
      quality: { intelligence: 80, coding: 80, agenticCoding: 80 },
      priceInputPer1M: 1,
      priceOutputPer1M: 5,
      source: 'test',
    },
  ];

  it('engages inspect once for explicit compound frontier work', async () => {
    const harness = await setupProviderTest({
      dir: temp.path,
      config: { consultRouter: false },
      benchmarks: multiWorkBenchmarks,
    });
    harness.scriptReply([{ type: 'text_delta', delta: 'inspect' }, { type: 'done' }]);

    await harness.serve(compoundContext);

    expect(harness.getProviderState().workPhaseState).toMatchObject({
      phase: 'inspect',
      multiWorkEngaged: true,
      providerInvocation: 1,
    });
  });

  it('does not engage an ordinary implementation', async () => {
    const harness = await setupProviderTest({
      dir: temp.path,
      config: { consultRouter: false },
      benchmarks: multiWorkBenchmarks,
    });
    harness.scriptReply([{ type: 'text_delta', delta: 'serve' }, { type: 'done' }]);

    await harness.serve(nonCompoundImplementContext);

    expect(harness.getProviderState().workPhaseState).toMatchObject({
      multiWorkEngaged: false,
      phase: 'mutate',
    });
  });

  it('does not let assessor compound diagnostics engage multi-work in active v2 mode', async () => {
    const harness = await setupProviderTest({
      dir: temp.path,
      config: { consultRouter: true },
      benchmarks: multiWorkBenchmarks,
    });
    harness.scriptReply((_model, context) => asStream(
      ((context as Context).systemPrompt ?? '').includes('Kind: [lightweight|gather|plan|implement|review]')
        ? [
            { type: 'text_delta', delta: [
              'Kind: implement', 'Complexity: frontier', 'Scope: open-ended',
              'Compound: yes', 'Confidence: high', 'Reasoning: semantic diagnostic',
            ].join('\n') },
            { type: 'done' },
          ]
        : [{ type: 'text_delta', delta: 'serve' }, { type: 'done' }],
    ));

    await harness.serve(nonCompoundImplementContext);

    expect(harness.getProviderState().workPhaseState).toMatchObject({
      terminal: expect.objectContaining({ compound: false }),
      multiWorkEngaged: false,
    });
  });

  it('increments providerInvocation across same-intent tool-loop reinvocations', async () => {
    const harness = await setupProviderTest({
      dir: temp.path,
      config: { consultRouter: false },
      benchmarks: multiWorkBenchmarks,
    });
    harness.scriptReply([{ type: 'text_delta', delta: 'inspect' }, { type: 'done' }]);

    await harness.serve(compoundContext);
    expect(harness.getProviderState().workPhaseState).toMatchObject({ providerInvocation: 1, multiWorkEngaged: true });

    harness.resetEventStream();
    harness.scriptReply([{ type: 'text_delta', delta: 'inspect again' }, { type: 'done' }]);
    await harness.serve(compoundContext);

    expect(harness.getProviderState().workPhaseState).toMatchObject({ providerInvocation: 2, multiWorkEngaged: true, phase: 'inspect' });
  });

  it('inherits engagement and phase across a thin continuation of the same intent', async () => {
    const harness = await setupProviderTest({
      dir: temp.path,
      config: { consultRouter: false },
      benchmarks: multiWorkBenchmarks,
    });
    harness.scriptReply([{ type: 'text_delta', delta: 'inspect' }, { type: 'done' }]);
    await harness.serve(compoundContext);
    expect(harness.getProviderState().workPhaseState).toMatchObject({ multiWorkEngaged: true, phase: 'inspect' });

    harness.resetEventStream();
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);
    const thinContinuation = {
      messages: [
        { role: 'user', content: compoundPrompt, timestamp: 1 },
        { role: 'assistant', content: 'Found the source of the race condition.', timestamp: 1.5 },
        { role: 'user', content: 'go ahead', timestamp: 2 },
      ],
    } as unknown as Context;
    await harness.serve(thinContinuation);

    expect(harness.getProviderState().workPhaseState).toMatchObject({
      multiWorkEngaged: true,
      phase: 'inspect',
      providerInvocation: 1,
    });
  });

  it('produces the same decision as a direct pickBest call for a non-engaged intent', async () => {
    const harness = await setupProviderTest({
      dir: temp.path,
      config: { consultRouter: false },
      benchmarks: multiWorkBenchmarks,
    });
    harness.scriptReply([{ type: 'text_delta', delta: 'serve' }, { type: 'done' }]);

    await harness.serve(nonCompoundImplementContext);

    const decision = harness.getProviderState().lastDecision!;
    expect(decision.multiWork).toBeUndefined();

    const { pickBest } = await import('../routing/score/scorer.js');
    const { expandModelCandidates } = await import('./provider.js');
    const rows = new Map(multiWorkBenchmarks.map((b) => [b.registryId, [b]]));
    const baselineCandidates = REGISTRY_MODELS.flatMap((rm) =>
      expandModelCandidates(rm, rows.get(`${rm.provider}/${rm.id}`) ?? []),
    );
    const baseline = pickBest(baselineCandidates, 'implement', undefined, {
      estimatedContextTokens: 0,
      needsVision: false,
      isSubagentSpawn: false,
    });
    expect(decision.chosen).toBe(baseline.chosen);
    expect(decision.fallbackChain).toEqual(baseline.fallbackChain);
    expect(decision.dimension).toBe(baseline.dimension);
    expect(decision.cause).toBe(baseline.cause);
  });

});

describe('router-report counterfactual baseline', () => {
  const benchmarks: BenchModel[] = [
    {
      registryId: 'alpha/strong',
      benchSlug: 'strong',
      active: true,
      quality: { intelligence: 95, coding: 95, agenticCoding: 95 },
      source: 'test',
    },
    {
      registryId: 'beta/cheap',
      benchSlug: 'cheap',
      active: true,
      quality: { intelligence: 60, coding: 60, agenticCoding: 60 },
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
      config: { consultRouter: false },
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
      config: { consultRouter: false, baselineModel: 'beta/cheap' },
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
      config: { consultRouter: false, baselineModel: 'nonexistent/model' },
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
      config: { consultRouter: false, baselineModel: 'alpha/strong' },
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
    // Registry rates are USD per 1M tokens, so priced spend divides by 1e6.
    expect(entry?.baselineCost).toBe((10 * 100 + 50 * 20) / 1_000_000);
  });
});
