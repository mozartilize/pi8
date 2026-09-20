/**
 * `/router-blacklist` command tests.
 *
 * The important property split here: `add`/`remove` scope to the session
 * unless `--save` is passed, in which case they edit the persisted config-file
 * blacklist; `clear` takes no patterns and only wipes session state.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerCommands } from './commands.js';
import { loadConfig } from '../config.js';
import { blacklistModel, blacklistProvider, clearBlacklistedModels, getProviderState } from '../serve/provider.js';
import { clearSessionBlacklist, getSessionBlacklistPatterns } from '../serve/blacklist.js';
import {
  appendDecision,
  appendMutationGateSignal,
  appendAssessmentMetric,
  appendSubagentGapSignal,
  appendSubagentSpend,
} from './decisionlog.js';
import { saveStore, emptyStore } from '../bench/store.js';
import type { BenchmarkStore, RoutingDecision } from '../types.js';
import {
  peekPendingUserEscalation,
  resetRouterSession,
  setLastDecision,
  setLastServed,
} from '../serve/router-session-state.js';
import { applyEscalation, requestEscalation, resetEscalation } from '../serve/escalation.js';

let dir: string;
let prevEnv: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi8-blacklist-cmd-test-'));
  prevEnv = process.env.PI8_DIR;
  process.env.PI8_DIR = dir;
  clearBlacklistedModels();
  clearSessionBlacklist();
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.PI8_DIR;
  else process.env.PI8_DIR = prevEnv;
  rmSync(dir, { recursive: true, force: true });
  clearBlacklistedModels();
  clearSessionBlacklist();
});

/** Minimal fake ExtensionAPI: captures registered command handlers by name. */
function fakePi() {
  const handlers = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  const sendMessage = vi.fn(async () => {});
  return {
    pi: {
      registerCommand: (name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
        handlers.set(name, opts.handler);
      },
      sendMessage,
    } as unknown as Parameters<typeof registerCommands>[0],
    handlers,
    sendMessage,
  };
}

function fakeCtx(
  registryModels: Array<{ provider: string; id: string }> = [],
  overrides: { model?: { provider: string; id: string } | undefined } = {},
) {
  const messages: string[] = [];
  return {
    ctx: {
      ui: { notify: (msg: string) => messages.push(msg) },
      modelRegistry: { getAvailable: () => registryModels },
      model: 'model' in overrides ? overrides.model : { provider: 'router', id: 'auto' },
      waitForIdle: async () => {},
    } as unknown,
    messages,
  };
}

describe('/router-blacklist add|remove — session by default', () => {
  it('add applies to the session and leaves the config file untouched', async () => {
    const { pi, handlers } = fakePi();
    registerCommands(pi);
    const { ctx } = fakeCtx();

    await handlers.get('router-blacklist')!('add github-copilot/*', ctx);

    expect(getSessionBlacklistPatterns()).toEqual(['github-copilot/*']);
    expect(loadConfig().blacklist ?? []).toEqual([]);
  });

  it('add accepts several space-separated patterns at once', async () => {
    const { pi, handlers } = fakePi();
    registerCommands(pi);
    const { ctx } = fakeCtx();

    await handlers.get('router-blacklist')!('add github-copilot/* */gemini* opencode-go/hy3', ctx);

    expect(getSessionBlacklistPatterns()).toEqual([
      'github-copilot/*',
      '*/gemini*',
      'opencode-go/hy3',
    ]);
  });

  it('add is idempotent within the session', async () => {
    const { pi, handlers } = fakePi();
    registerCommands(pi);
    const { ctx } = fakeCtx();

    await handlers.get('router-blacklist')!('add github-copilot/*', ctx);
    await handlers.get('router-blacklist')!('add github-copilot/*', ctx);

    expect(getSessionBlacklistPatterns()).toEqual(['github-copilot/*']);
  });

  it('remove drops a session pattern and any runtime failure it matches', async () => {
    const { pi, handlers } = fakePi();
    registerCommands(pi);
    const { ctx } = fakeCtx();

    blacklistModel('github-copilot/gpt-5.4');
    blacklistModel('opencode-go/deepseek-v4-pro');
    await handlers.get('router-blacklist')!('add github-copilot/* opencode-go/hy3', ctx);

    await handlers.get('router-blacklist')!('remove github-copilot/*', ctx);

    expect(getSessionBlacklistPatterns()).toEqual(['opencode-go/hy3']);
    expect(getProviderState().blacklistedModels).toEqual(['opencode-go/deepseek-v4-pro']);
    expect(loadConfig().blacklist ?? []).toEqual([]);
  });

  it('remove with a provider-wide pattern lifts a usage-limit provider exclusion', async () => {
    const { pi, handlers } = fakePi();
    registerCommands(pi);
    const { ctx } = fakeCtx();

    blacklistProvider('opencode-go');
    await handlers.get('router-blacklist')!('add opencode-go/*', ctx);

    await handlers.get('router-blacklist')!('remove opencode-go/*', ctx);

    expect(getProviderState().blacklistedProviders).toEqual([]);
  });

  it('remove with an exact model pattern does not lift a provider exclusion', async () => {
    const { pi, handlers } = fakePi();
    registerCommands(pi);
    const { ctx } = fakeCtx();

    blacklistProvider('opencode-go');
    await handlers.get('router-blacklist')!('add opencode-go/deepseek-v4-pro', ctx);

    await handlers.get('router-blacklist')!('remove opencode-go/deepseek-v4-pro', ctx);

    expect(getProviderState().blacklistedProviders).toEqual(['opencode-go']);
  });
});

describe('/router-blacklist --save — persisted config blacklist', () => {
  it('add --save persists to config and seeds the session at once', async () => {
    const { pi, handlers } = fakePi();
    registerCommands(pi);
    const { ctx } = fakeCtx();

    await handlers.get('router-blacklist')!('add github-copilot/* */gemini* --save', ctx);

    expect(loadConfig().blacklist).toEqual(['github-copilot/*', '*/gemini*']);
    expect(getSessionBlacklistPatterns()).toEqual(['github-copilot/*', '*/gemini*']);
  });

  it('accepts --save before the patterns', async () => {
    const { pi, handlers } = fakePi();
    registerCommands(pi);
    const { ctx } = fakeCtx();

    await handlers.get('router-blacklist')!('add --save github-copilot/*', ctx);

    expect(loadConfig().blacklist).toEqual(['github-copilot/*']);
  });

  it('add --save is idempotent', async () => {
    const { pi, handlers } = fakePi();
    registerCommands(pi);
    const { ctx } = fakeCtx();

    await handlers.get('router-blacklist')!('add github-copilot/* --save', ctx);
    await handlers.get('router-blacklist')!('add github-copilot/* --save', ctx);

    expect(loadConfig().blacklist).toEqual(['github-copilot/*']);
  });

  it('remove --save deletes a persisted pattern', async () => {
    const { pi, handlers } = fakePi();
    registerCommands(pi);
    const { ctx } = fakeCtx();

    await handlers.get('router-blacklist')!('add github-copilot/* opencode-go/hy3 --save', ctx);
    await handlers.get('router-blacklist')!('remove github-copilot/* --save', ctx);

    expect(loadConfig().blacklist).toEqual(['opencode-go/hy3']);
  });

  it('a persisted pattern survives a new "session" (fresh loadConfig)', async () => {
    const { pi, handlers } = fakePi();
    registerCommands(pi);
    const { ctx } = fakeCtx();

    await handlers.get('router-blacklist')!('add github-copilot/* --save', ctx);

    expect(loadConfig().blacklist).toEqual(['github-copilot/*']);
  });
});

describe('/router-blacklist clear — session-only, no patterns', () => {
  it('clear wipes session patterns and runtime failures, leaving config alone', async () => {
    const { pi, handlers } = fakePi();
    registerCommands(pi);
    const { ctx } = fakeCtx();

    await handlers.get('router-blacklist')!('add opencode-go/hy3 --save', ctx);
    await handlers.get('router-blacklist')!('add github-copilot/*', ctx);
    blacklistModel('github-copilot/gpt-5.4');

    await handlers.get('router-blacklist')!('clear', ctx);

    expect(getSessionBlacklistPatterns()).toEqual([]);
    expect(getProviderState().blacklistedModels).toEqual([]);
    expect(loadConfig().blacklist).toEqual(['opencode-go/hy3']);
  });

  it('rejects a pattern argument, since clear is all-or-nothing', async () => {
    const { pi, handlers } = fakePi();
    registerCommands(pi);
    const { ctx, messages } = fakeCtx();

    await handlers.get('router-blacklist')!('add github-copilot/*', ctx);
    await handlers.get('router-blacklist')!('clear github-copilot/*', ctx);

    expect(getSessionBlacklistPatterns()).toEqual(['github-copilot/*']);
    expect(messages.at(-1)).toContain('Usage:');
  });

  it('refuses to persist a clear', async () => {
    const { pi, handlers } = fakePi();
    registerCommands(pi);
    const { ctx, messages } = fakeCtx();

    await handlers.get('router-blacklist')!('add opencode-go/hy3 --save', ctx);
    await handlers.get('router-blacklist')!('clear --save', ctx);

    expect(loadConfig().blacklist).toEqual(['opencode-go/hy3']);
    expect(messages.at(-1)).toContain('Usage:');
  });
});

describe('/router-blacklist — no args shows every list', () => {
  it('reports empty state for all three when nothing is blacklisted', async () => {
    const { pi, handlers } = fakePi();
    registerCommands(pi);
    const { ctx, messages } = fakeCtx();

    await handlers.get('router-blacklist')!('', ctx);

    expect(messages[0]).toContain('Config blacklist: (empty)');
    expect(messages[0]).toContain('Session blacklist patterns: (empty)');
  });

  it('lists session patterns separately from runtime failures', async () => {
    const { pi, handlers } = fakePi();
    registerCommands(pi);
    const { ctx, messages } = fakeCtx();

    await handlers.get('router-blacklist')!('add */gemini*', ctx);
    blacklistModel('github-copilot/gpt-5.4');

    await handlers.get('router-blacklist')!('', ctx);

    expect(messages.at(-1)).toContain('*/gemini*');
    expect(messages.at(-1)).toContain('github-copilot/gpt-5.4');
  });
});

describe('/router-status history filtering', () => {
  it('excludes self-healing-gap events from recent routing history while still reporting gaps', async () => {
    const { pi, handlers } = fakePi();
    registerCommands(pi);
    const registryModel = { provider: 'beta', id: 'second' };
    const { ctx, messages } = fakeCtx([registryModel]);

    const store: BenchmarkStore = {
      version: 2,
      syncedAt: Date.now(),
      aliases: {},
      models: [
        {
          registryId: 'beta/second',
          benchSlug: 'beta-second',
          active: true,
          quality: { coding: 80 },
          source: 'test',
        },
      ],
    };
    saveStore(store);

    const decision: RoutingDecision = {
      dimension: 'implement',
      chosen: 'beta/second',
      reason: 'scored',
      confidence: 0.7,
      routedUp: false,
      routedDown: false,
      cause: 'heuristic',
      fallbackChain: ['beta/second'],
    };
    appendDecision(decision, { registryId: 'beta/second', viaFallback: false, accumulatedCost: 0.01 });
    appendSubagentGapSignal({ role: 'worker', tool: 'ctx_search', model: 'unknown/unknown' });

    await handlers.get('router-status')!('', ctx);

    const msg = messages[messages.length - 1] ?? '';
    expect(msg).toContain('Recent routing history:');
    expect(msg).toContain('implement');
    expect(msg).toContain('→ beta/second');
    expect(msg).toContain('Observed subagent tool gaps');
    expect(msg).not.toContain('→ unknown/unknown');
  });

  it('excludes assessment metrics from routing history', async () => {
    const { pi, handlers } = fakePi();
    registerCommands(pi);
    const registryModel = { provider: 'beta', id: 'second' };
    const { ctx, messages } = fakeCtx([registryModel]);

    const store: BenchmarkStore = {
      version: 2,
      syncedAt: Date.now(),
      aliases: {},
      models: [
        {
          registryId: 'beta/second',
          benchSlug: 'beta-second',
          active: true,
          quality: { coding: 80 },
          source: 'test',
        },
      ],
    };
    saveStore(store);

    const decision: RoutingDecision = {
      dimension: 'implement',
      chosen: 'beta/second',
      reason: 'scored',
      confidence: 0.7,
      routedUp: false,
      routedDown: false,
      cause: 'heuristic',
      fallbackChain: ['beta/second'],
    };
    appendDecision(decision, { registryId: 'beta/second', viaFallback: false, accumulatedCost: 0.01 });
    appendAssessmentMetric({
      intentKey: '3:1:abc:0',
      heuristicDimension: 'gather',
      counterfactualDimension: 'lightweight',
    });

    await handlers.get('router-status')!('', ctx);

    const msg = messages[messages.length - 1] ?? '';
    expect(msg).toContain('→ beta/second');
    // Assessment telemetry must never appear as a routing decision.
    expect(msg).not.toContain('gather →');
    expect(msg).not.toContain('unknown/unknown');
  });

  it('excludes mutation-gate signals from routing history', async () => {
    const { pi, handlers } = fakePi();
    registerCommands(pi);
    const { ctx, messages } = fakeCtx([{ provider: 'beta', id: 'second' }]);
    saveStore({
      version: 2,
      syncedAt: Date.now(),
      aliases: {},
      models: [
        {
          registryId: 'beta/second',
          benchSlug: 'beta-second',
          active: true,
          quality: { coding: 80 },
          source: 'test',
        },
      ],
    } satisfies BenchmarkStore);

    appendDecision(
      {
        dimension: 'implement',
        chosen: 'beta/second',
        reason: 'scored',
        confidence: 0.7,
        routedUp: false,
        routedDown: false,
        cause: 'heuristic',
        fallbackChain: ['beta/second'],
      },
      { registryId: 'beta/second', viaFallback: false, accumulatedCost: 0.01 },
    );
    appendMutationGateSignal({
      intentKey: '3:1:abc:0',
      served: 'gamma/gate',
      providerInvocation: 2,
      gateBlockedInvocation: 2,
      clearance: false,
      action: 'block',
    });

    await handlers.get('router-status')!('', ctx);

    const msg = messages[messages.length - 1] ?? '';
    expect(msg).toContain('→ beta/second');
    expect(msg).not.toContain('gamma/gate');
  });
});

describe('/router-report', () => {
  it('warns when no decisions have been recorded yet', async () => {
    const { pi, handlers } = fakePi();
    registerCommands(pi);
    const { ctx, messages } = fakeCtx();

    await handlers.get('router-report')!('', ctx);

    expect(messages.at(-1)).toContain('No routing decisions recorded');
  });

  it('prints routed vs baseline spend, percent saved, and a dimension histogram', async () => {
    const { pi, handlers } = fakePi();
    registerCommands(pi);
    const { ctx, messages } = fakeCtx();

    const base: RoutingDecision = {
      dimension: 'implement',
      chosen: 'beta/cheap',
      reason: 'scored',
      confidence: 0.8,
      routedUp: false,
      routedDown: false,
      cause: 'heuristic',
      fallbackChain: ['beta/cheap'],
      baseline: { registryId: 'alpha/strong', source: 'auto', cost: { input: 10, output: 50 } },
      spend: { routedCost: 0.2, baselineCost: 2.0 },
    };
    appendDecision(base, { registryId: 'beta/cheap', viaFallback: false, accumulatedCost: 0.2 });
    appendDecision(
      { ...base, dimension: 'gather', spend: { routedCost: 0.1, baselineCost: 1.0 } },
      { registryId: 'beta/cheap', viaFallback: false, accumulatedCost: 0.3 },
    );

    await handlers.get('router-report')!('', ctx);

    const msg = messages.at(-1) ?? '';
    expect(msg).toContain('Routed spend: $0.3000 across 2/2 priced turns');
    expect(msg).toContain('Baseline spend (alpha/strong): $3.0000');
    expect(msg).toContain('Saved: $2.7000 (90.0%)');
    expect(msg).toContain('implement   1');
    expect(msg).toContain('gather      1');
  });

  it('flags baseline drift when the counterfactual baseline changed mid-session', async () => {
    const { pi, handlers } = fakePi();
    registerCommands(pi);
    const { ctx, messages } = fakeCtx();

    const base: RoutingDecision = {
      dimension: 'implement',
      chosen: 'beta/cheap',
      reason: 'scored',
      confidence: 0.8,
      routedUp: false,
      routedDown: false,
      cause: 'heuristic',
      fallbackChain: ['beta/cheap'],
      baseline: { registryId: 'alpha/strong', source: 'auto', cost: { input: 10, output: 50 } },
      spend: { routedCost: 0.2, baselineCost: 2.0 },
    };
    appendDecision(base, { registryId: 'beta/cheap', viaFallback: false, accumulatedCost: 0.2 });
    appendDecision(
      {
        ...base,
        baseline: { registryId: 'gamma/other', source: 'auto', cost: { input: 5, output: 25 } },
        spend: { routedCost: 0.1, baselineCost: 1.0 },
      },
      { registryId: 'beta/cheap', viaFallback: false, accumulatedCost: 0.3 },
    );

    await handlers.get('router-report')!('', ctx);

    expect(messages.at(-1)).toContain('baseline changed mid-session');
  });

  it('folds foreground subagent spend into the totals as its own line', async () => {
    const { pi, handlers } = fakePi();
    registerCommands(pi);
    const { ctx, messages } = fakeCtx();

    appendDecision(
      {
        dimension: 'implement',
        chosen: 'beta/cheap',
        reason: 'scored',
        confidence: 0.8,
        routedUp: false,
        routedDown: false,
        cause: 'heuristic',
        fallbackChain: ['beta/cheap'],
        baseline: { registryId: 'alpha/strong', source: 'auto', cost: { input: 10, output: 50 } },
        spend: { routedCost: 0.2, baselineCost: 2.0 },
      },
      { registryId: 'beta/cheap', viaFallback: false, accumulatedCost: 0.2 },
    );
    appendSubagentSpend({
      role: 'worker',
      model: 'beta/cheap',
      routerOwned: true,
      usage: { inputTokens: 100, outputTokens: 20, cacheRead: 0, cacheWrite: 0 },
      routedCost: 0.3,
      baselineModel: 'alpha/strong',
      baselineSource: 'auto',
      baselineCost: 3.0,
    });

    await handlers.get('router-report')!('', ctx);

    const msg = messages.at(-1) ?? '';
    expect(msg).toContain('Routed spend: $0.5000');
    expect(msg).toContain('incl. subagents: $0.3000 across 1 foreground children');
    expect(msg).toContain('Baseline spend (alpha/strong): $5.0000');
    // The child is not a turn: it must not enter the turn count or histogram.
    expect(msg).toContain('across 1/1 priced turns');
    expect(msg).not.toContain('worker');
  });

  it('excludes turns with no resolved baseline from the spend totals', async () => {
    const { pi, handlers } = fakePi();
    registerCommands(pi);
    const { ctx, messages } = fakeCtx();

    const priced: RoutingDecision = {
      dimension: 'implement',
      chosen: 'beta/cheap',
      reason: 'scored',
      confidence: 0.8,
      routedUp: false,
      routedDown: false,
      cause: 'heuristic',
      fallbackChain: ['beta/cheap'],
      baseline: { registryId: 'alpha/strong', source: 'auto', cost: { input: 10, output: 50 } },
      spend: { routedCost: 0.2, baselineCost: 2.0 },
    };
    const unpriced: RoutingDecision = { ...priced, spend: undefined, baseline: undefined };
    appendDecision(priced, { registryId: 'beta/cheap', viaFallback: false, accumulatedCost: 0.2 });
    appendDecision(unpriced, { registryId: 'beta/cheap', viaFallback: false, accumulatedCost: 0.3 });

    await handlers.get('router-report')!('', ctx);

    const msg = messages.at(-1) ?? '';
    expect(msg).toContain('across 1/2 priced turns');
  });
});

describe('command fail-open boundary', () => {
  it('reports an async syncBenchmarks failure instead of rejecting', async () => {
    const { pi, handlers } = fakePi();
    registerCommands(pi);
    const { ctx, messages } = fakeCtx();
    vi.spyOn(await import('../bench/sync.js'), 'syncBenchmarks').mockRejectedValue(new Error('sync failed'));

    await expect(handlers.get('router-sync')!('key', ctx)).resolves.toBeUndefined();

    expect(messages.some((m) => /router-sync.*sync failed/i.test(m))).toBe(true);
  });

  it('reports a synchronous saveStore failure instead of throwing', async () => {
    const { pi, handlers } = fakePi();
    registerCommands(pi);
    const { ctx, messages } = fakeCtx();
    saveStore(emptyStore());
    vi.spyOn(await import('../bench/store.js'), 'saveStore').mockImplementation(() => {
      throw new Error('disk full');
    });

    await expect(handlers.get('router-fix')!('slug provider/id', ctx)).resolves.toBeUndefined();

    expect(messages.some((m) => /router-fix.*disk full/i.test(m))).toBe(true);
  });

  it('resolves without throwing even when notify itself throws', async () => {
    const { pi, handlers } = fakePi();
    registerCommands(pi);
    const ctx = {
      ui: {
        notify: () => {
          throw new Error('notify broken');
        },
      },
      modelRegistry: { getAvailable: () => [] },
    } as unknown;

    await expect(handlers.get('router-why')!('', ctx)).resolves.toBeUndefined();
  });
});

describe('/router-escalate', () => {
  const decision = (overrides: Partial<RoutingDecision> = {}): RoutingDecision => ({
    dimension: 'gather',
    chosen: 'test/current',
    reason: 'r',
    confidence: 1,
    routedUp: false,
    routedDown: false,
    cause: 'heuristic',
    fallbackChain: ['test/current', 'test/other'],
    ...overrides,
  });

  beforeEach(() => {
    resetRouterSession();
    resetEscalation();
  });

  it('records a no-arg escalation and queues exactly one hidden follow-up', async () => {
    const { pi, handlers, sendMessage } = fakePi();
    registerCommands(pi);
    const { ctx } = fakeCtx();
    setLastDecision(decision());

    await handlers.get('router-escalate')!('', ctx);

    expect(peekPendingUserEscalation()).toEqual({
      target: undefined,
      fromModel: 'test/current',
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: 'pi8:handoff',
        display: false,
        details: expect.objectContaining({ kind: 'user-escalation' }),
      }),
      { triggerTurn: true, deliverAs: 'followUp' },
    );
  });

  it('records an explicit target dimension', async () => {
    const { pi, handlers } = fakePi();
    registerCommands(pi);
    const { ctx } = fakeCtx();
    setLastDecision(decision());

    await handlers.get('router-escalate')!('plan', ctx);

    expect(peekPendingUserEscalation()?.target).toBe('plan');
  });

  it('accepts an equal target for a same-dimension quality repick', async () => {
    const { pi, handlers, sendMessage } = fakePi();
    registerCommands(pi);
    const { ctx } = fakeCtx();
    setLastDecision(decision({ dimension: 'plan' }));

    await handlers.get('router-escalate')!('plan', ctx);

    expect(peekPendingUserEscalation()?.target).toBe('plan');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it.each(['lightweight', 'nonsense', 'plan extra'])(
    'rejects invalid argument %j without mutating state',
    async (args) => {
      const { pi, handlers, sendMessage } = fakePi();
      registerCommands(pi);
      const { ctx, messages } = fakeCtx();
      setLastDecision(decision());

      await handlers.get('router-escalate')!(args, ctx);

      expect(peekPendingUserEscalation()).toBeUndefined();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(messages.join('\n')).toContain('Usage');
    },
  );

  it('rejects a target weaker than the last routed dimension', async () => {
    const { pi, handlers, sendMessage } = fakePi();
    registerCommands(pi);
    const { ctx, messages } = fakeCtx();
    setLastDecision(decision({ dimension: 'review' }));

    await handlers.get('router-escalate')!('gather', ctx);

    expect(peekPendingUserEscalation()).toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(messages.join('\n')).toMatch(/weaker|already/i);
  });

  it('reports nothing to escalate when no decision was routed yet', async () => {
    const { pi, handlers, sendMessage } = fakePi();
    registerCommands(pi);
    const { ctx, messages } = fakeCtx();

    await handlers.get('router-escalate')!('', ctx);

    expect(peekPendingUserEscalation()).toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(messages.join('\n')).toContain('Nothing to escalate yet');
  });

  it('is inert when the session model is not router/auto', async () => {
    const { pi, handlers, sendMessage } = fakePi();
    registerCommands(pi);
    const { ctx } = fakeCtx([], { model: { provider: 'github-copilot', id: 'gpt-5.4' } });
    setLastDecision(decision());

    await handlers.get('router-escalate')!('', ctx);

    expect(peekPendingUserEscalation()).toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('prefers the served model over the chosen model as the escape source', async () => {
    const { pi, handlers } = fakePi();
    registerCommands(pi);
    const { ctx } = fakeCtx();
    setLastDecision(decision());
    setLastServed({ registryId: 'test/actually-served' } as never);

    await handlers.get('router-escalate')!('', ctx);

    expect(peekPendingUserEscalation()?.fromModel).toBe('test/actually-served');
  });

  it('clears an active model escalation override so the user request supersedes it', async () => {
    const { pi, handlers } = fakePi();
    registerCommands(pi);
    const { ctx } = fakeCtx();
    setLastDecision(decision());
    requestEscalation('review', 'model asked', 4);

    await handlers.get('router-escalate')!('plan', ctx);

    expect(applyEscalation('gather')).toBeUndefined();
  });

  it('stays fail-open when the follow-up message cannot be delivered', async () => {
    const { pi, handlers } = fakePi();
    (pi as unknown as { sendMessage: () => Promise<void> }).sendMessage = async () => {
      throw new Error('no transport');
    };
    registerCommands(pi);
    const { ctx, messages } = fakeCtx();
    setLastDecision(decision());

    await expect(handlers.get('router-escalate')!('', ctx)).resolves.toBeUndefined();
    expect(messages.join('\n')).toContain('/router-escalate');
  });
});
