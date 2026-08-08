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
import {
  blacklistModel,
  buildSubagentProviderAuthFilter,
  clearBlacklistedModels,
  expandModelCandidates,
  getBlacklistedModels,
  removeBlacklistedModel,
} from './provider.js';
import { setDelegationTimeouts } from './delegation.js';
import { createTempRouterDir } from './test-support/temp-router-dir.js';
import { registryModel } from './test-support/router-fixtures.js';
import {
  asStream,
  expectDecisionContract,
  fetchDecisionContractHandles,
  setupProviderTest,
  type ProviderTestHarness,
  type ResolvedRequestAuth,
} from './test-support/provider-harness.js';
import type { BenchModel } from './types.js';
import type { Dimension } from './types.js';
import type { EmbeddingResult } from './embedding.js';

// Embedding engine mock: provider.ts pulls `embedAndClassify` from
// ./embedding.js. Only the embedding-blend describe below drives it; the
// blend only fires when config.embeddingClassifier is true, which the other
// tests never set, so a default undefined (no verdict) is a no-op for them.
const embeddingMock = vi.hoisted(() => ({ embedAndClassify: vi.fn() }));
vi.mock('./embedding.js', () => ({
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

  it('does not emit an effort the model supports but has no row for (rule 3)', () => {
    const model = registryModel('p/model', {
      reasoning: true,
      thinkingLevelMap: { off: 'off', low: 'low', medium: 'medium', high: 'high', max: 'max' },
    });
    const candidates = expandModelCandidates(model, [benchRow('low', 30)]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.effort).toBe('low');
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
  const { setDecisionLogBase } = await import('./decisionlog.js');
  setDecisionLogBase(undefined);
  clearBlacklistedModels();
  vi.useRealTimers();
  vi.restoreAllMocks();
  temp.cleanup();
});

vi.mock('@earendil-works/pi-ai', () => ({
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
    expect(streamSimple).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.any(String) }),
      expect.any(Object),
      expect.any(Object),
    );
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

  it('injects route-up guidance into the delegated context system prompt', async () => {
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);

    await harness.serve(context);

    const { context: delegatedContext } = harness.delegatedCall();
    expect(delegatedContext.systemPrompt).toContain('[router/auto]');
    expect(delegatedContext.systemPrompt).toContain('route_up');
    // The original caller context must not be mutated.
    expect(context.systemPrompt).toBeUndefined();
  });

  it('injects plan-tier route-up guidance when an alternative candidate exists', async () => {
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);

    const planContext = {
      messages: [{ role: 'user', content: 'design a distributed rate limiter architecture' }],
    } as unknown as Context;
    await harness.serve(planContext);

    const { context: delegatedContext } = harness.delegatedCall();
    expect(delegatedContext.systemPrompt).toContain('[router/auto]');
    expect(delegatedContext.systemPrompt).toContain('stronger model');
  });

  // ─── concrete subagent model delegation ─────────────────────────────

  it('serves the winning candidate at its measured effort', async () => {
    // This test counts streamSimple calls for the delegation walk; disable the
    // shadow assessment so its detached dispatch cannot add a call.
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

  it('raises a measured low effort to the dimension floor before serving (rule 3)', async () => {
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
    // "the user explicitly changed this". A turn-1 resolved level of 'high'
    // legitimately reappears as turn-2's incoming `options.reasoning` even
    // though the user never touched the thinking-level control — that must
    // still be treated as inherited, not as an explicit override, so a
    // dimension change (review -> plan) still adapts the level (high -> max).
    harness.scriptReply([{ type: 'text_delta', delta: 'ok' }, { type: 'done' }]);

    const reviewContext = {
      messages: [{ role: 'user', content: 'please review this pull request for security issues' }],
    } as unknown as Context;
    await harness.serve(reviewContext, {});
    const firstReasoning = harness.delegatedCall().options?.reasoning;
    expect(firstReasoning).toBe('high');

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
    expect(secondReasoning).toBe('max');
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
    // The token mechanism is gone: routing comes from the ordinary passive
    // path, and the prompt text earns no escalation cause of its own.
    expect(lastDecision?.cause).not.toBe('user-escalation');
    expect(lastDecision?.cause).not.toBe('model-escalation');
    expect(lastDecision?.contextPressure).toBeDefined();
    expect(lastDecision?.reason).not.toContain('[manual:');
    expect(lastDecision?.reason).toContain('[context-pressure: prefer fresh planner handoff]');
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
    // shadow assessment so its detached dispatch cannot add a call.
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
    expect(final).toMatch(/\(FALLBACK 2!\)/);

    const decision = harness.getProviderState().lastDecision;
    expect(decision?.chosen).toBe(attempted[1]);
    expect(decision?.fallbackChain[0]).toBe(attempted[1]);
    expect(new Set(decision?.fallbackChain).size).toBe(decision?.fallbackChain.length);
    expect(new Set(decision?.fallbackChain)).toEqual(new Set(attempted));
    expect(decision?.cause).toBe('error-fallback');

    const { readRecentEntries } = await import('./decisionlog.js');
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

    const { readRecentEntries } = await import('./decisionlog.js');
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

  it('honours a route_up escalation on the first prompt', async () => {
    await setupWithConfig({ escalationTool: true, escalationTtlTurns: 4 });

    // Request escalation before the first router/auto turn.
    const { requestEscalation } = await import('./escalation.js');
    requestEscalation('plan', 'this needs architecture thinking', 4);

    const ctx = { messages: [{ role: 'user', content: 'hi there' }] } as unknown as Context;
    harness.scriptReply([{ type: 'text_delta', delta: 'served' }, { type: 'done' }]);

    await harness.serve(ctx);

    const decision = harness.getProviderState().lastDecision;
    expect(decision).toBeDefined();
    expect(decision!.escalation).toBeDefined();
    expect(decision!.escalation?.heuristicDimension).toBe('lightweight');
    expect(decision!.routedUp).toBe(true);
    const handles = await fetchDecisionContractHandles(temp.path);
    expectDecisionContract({ ...handles, match: { dimension: 'plan', cause: 'model-escalation' } });
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

  it('applies depth escalation even when an assessment runs in shadow', async () => {
    await setupWithConfig({
      consultRouter: true,
      assessmentMode: 'shadow',
      depthEscalationTokens: 1000,
    });

    // Shadow assessments are detached and never affect routing, so the deep
    // context still forces the ordinary one-tier raise.
    const prompt = 'lorem ipsum dolor sit amet '.repeat(200);
    const ctx = { messages: [{ role: 'user', content: prompt }] } as unknown as Context;

    harness.scriptReply([{ type: 'text_delta', delta: 'served' }, { type: 'done' }]);

    await harness.serve(ctx);

    const decision = harness.getProviderState().lastDecision;
    expect(decision).toBeDefined();
    // The shadow verdict never touches the in-flight decision.
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
  }

  interface Session {
    routeTurn(prompt: string, opts?: RouteTurnOpts): Promise<RoutingDecision | undefined>;
    routeTurnAgainWithSameUserEntry(): Promise<RoutingDecision | undefined>;
    assessmentDispatchCount: number;
    latchGeneration: number;
    lastShadowRecord: Record<string, unknown> | undefined;
    shadowRecordCount: number;
    drainDetachedAssessments(): Promise<void>;
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
      lastShadowRecord: undefined,
      shadowRecordCount: 0,
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
      async drainDetachedAssessments() {
        await new Promise((resolve) => setTimeout(resolve, 20));
        try {
          const { readFileSync } = await import('node:fs');
          const { DECISION_LOG_FILE } = await import('./decisionlog.js');
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
            .filter((e): e is Record<string, unknown> => e?.kind === 'assessment-shadow');
          session.lastShadowRecord = records.at(-1);
          session.shadowRecordCount = records.length;
        } catch {
          session.lastShadowRecord = undefined;
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
        return asStream([
          {
            type: 'text_delta',
            delta:
              opts.assessorReply ??
              'Dimension: gather\nScope: bounded\nOutcome: investigate\nConfidence: high\nReasoning: ok',
          },
        ]);
      }
      return asStream([{ type: 'text_delta', delta: 'served' }, { type: 'done' }]);
    });

    await harness.serve(ctx);
    // Let detached assessment microtasks land before counting dispatches.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const state = harness.getProviderState();
    session.latchGeneration = (await import('./router-session-state.js')).getLatchGeneration();
    return state.lastDecision as unknown as RoutingDecision | undefined;
  }

  it('shadow mode routes identically to consultRouter:false', async () => {
    const shadow = await newSession({ assessmentMode: 'shadow', consultRouter: true });
    const shadowDecision = await shadow.routeTurn('investigate the flaky test');
    const deterministic = await newSession({ consultRouter: false });
    const deterministicDecision = await deterministic.routeTurn('investigate the flaky test');

    expect(shadowDecision?.dimension).toBe(deterministicDecision?.dimension);
    expect(shadowDecision?.cause).toBe(deterministicDecision?.cause);
    expect(shadowDecision?.chosen).toBe(deterministicDecision?.chosen);
    expect(shadowDecision?.fallbackChain).toEqual(deterministicDecision?.fallbackChain);
  });

  it('shadow mode adds no wall-clock time to the turn', async () => {
    const session = await newSession({ assessmentMode: 'shadow', consultRouter: true });
    const started = Date.now();
    await session.routeTurn('investigate the flaky test', { assessorNeverResponds: true });
    expect(Date.now() - started).toBeLessThan(300);
  });

  it('dispatches at most one assessment per user entry across the tool loop', async () => {
    const session = await newSession({ assessmentMode: 'shadow', consultRouter: true });
    await session.routeTurn('investigate the flaky test');
    await session.routeTurnAgainWithSameUserEntry();
    await session.routeTurnAgainWithSameUserEntry();

    expect(session.assessmentDispatchCount).toBe(1);
  });

  it('dispatches a new assessment when a new user entry arrives', async () => {
    const session = await newSession({ assessmentMode: 'shadow', consultRouter: true });
    await session.routeTurn('first request');
    await session.routeTurn('second request');
    expect(session.assessmentDispatchCount).toBe(2);
  });

  it('does not dispatch when consultRouter is false', async () => {
    const session = await newSession({ consultRouter: false });
    await session.routeTurn('anything at all');
    expect(session.assessmentDispatchCount).toBe(0);
  });

  it('blacklists the assessor provider when the assessor hits a usage-limit error', async () => {
    const session = await newSession({ assessmentMode: 'shadow', consultRouter: true });
    await session.routeTurn('investigate the flaky test', { assessorUsageLimit: true });

    // The assessor (cheapest candidate above the competence floor) is
    // alpha/cheap, so the shared cap error excludes provider 'alpha' — the
    // same provider the serving chain would have tried next.
    const { getBlacklistedProviders } = await import('./blacklist.js');
    expect([...getBlacklistedProviders()]).toEqual(['alpha']);
  });

  it('active mode adopts a high-confidence bounded downward verdict', async () => {
    const session = await newSession({ assessmentMode: 'active', consultRouter: true });
    const decision = await session.routeTurn('list the main features of docs/plan.md', {
      assessorReply:
        'Dimension: lightweight\nScope: bounded\nOutcome: extract\nConfidence: high\nReasoning: bounded extraction',
    });
    expect(decision?.dimension).toBe('lightweight');
    expect(decision?.cause).toBe('router-consult');
    expect(decision?.routedDown).toBe(true);
  });

  it('active mode keeps the heuristic and sets fallbackReason when unavailable', async () => {
    const session = await newSession({
      assessmentMode: 'active',
      consultRouter: true,
      assessmentDeadlineMs: 60,
    });
    const decision = await session.routeTurn('investigate the flaky test', {
      assessorNeverResponds: true,
    });
    expect(decision?.cause).toBe('heuristic');
    expect(decision?.fallbackReason).toBe('expiry');
  });

  it('a user escalation still outranks an assessment verdict', async () => {
    const session = await newSession({ assessmentMode: 'active', consultRouter: true });
    const { setPendingUserEscalation } = await import('./router-session-state.js');
    setPendingUserEscalation({ target: 'plan', fromModel: 'alpha/cheap' });

    const decision = await session.routeTurn('list the main features of docs/plan.md', {
      assessorReply:
        'Dimension: lightweight\nScope: bounded\nOutcome: extract\nConfidence: high\nReasoning: x',
    });
    expect(decision?.dimension).toBe('plan');
    expect(decision?.cause).toBe('user-escalation');
  });

  it('a model escalation still outranks an assessment verdict', async () => {
    const session = await newSession({ assessmentMode: 'active', consultRouter: true });
    const { requestEscalation } = await import('./escalation.js');
    requestEscalation('implement', 'the model asked for a stronger tier', 4);

    const decision = await session.routeTurn('list the main features of docs/plan.md', {
      assessorReply:
        'Dimension: lightweight\nScope: bounded\nOutcome: extract\nConfidence: high\nReasoning: x',
    });
    expect(decision?.dimension).toBe('implement');
    expect(decision?.cause).toBe('model-escalation');
  });

  it('reuses the active-mode verdict on later tool-loop turns of the same entry', async () => {
    const session = await newSession({ assessmentMode: 'active', consultRouter: true });
    const first = await session.routeTurn('list the main features of docs/plan.md', {
      assessorReply:
        'Dimension: lightweight\nScope: bounded\nOutcome: extract\nConfidence: high\nReasoning: bounded extraction',
    });
    const second = await session.routeTurnAgainWithSameUserEntry();

    expect(first?.dimension).toBe('lightweight');
    expect(second?.dimension).toBe('lightweight');
    // The cached verdict is reused: no second assessment dispatch.
    expect(session.assessmentDispatchCount).toBe(1);
  });

  it('reuses the fallbackReason on later tool-loop turns of the same entry', async () => {
    const session = await newSession({
      assessmentMode: 'active',
      consultRouter: true,
      assessmentDeadlineMs: 60,
    });
    await session.routeTurn('investigate the flaky test', { assessorNeverResponds: true });
    const second = await session.routeTurnAgainWithSameUserEntry();

    expect(second?.fallbackReason).toBe('expiry');
    expect(session.assessmentDispatchCount).toBe(1);
  });

  it('does not dispatch in active mode when consultRouter is false', async () => {
    const session = await newSession({ assessmentMode: 'active', consultRouter: false });
    const decision = await session.routeTurn('investigate the flaky test');
    expect(session.assessmentDispatchCount).toBe(0);
    expect(decision?.cause).toBe('heuristic');
  });

describe('latch veto', () => {
  it('shadow mode escalates as today and logs the counterfactual veto', async () => {
    const session = await newSession({ assessmentMode: 'shadow', consultRouter: true });
    const result = await session.routeTurn('investigate the flaky test', {
      estimatedContextTokens: 90_000,
      assessorReply:
        'Dimension: gather\nScope: bounded\nOutcome: extract\nConfidence: high\nReasoning: bounded',
    });

    expect(result?.dimension).toBe('implement');
    expect(result?.cause).toBe('context-depth');
    await session.drainDetachedAssessments();
    // Two records on the latch turn: the ordinary counterfactual plus the
    // latch record; the latch record is the distinguishable one.
    expect(session.shadowRecordCount).toBe(2);
    expect(session.lastShadowRecord?.latchTransition).toBe(true);
    expect(session.lastShadowRecord?.wouldVetoLatch).toBe(true);
  });

  it('active mode vetoes the first latch on a bounded high-confidence verdict', async () => {
    const session = await newSession({ assessmentMode: 'active', consultRouter: true });
    const result = await session.routeTurn('investigate the flaky test', {
      estimatedContextTokens: 90_000,
      assessorReply:
        'Dimension: gather\nScope: bounded\nOutcome: extract\nConfidence: high\nReasoning: bounded',
    });
    expect(result?.dimension).toBe('gather');
    expect(result?.cause).toBe('heuristic');
    expect((result?.assessment as { vetoedLatch?: boolean } | undefined)?.vetoedLatch).toBe(true);
  });

  it('active mode escalates on any other verdict', async () => {
    const session = await newSession({ assessmentMode: 'active', consultRouter: true });
    const result = await session.routeTurn('investigate the flaky test', {
      estimatedContextTokens: 90_000,
      assessorReply:
        'Dimension: gather\nScope: open-ended\nOutcome: investigate\nConfidence: high\nReasoning: broad',
    });
    expect(result?.cause).toBe('context-depth');
    expect((result?.assessment as { vetoedLatch?: boolean } | undefined)?.vetoedLatch).toBe(false);
  });

  it('active mode escalates when the latch assessment is unavailable — failure is up', async () => {
    const session = await newSession({
      assessmentMode: 'active',
      consultRouter: true,
      assessmentDeadlineMs: 60,
    });
    const result = await session.routeTurn('investigate the flaky test', {
      estimatedContextTokens: 90_000,
      assessorNeverResponds: true,
    });
    expect(result?.cause).toBe('context-depth');
  });

  it('bumps the latch generation exactly once per session, whichever way it resolves', async () => {
    const session = await newSession({ assessmentMode: 'active', consultRouter: true });
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
    const session = await newSession({ assessmentMode: 'active', consultRouter: true });
    await session.routeTurn('investigate the flaky test', {
      estimatedContextTokens: 90_000,
      assessorReply:
        'Dimension: gather\nScope: bounded\nOutcome: extract\nConfidence: high\nReasoning: bounded',
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
    const session = await newSession({ assessmentMode: 'active', consultRouter: true });
    await session.routeTurn('investigate the flaky test', {
      estimatedContextTokens: 90_000,
      assessorReply:
        'Dimension: gather\nScope: bounded\nOutcome: extract\nConfidence: high\nReasoning: bounded',
    });
    const next = await session.routeTurn('investigate the flaky test', {
      estimatedContextTokens: 95_000,
      assessorReply:
        'Dimension: gather\nScope: open-ended\nOutcome: investigate\nConfidence: high\nReasoning: broad',
    });
    // The veto applied only to the first latch evaluation; the next real user
    // entry escalates through the ordinary depth path again.
    expect(next?.dimension).toBe('implement');
    expect(next?.cause).toBe('context-depth');
  });

  it('a pending user escalation does not consume the one-shot latch assessment', async () => {
    const session = await newSession({ assessmentMode: 'active', consultRouter: true });
    const { setPendingUserEscalation } = await import('./router-session-state.js');
    setPendingUserEscalation({ target: 'plan' });
    await session.routeTurn('investigate the flaky test', { estimatedContextTokens: 90_000 });
    // User escalation owns the dimension, so depth never fires and the latch
    // must remain armed for the real first transition later in the session.
    expect(session.latchGeneration).toBe(0);
  });

  it('a veto holds for the whole tool loop of the vetoed entry', async () => {
    const session = await newSession({ assessmentMode: 'active', consultRouter: true });
    await session.routeTurn('investigate the flaky test', {
      estimatedContextTokens: 90_000,
      assessorReply:
        'Dimension: gather\nScope: bounded\nOutcome: extract\nConfidence: high\nReasoning: bounded',
    });
    // The next invocation in the same tool loop must reuse the veto — the
    // dimension stays gather (not bumped to implement by depth escalation)
    // and the cause stays heuristic (not overridden to context-depth).
    const after = await session.routeTurnAgainWithSameUserEntry();
    expect(after?.dimension).toBe('gather');
    expect(after?.cause).toBe('heuristic');
  });

  it('dispatches at most one assessment on a latch-transition user entry', async () => {
    const session = await newSession({ assessmentMode: 'active', consultRouter: true });
    await session.routeTurn('investigate the flaky test', { estimatedContextTokens: 90_000 });
    await session.routeTurnAgainWithSameUserEntry();
    // The latch turn dispatches the ordinary assessment; the latch reuses its
    // verdict rather than dispatching a second one.  The tool-loop turn
    // reuses the cache rather than dispatching a third.  One total.
    expect(session.assessmentDispatchCount).toBe(1);
  });
});

});

describe('capability escalation and plan-tier route-up', () => {
  let harness: ProviderTestHarness;

  const sourceModel = registryModel('alpha/source', {
    contextWindow: 200000,
    maxTokens: 8192,
    cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
  });
  const weakModel = registryModel('beta/weak', {
    contextWindow: 200000,
    maxTokens: 8192,
    cost: { input: 0.2, output: 0.4, cacheRead: 0, cacheWrite: 0 },
  });
  const strongModel = registryModel('gamma/strong', {
    contextWindow: 200000,
    maxTokens: 8192,
    cost: { input: 100, output: 400, cacheRead: 0, cacheWrite: 0 },
  });

  async function setupCapabilityScenario(models = [sourceModel, weakModel, strongModel]) {
    harness = await setupProviderTest({
      dir: temp.path,
      config: { consultRouter: false, escalationTool: true, switchMargin: 0.15 },
      benchmarks: [
        {
          registryId: 'alpha/source',
          benchSlug: 'source',
          active: true,
          quality: { intelligence: 90, coding: 90, agenticCoding: 90 },
          source: 'test',
        },
        {
          registryId: 'beta/weak',
          benchSlug: 'weak',
          active: true,
          quality: { intelligence: 80, coding: 80, agenticCoding: 80 },
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
      models,
      pi: { setThinkingLevel: vi.fn() } as unknown as ExtensionAPI,
    });
    const { requestEscalation } = await import('./escalation.js');
    harness.scriptReply([{ type: 'text_delta', delta: 'served' }, { type: 'done' }]);
    return { getProviderState: () => harness.getProviderState(), requestEscalation };
  }

  function resetOutput() {
    harness.outStream.events = [];
    harness.outStream.ended = false;
    vi.mocked(streamSimple).mockClear();
  }

  it('repicks a quality-first model after same-dimension plan capability escalation', async () => {
    const { getProviderState, requestEscalation } = await setupCapabilityScenario();
    const context = {
      messages: [{ role: 'user', content: 'design a distributed rate limiter architecture' }],
    } as unknown as Context;

    await harness.serve(context);
    expect(getProviderState().lastServed?.registryId).toBe('alpha/source');
    expect(requestEscalation('plan', 'the architecture needs a stronger model', 1).ok).toBe(true);

    resetOutput();
    await harness.serve(context);

    const decision = getProviderState().lastDecision;
    expect(decision?.fallbackChain[0]).toBe('gamma/strong');
    const handles = await fetchDecisionContractHandles(temp.path);
    expectDecisionContract({
      ...handles,
      match: { chosen: 'gamma/strong', cause: 'capability-escalation', dimension: 'plan' },
    });
  });

  it('repicks but retains model-escalation cause after a lower-dimension capability escalation', async () => {
    const { getProviderState, requestEscalation } = await setupCapabilityScenario();
    const context = { messages: [{ role: 'user', content: 'hi' }] } as unknown as Context;

    await harness.serve(context);
    expect(getProviderState().lastServed?.registryId).toBe('alpha/source');
    expect(requestEscalation('gather', 'this lookup needs a stronger model', 1).ok).toBe(true);

    resetOutput();
    await harness.serve(context);

    const decision = getProviderState().lastDecision;
    expect(decision?.fallbackChain[0]).toBe('gamma/strong');
    const handles = await fetchDecisionContractHandles(temp.path);
    expectDecisionContract({
      ...handles,
      match: { chosen: 'gamma/strong', cause: 'model-escalation', dimension: 'gather' },
    });
  });

  it('retains the prior cause when same-dimension capability escalation has no alternative', async () => {
    const { getProviderState, requestEscalation } = await setupCapabilityScenario([sourceModel]);
    const context = {
      messages: [{ role: 'user', content: 'design a distributed rate limiter architecture' }],
    } as unknown as Context;

    await harness.serve(context);
    expect(getProviderState().lastDecision?.cause).toBe('heuristic');
    expect(requestEscalation('plan', 'the architecture needs a stronger model', 1).ok).toBe(true);

    resetOutput();
    await harness.serve(context);

    const decision = getProviderState().lastDecision;
    expect(decision?.chosen).toBe('alpha/source');
    expect(decision?.escalation?.requestedDimension).toBe('plan');
    const handles = await fetchDecisionContractHandles(temp.path);
    expectDecisionContract({ ...handles, match: { chosen: 'alpha/source', cause: 'heuristic' } });
  });

  it('does not derive any escalation cause from literal "!escalate" prompt text', async () => {
    const { getProviderState, requestEscalation } = await setupCapabilityScenario();
    const context = { messages: [{ role: 'user', content: 'hi !escalate' }] } as unknown as Context;

    await harness.serve(context);
    expect(getProviderState().lastServed?.registryId).toBe('alpha/source');
    expect(getProviderState().lastDecision?.cause).toBe('heuristic');
    expect(requestEscalation('gather', 'this needs a stronger model', 1).ok).toBe(true);

    resetOutput();
    await harness.serve(context);

    const decision = getProviderState().lastDecision;
    // With the token gone the base dimension is no longer pre-raised, so the
    // model's route_up request genuinely raises it and owns the cause.
    expect(decision?.cause).toBe('model-escalation');
    expect(decision?.escalation).toBeDefined();
    expect(decision?.escalation?.reason).toContain('stronger model');
    expect(decision?.chosen).not.toBe('alpha/source');
  });

  it('omits plan-tier route-up guidance for a single-candidate pool', async () => {
    await setupCapabilityScenario([sourceModel]);
    const context = {
      messages: [{ role: 'user', content: 'design a distributed rate limiter architecture' }],
    } as unknown as Context;

    await harness.serve(context);

    expect(harness.delegatedCall().context.systemPrompt ?? '').not.toContain('[router/auto]');
  });
});

describe('session model blacklist', () => {
  it('adds failed models, removes one model, and clears all models', () => {
    blacklistModel('alpha/one');
    blacklistModel('beta/two');
    expect([...getBlacklistedModels()]).toEqual(['alpha/one', 'beta/two']);
    expect(removeBlacklistedModel('alpha/one')).toBe(true);
    expect([...getBlacklistedModels()]).toEqual(['beta/two']);
    clearBlacklistedModels();
    expect([...getBlacklistedModels()]).toEqual([]);
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
    const { addSessionBlacklistPatterns } = await import('./blacklist.js');
    addSessionBlacklistPatterns((config.blacklist as string[]) ?? []);
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
    const { blacklistProvider } = await import('./blacklist.js');
    blacklistProvider('alpha');
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
    const { blacklistProvider } = await import('./blacklist.js');
    blacklistProvider('alpha');

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
const viContext = (suffix: string) =>
  ({ messages: [{ role: 'user', content: `viết code giúp tôi ${suffix}` }] }) as unknown as Context;

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

    await harness.serve(viContext('low'));

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

    await harness.serve(viContext('high'));

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

    await harness.serve(viContext('weak'));

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

    await harness.serve(viContext('degrade'));

    const decision = harness.getProviderState().lastDecision;
    // No verdict → keyword stands (R2).
    expect(decision?.dimension).toBe('gather');
    expect(decision?.cause).toBe('heuristic');
    expect(harness.getProviderState().embeddingStats).toMatchObject({ fired: 0, promoted: 0, abstainedLowConf: 0, degraded: 1 });
  });
});
