import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { RegistryModelInfo } from './routing/score/scorer.js';
import { AUTO_MODEL_ID, ROUTER_PROVIDER_ID, type Role } from './types.js';

import { CONTRACT_NUDGE } from './serve/execution-contract-tool.js';
import autoModelRouterExtension from './index.js';
import { registerCommands } from './host/commands.js';
import { buildSubagentProviderAuthFilter } from './serve/provider.js';
import { computeRoleModels } from './agents/subagents.js';
import { multiWorkRoutingMeta, routingDecision, terminalAssessment } from './test-support/router-fixtures.js';
import { formatDecisionDetail } from './host/ui.js';
import { DECISION_LOG_FILE, setDecisionLogBase } from './host/decisionlog.js';
import { defaultRouterSession } from './serve/router-session-state.js';
import type { WorkPhaseState } from './routing/policy/work-phase.js';
import { evaluateMutationCall } from './routing/policy/mutation-gate.js';

vi.mock('./host/commands.js', () => ({ registerCommands: vi.fn(() => vi.fn()) }));
vi.mock('./routing/policy/mutation-gate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./routing/policy/mutation-gate.js')>();
  return { ...actual, evaluateMutationCall: vi.fn(actual.evaluateMutationCall) };
});
vi.mock('./serve/provider.js', () => ({
  registerAutoRouterProvider: vi.fn(),
  buildSubagentProviderAuthFilter: vi.fn(() => () => true),
  getBlacklistDebugState: vi.fn(() => ({ instance: 'test' })),
}));
vi.mock('./bench/store.js', () => ({
  loadStore: vi.fn(() => undefined),
  // The real decisionlog module resolves its log path through this; without it
  // gate-observability writes throw inside their fail-open catch and never land.
  resolveStoragePath: (base?: string) => base ?? '/tmp/pi8-test-store',
}));
vi.mock('./config.js', () => ({ loadConfig: vi.fn(() => ({ debug: false })) }));
vi.mock('./routing/policy/allowlist.js', () => ({
  loadModelFilter: vi.fn(() => () => true),
  buildExcludeFilter: vi.fn(() => () => false),
  buildScopedModelFilter: vi.fn(() => () => true),
}));
const mockRoleModels = new Map<Role, string>([
  ['worker', 'alpha/cheap'],
  ['reviewer', 'gamma/moderate'],
]);
const mockRoleFallbacks = new Map<Role, string[]>([
  ['worker', ['alpha/cheap', 'beta/strong']],
  ['reviewer', ['gamma/moderate', 'delta/strong']],
]);

vi.mock('./agents/subagents.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agents/subagents.js')>();
  return {
    ...actual,
    computeRoleModels: vi.fn(() => ({
      assignments: [],
      roleModels: new Map(mockRoleModels),
      roleFallbacks: new Map(mockRoleFallbacks),
    })),
  };
});

function registryModel(registryId: string): RegistryModelInfo {
  const [provider, id] = registryId.split('/');
  return {
    provider,
    id,
    contextWindow: 128000,
    maxTokens: 8192,
    input: ['text'],
    cost: { input: 1, output: 3 },
  };
}

function contextWithRegistry(
  models: RegistryModelInfo[],
  model?: { provider: string; id: string },
  cwd?: string,
): ExtensionContext {
  return {
    modelRegistry: { getAvailable: () => models as unknown as unknown[] },
    sessionManager: { getSessionFile: () => undefined },
    model,
    cwd,
  } as unknown as ExtensionContext;
}

describe('session lifecycle', () => {

describe('registry-only role routing', () => {
  it('assigns a concrete model to a worker subagent when the benchmark store is absent', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const pi = {
      on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
      registerTool: vi.fn(),
    } as unknown as ExtensionAPI;
    await autoModelRouterExtension(pi);

    const sessionStart = handlers.get('session_start');
    const toolCall = handlers.get('tool_call');
    expect(sessionStart).toBeDefined();
    expect(toolCall).toBeDefined();

    const models = [registryModel('alpha/cheap'), registryModel('beta/strong')];
    const ctx = contextWithRegistry(models, { provider: ROUTER_PROVIDER_ID, id: AUTO_MODEL_ID });
    await sessionStart!({ reason: 'new' }, ctx);
    const completionUpdater = vi.mocked(registerCommands).mock.results.at(-1)?.value;
    expect(completionUpdater).toHaveBeenCalledWith(ctx);

    const input: { agent: string; task: string; model?: string } = {
      agent: 'worker',
      task: 'implement the change',
    };
    toolCall!({ toolName: 'subagent', toolCallId: 'call-1', input }, ctx);

    expect(input.model).toBe('alpha/cheap');
  });

  it('fills the tool-level model on workflowScript spawns when the session is router/auto', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const pi = {
      on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
      registerTool: vi.fn(),
    } as unknown as ExtensionAPI;
    await autoModelRouterExtension(pi);

    const sessionStart = handlers.get('session_start');
    const toolCall = handlers.get('tool_call');

    const models = [registryModel('alpha/cheap'), registryModel('beta/strong')];
    const ctx = contextWithRegistry(models, { provider: ROUTER_PROVIDER_ID, id: AUTO_MODEL_ID });
    await sessionStart!({ reason: 'new' }, ctx);

    // Children defined inside a workflowScript string are invisible to the
    // structured spec walker; the tool schema's top-level `model` slot is the
    // one lever that still governs them, filled from the worker pick.
    const input: { workflowScript: string; model?: string } = {
      workflowScript: "runs.run('k', { agent: 'scout', task: 'recon' })",
    };
    toolCall!({ toolName: 'subagent', toolCallId: 'call-wf', input }, ctx);

    expect(input.model).toBe('alpha/cheap');
  });

  it('is completely inert for a subagent spawn when no ctx/model is available (matches a session that never opted into router/auto)', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const pi = {
      on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
      registerTool: vi.fn(),
    } as unknown as ExtensionAPI;
    await autoModelRouterExtension(pi);

    const sessionStart = handlers.get('session_start');
    const toolCall = handlers.get('tool_call');

    const models = [registryModel('alpha/cheap'), registryModel('beta/strong')];
    await sessionStart!({ reason: 'new' }, contextWithRegistry(models));

    const input: { agent: string; task: string; model?: string } = {
      agent: 'worker',
      task: 'implement the change',
    };
    // No ctx passed at all — pi-subagents' own default selection must be left
    // completely untouched.
    toolCall!({ toolName: 'subagent', toolCallId: 'call-1b', input });

    expect(input.model).toBeUndefined();
  });

  it('leaves an omitted subagent model untouched when the parent session is on a concrete (non-router) model', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const pi = {
      on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
      registerTool: vi.fn(),
    } as unknown as ExtensionAPI;
    await autoModelRouterExtension(pi);

    const sessionStart = handlers.get('session_start');
    const toolCall = handlers.get('tool_call');

    const models = [registryModel('alpha/cheap'), registryModel('beta/strong')];
    const ctx = contextWithRegistry(models, { provider: 'github-copilot', id: 'gpt-5.4' });
    await sessionStart!({ reason: 'new' }, ctx);

    const input: { agent: string; task: string; model?: string } = {
      agent: 'worker',
      task: 'implement the change',
    };
    toolCall!({ toolName: 'subagent', toolCallId: 'call-1c', input }, ctx);

    // pi behaves normally: this extension never patched the omitted model, so
    // pi-subagents' own default selection applies.
    expect(input.model).toBeUndefined();
  });

  it('threads ctx (cwd) through to computeRoleModels so project-scoped subagent pins are discovered', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const pi = {
      on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
      registerTool: vi.fn(),
    } as unknown as ExtensionAPI;
    await autoModelRouterExtension(pi);

    const sessionStart = handlers.get('session_start');
    const models = [registryModel('alpha/cheap'), registryModel('beta/strong')];
    const ctx = contextWithRegistry(
      models,
      { provider: ROUTER_PROVIDER_ID, id: AUTO_MODEL_ID },
      '/workspace/some-project',
    );
    await sessionStart!({ reason: 'new' }, ctx);

    // computeRoleModels must receive the live ctx so subagents.ts can resolve
    // .pi/settings.json under ctx.cwd — without this, project-scoped pins
    // silently lose to router injection at spawn time even though the
    // project-pin-discovery mechanism in subagents.ts is fully implemented.
    expect(computeRoleModels).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ctx: expect.objectContaining({ cwd: '/workspace/some-project' }) }),
    );
  });

  describe('auth sweep gating (pi#7508 amplification)', () => {
    const authFilter = vi.mocked(buildSubagentProviderAuthFilter);
    const calls = () => authFilter.mock.calls.length;
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const offline = process.env.PI_OFFLINE;
    afterEach(() => {
      if (offline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = offline;
    });

    it('skips the credential sweep at session_start when the session is on a concrete model', async () => {
      const handlers = new Map<string, (...args: any[]) => unknown>();
      const pi = {
        on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
        registerTool: vi.fn(),
      } as unknown as ExtensionAPI;
      await autoModelRouterExtension(pi);

      const before = calls();
      const sessionStart = handlers.get('session_start');
      const ctx = contextWithRegistry([registryModel('alpha/cheap')], {
        provider: 'github-copilot',
        id: 'gpt-5.4',
      });
      await sessionStart!({ reason: 'new' }, ctx);

      // A concrete-model session must not probe credentials: the
      // sweep can trigger an OAuth token refresh under Pi's credential-store
      // lock (pi#7508) even when the router is inert.
      expect(calls()).toBe(before);
    });

    it('skips the credential sweep at session_start in offline mode even when router/auto is active', async () => {
      process.env.PI_OFFLINE = '1';
      const handlers = new Map<string, (...args: any[]) => unknown>();
      const pi = {
        on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
        registerTool: vi.fn(),
      } as unknown as ExtensionAPI;
      await autoModelRouterExtension(pi);

      const before = calls();
      const sessionStart = handlers.get('session_start');
      const ctx = contextWithRegistry([registryModel('alpha/cheap')], {
        provider: ROUTER_PROVIDER_ID,
        id: AUTO_MODEL_ID,
      });
      await sessionStart!({ reason: 'new' }, ctx);

      expect(calls()).toBe(before);
    });

    it('re-arms the credential sweep when the user switches TO router/auto', async () => {
      const handlers = new Map<string, (...args: any[]) => unknown>();
      const pi = {
        on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
        registerTool: vi.fn(),
      } as unknown as ExtensionAPI;
      await autoModelRouterExtension(pi);

      const before = calls();
      const modelSelect = handlers.get('model_select');
      const ctx = contextWithRegistry([registryModel('alpha/cheap')], {
        provider: 'github-copilot',
        id: 'gpt-5.4',
      });
      modelSelect!({ model: { provider: ROUTER_PROVIDER_ID, id: AUTO_MODEL_ID } }, ctx);
      await tick();

      // The session_start gate skipped the sweep; switching into the router
      // must re-arm it so subagent role routing is populated mid-session.
      expect(calls()).toBe(before + 1);
    });

    it('does not sweep when a model_select lands on a concrete model', async () => {
      const handlers = new Map<string, (...args: any[]) => unknown>();
      const pi = {
        on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
        registerTool: vi.fn(),
      } as unknown as ExtensionAPI;
      await autoModelRouterExtension(pi);

      const before = calls();
      const modelSelect = handlers.get('model_select');
      modelSelect!(
        { model: { provider: 'github-copilot', id: 'gpt-5.4' } },
        contextWithRegistry([registryModel('alpha/cheap')]),
      );
      await tick();

      expect(calls()).toBe(before);
    });

    it('forgets the synced thinking level only when switching TO router/auto', async () => {
      const handlers = new Map<string, (...args: any[]) => unknown>();
      const pi = {
        on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
        registerTool: vi.fn(),
      } as unknown as ExtensionAPI;
      await autoModelRouterExtension(pi);
      const modelSelect = handlers.get('model_select')!;
      const ctx = contextWithRegistry([registryModel('alpha/cheap')]);
      defaultRouterSession.setSyncedThinkingLevel('high');

      modelSelect({ model: { provider: 'github-copilot', id: 'gpt-5.4' } }, ctx);
      expect(defaultRouterSession.getSyncedThinkingLevel()).toBe('high');

      // The level Pi applies during the switch is not a user choice.
      modelSelect({ model: { provider: ROUTER_PROVIDER_ID, id: AUTO_MODEL_ID } }, ctx);
      expect(defaultRouterSession.getSyncedThinkingLevel()).toBeUndefined();
    });
  });

  it('preserves an explicit concrete child model under a router/auto parent', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const pi = {
      on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
      registerTool: vi.fn(),
    } as unknown as ExtensionAPI;
    await autoModelRouterExtension(pi);

    const sessionStart = handlers.get('session_start');
    const toolCall = handlers.get('tool_call');
    expect(sessionStart).toBeDefined();
    expect(toolCall).toBeDefined();

    const models = [registryModel('alpha/cheap'), registryModel('beta/strong')];
    const ctx = contextWithRegistry(models, { provider: ROUTER_PROVIDER_ID, id: AUTO_MODEL_ID });
    await sessionStart!({ reason: 'new' }, ctx);

    const input: { agent: string; task: string; model?: string } = {
      agent: 'worker',
      model: 'github-copilot/claude-sonnet-4.6',
      task: 'implement the change',
    };
    toolCall!({ toolName: 'subagent', toolCallId: 'call-2', input }, ctx);

    // Explicit concrete model is preserved — explicit choices always win.
    expect(input.model).toBe('github-copilot/claude-sonnet-4.6');
  });

  it('injects a routed model for the router/auto sentinel', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const pi = {
      on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
      registerTool: vi.fn(),
    } as unknown as ExtensionAPI;
    await autoModelRouterExtension(pi);

    const sessionStart = handlers.get('session_start');
    const toolCall = handlers.get('tool_call');

    const models = [registryModel('alpha/cheap'), registryModel('beta/strong')];
    const ctx = contextWithRegistry(models, { provider: ROUTER_PROVIDER_ID, id: AUTO_MODEL_ID });
    await sessionStart!({ reason: 'new' }, ctx);

    const input: { agent: string; task: string; model?: string } = {
      agent: 'worker',
      model: 'router/auto',
      task: 'implement the change',
    };
    toolCall!({ toolName: 'subagent', toolCallId: 'call-3', input }, ctx);

    // Sentinel is treated as router-owned and resolved to a concrete model.
    expect(input.model).not.toBe('router/auto');
    expect(input.model).toMatch(/^(alpha|beta)\//);
  });

  it('leaves an explicit child model unchanged when the parent session is not router/auto', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const pi = {
      on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
      registerTool: vi.fn(),
    } as unknown as ExtensionAPI;
    await autoModelRouterExtension(pi);

    const sessionStart = handlers.get('session_start');
    const toolCall = handlers.get('tool_call');

    const models = [registryModel('alpha/cheap'), registryModel('beta/strong')];
    const ctx = contextWithRegistry(models, { provider: 'github-copilot', id: 'gpt-5.4' });
    await sessionStart!({ reason: 'new' }, ctx);

    const input: { agent: string; task: string; model?: string } = {
      agent: 'worker',
      model: 'github-copilot/claude-sonnet-4.6',
      task: 'implement the change',
    };
    toolCall!({ toolName: 'subagent', toolCallId: 'call-4', input }, ctx);

    expect(input.model).toBe('github-copilot/claude-sonnet-4.6');
  });
});

describe('region-restricted parallel reviewers', () => {
  it('injects routed models and leaves a child failure fail-open (no retry, no blacklist)', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const pi = {
      on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
      registerTool: vi.fn(),
    } as unknown as ExtensionAPI;
    await autoModelRouterExtension(pi);

    const sessionStart = handlers.get('session_start');
    const toolCall = handlers.get('tool_call');
    const toolResult = handlers.get('tool_result');
    expect(sessionStart).toBeDefined();
    expect(toolCall).toBeDefined();
    expect(toolResult).toBeDefined();

    const models = [registryModel('gamma/moderate'), registryModel('delta/strong')];
    const ctx = contextWithRegistry(models, { provider: ROUTER_PROVIDER_ID, id: AUTO_MODEL_ID });
    await sessionStart!({ reason: 'new' }, ctx);
    defaultRouterSession.clearSessionBlacklist();

    const input: {
      tasks: Array<{ agent: string; task: string; model?: string }>;
    } = {
      tasks: [
        { agent: 'reviewer', task: 'review routing' },
        { agent: 'reviewer', task: 'review routing' },
        { agent: 'reviewer', task: 'review manually', model: 'user/explicit' },
      ],
    };
    toolCall!({ toolName: 'subagent', toolCallId: 'call-region', input }, ctx);
    expect(input.tasks[0].model).toBe('gamma/moderate');
    expect(input.tasks[1].model).toBe('gamma/moderate');
    expect(input.tasks[2].model).toBe('user/explicit');

    // A child hard-failure no longer blacklists the model or appends a retry
    // directive: the router injects once and leaves recovery to the parent.
    const plan = (await toolResult!(
      {
        toolName: 'subagent',
        toolCallId: 'call-region',
        content: [],
        isError: false,
        details: {
          results: [
            {
              index: 0,
              agent: 'reviewer',
              model: 'gamma/moderate:high',
              exitCode: 1,
              error: 'region blocked',
              modelAttempts: [{ model: 'gamma/moderate:high', success: false }],
            },
            {
              index: 1,
              agent: 'reviewer',
              model: 'gamma/moderate:high',
              exitCode: 1,
              error: 'region blocked',
              modelAttempts: [{ model: 'gamma/moderate:high', success: false }],
            },
          ],
        },
      },
      {
        ...ctx,
        modelRegistry: { getAvailable: () => models as unknown as unknown[] },
      },
    )) as { content?: Array<{ type: string; text?: string }> } | undefined;

    expect(defaultRouterSession.getBlacklistedModels().size).toBe(0);
    expect(plan?.content).toBeUndefined();

    // The next spawn still routes to the same model — nothing was blacklisted.
    const retry: {
      tasks: Array<{ agent: string; task: string; model?: string }>;
    } = {
      tasks: [
        { agent: 'reviewer', task: 'review routing' },
        { agent: 'reviewer', task: 'review routing' },
      ],
    };
    toolCall!({ toolName: 'subagent', toolCallId: 'call-retry', input: retry }, ctx);
    expect(retry.tasks.map((task) => task.model)).toEqual(['gamma/moderate', 'gamma/moderate']);
    expect(input.tasks[2].model).toBe('user/explicit');
  });

  it('blacklists the whole provider when a child hits a usage limit', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const pi = {
      on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
      registerTool: vi.fn(),
    } as unknown as ExtensionAPI;
    await autoModelRouterExtension(pi);

    const sessionStart = handlers.get('session_start');
    const toolCall = handlers.get('tool_call');
    const toolResult = handlers.get('tool_result');

    const models = [registryModel('gamma/moderate'), registryModel('delta/strong')];
    const ctx = contextWithRegistry(models, { provider: ROUTER_PROVIDER_ID, id: AUTO_MODEL_ID });
    await sessionStart!({ reason: 'new' }, ctx);
    defaultRouterSession.clearSessionBlacklist();

    const input: { agent: string; task: string; model?: string } = { agent: 'reviewer', task: 'review routing' };
    toolCall!({ toolName: 'subagent', toolCallId: 'call-cap', input }, ctx);
    expect(input.model).toBe('gamma/moderate');

    const cap = '429 {"type":"GoUsageLimitError","message":"Weekly usage limit reached"}';
    await toolResult!(
      {
        toolName: 'subagent',
        toolCallId: 'call-cap',
        content: [],
        isError: false,
        details: {
          results: [
            {
              index: 0,
              agent: 'reviewer',
              model: 'gamma/moderate:high',
              exitCode: 1,
              error: cap,
              modelAttempts: [{ model: 'gamma/moderate:high', success: false, error: cap }],
            },
          ],
        },
      },
      { ...ctx, modelRegistry: { getAvailable: () => models as unknown as unknown[] } },
    );

    // A shared usage limit excludes the whole provider, not just one model.
    expect(defaultRouterSession.getBlacklistedProviders().has('gamma')).toBe(true);

    // The next spawn skips the capped provider and routes to the sibling.
    const retry: { agent: string; task: string; model?: string } = { agent: 'reviewer', task: 'review routing' };
    toolCall!({ toolName: 'subagent', toolCallId: 'call-cap-retry', input: retry }, ctx);
    expect(retry.model).toBe('delta/strong');
  });

  it('leaves a non-usage-limit child failure fail-open (no provider blacklist)', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const pi = {
      on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
      registerTool: vi.fn(),
    } as unknown as ExtensionAPI;
    await autoModelRouterExtension(pi);

    const sessionStart = handlers.get('session_start');
    const toolCall = handlers.get('tool_call');
    const toolResult = handlers.get('tool_result');

    const models = [registryModel('gamma/moderate'), registryModel('delta/strong')];
    const ctx = contextWithRegistry(models, { provider: ROUTER_PROVIDER_ID, id: AUTO_MODEL_ID });
    await sessionStart!({ reason: 'new' }, ctx);
    defaultRouterSession.clearSessionBlacklist();

    const input: { agent: string; task: string; model?: string } = { agent: 'reviewer', task: 'review routing' };
    toolCall!({ toolName: 'subagent', toolCallId: 'call-transient', input }, ctx);

    await toolResult!(
      {
        toolName: 'subagent',
        toolCallId: 'call-transient',
        content: [],
        isError: false,
        details: {
          results: [
            {
              index: 0,
              agent: 'reviewer',
              model: 'gamma/moderate:high',
              exitCode: 1,
              error: 'connection reset before headers',
              modelAttempts: [{ model: 'gamma/moderate:high', success: false, error: 'connection reset before headers' }],
            },
          ],
        },
      },
      { ...ctx, modelRegistry: { getAvailable: () => models as unknown as unknown[] } },
    );

    expect(defaultRouterSession.getBlacklistedProviders().has('gamma')).toBe(false);
    expect(defaultRouterSession.getBlacklistedModels().has('gamma/moderate')).toBe(false);
  });

  it('keeps async and unknown-span dynamic fanout failures fail-open', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const pi = {
      on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
      registerTool: vi.fn(),
    } as unknown as ExtensionAPI;
    await autoModelRouterExtension(pi);

    const sessionStart = handlers.get('session_start');
    const toolCall = handlers.get('tool_call');
    const toolResult = handlers.get('tool_result');

    const models = [registryModel('gamma/moderate'), registryModel('delta/strong')];
    const ctx = contextWithRegistry(models, { provider: ROUTER_PROVIDER_ID, id: AUTO_MODEL_ID });
    await sessionStart!({ reason: 'new' }, ctx);

    const asyncInput: { agent: string; task: string; async: boolean; model?: string } = {
      agent: 'reviewer',
      task: 'review in background',
      async: true,
    };
    toolCall!({ toolName: 'subagent', toolCallId: 'call-async', input: asyncInput }, ctx);
    expect(asyncInput.model).toBe('gamma/moderate');

    const dynamicInput: {
      chain: Array<{
        expand?: { from: { output: string; path: string } };
        parallel: { agent: string; task: string; model?: string };
      }>;
    } = {
      chain: [
        {
          expand: { from: { output: 'targets', path: '/items' } },
          parallel: { agent: 'reviewer', task: 'review each {item}' },
        },
      ],
    };
    toolCall!({ toolName: 'subagent', toolCallId: 'call-dynamic', input: dynamicInput }, ctx);
    expect(dynamicInput.chain[0].parallel.model).toBe('gamma/moderate');

    defaultRouterSession.clearSessionBlacklist();
    const asyncPlan = (await toolResult!(
      {
        toolName: 'subagent',
        toolCallId: 'call-async',
        content: [],
        isError: false,
        details: {
          results: [
            {
              index: 0,
              agent: 'reviewer',
              model: 'gamma/moderate:high',
              exitCode: 1,
              error: 'region blocked',
              modelAttempts: [{ model: 'gamma/moderate:high', success: false }],
            },
          ],
        },
      },
      ctx,
    )) as { content?: Array<{ type: string; text?: string }> };
    expect(defaultRouterSession.getBlacklistedModels().size).toBe(0);
    expect(asyncPlan?.content).toBeUndefined();

    const dynamicPlan = (await toolResult!(
      {
        toolName: 'subagent',
        toolCallId: 'call-dynamic',
        content: [],
        isError: false,
        details: {
          results: [
            {
              index: 0,
              agent: 'reviewer',
              model: 'gamma/moderate:high',
              exitCode: 1,
              error: 'region blocked',
              modelAttempts: [{ model: 'gamma/moderate:high', success: false }],
            },
          ],
        },
      },
      ctx,
    )) as { content?: Array<{ type: string; text?: string }> };
    expect(defaultRouterSession.getBlacklistedModels().size).toBe(0);
    expect(dynamicPlan?.content).toBeUndefined();
  });
});

});

describe('assessment lifecycle resets', () => {
  function makePi() {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const pi = {
      on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
      registerTool: vi.fn(),
    } as unknown as ExtensionAPI;
    return { handlers, pi };
  }

  afterEach(() => {
    defaultRouterSession.reset();
  });

  for (const reason of ['startup', 'resume', 'fork', 'new'] as const) {
    it(`clears assessment state on session_start(${reason})`, async () => {
      const { handlers, pi } = makePi();
      await autoModelRouterExtension(pi);

      defaultRouterSession.intent.bumpLatchGeneration();
      defaultRouterSession.assessment.addCost(0.05);
      defaultRouterSession.setActiveSkillNames(['writing-plans']);
      defaultRouterSession.intent.setCachedIntent({
        key: 'k',
        classifyResult: {
          dimension: 'gather',
          confidence: 0.8,
          signals: [],
          terminal: terminalAssessment(),
      hasCategoricalEvidence: true,
        },
        dimension: 'gather',
        cause: 'heuristic',
        thin: false,
        contextChars: 10,
      });

      const sessionStart = handlers.get('session_start');
      await sessionStart?.(
        { reason },
        {
          modelRegistry: {},
          sessionManager: { getSessionFile: () => undefined },
        } as unknown as ExtensionContext,
      );

      expect(defaultRouterSession.intent.getLatchGeneration()).toBe(0);
      expect(defaultRouterSession.assessment.getCost()).toBe(0);
      expect(defaultRouterSession.intent.getCachedIntent()).toBeUndefined();
    });
  }

  it('captures skill names only when the router is the active model', async () => {
    const { handlers, pi } = makePi();
    await autoModelRouterExtension(pi);

    const beforeAgentStart = handlers.get('before_agent_start');
    expect(beforeAgentStart).toBeDefined();

    // A concrete model must not update router skill state.
    defaultRouterSession.reset();
    beforeAgentStart?.(
      { systemPromptOptions: { skills: ['writing-plans', { name: 'context-mode' }] } },
      { model: { provider: 'openai-codex', id: 'gpt-5.3' } } as unknown as ExtensionContext,
    );
    expect(defaultRouterSession.getActiveSkillNames()).toEqual([]);

    // Router/auto model: names only, never descriptions or file contents.
    beforeAgentStart?.(
      {
        systemPromptOptions: {
          skills: ['writing-plans', { name: 'systematic-debugging' }, 42, ''],
        },
      },
      {
        model: { provider: ROUTER_PROVIDER_ID, id: AUTO_MODEL_ID },
      } as unknown as ExtensionContext,
    );
    expect(defaultRouterSession.getActiveSkillNames()).toEqual(['writing-plans', 'systematic-debugging']);
  });
});

describe('mutation gate hooks', () => {
  const concreteCtx = { model: { provider: 'openai-codex', id: 'gpt-5.3' } } as unknown as ExtensionContext;
  const routerAutoCtx = { model: { provider: ROUTER_PROVIDER_ID, id: AUTO_MODEL_ID } } as unknown as ExtensionContext;

  let logDir: string;

  beforeEach(() => {
    // Keep gate-observability writes out of the real user-scope decision log.
    logDir = mkdtempSync(join(tmpdir(), 'ar-index-log-'));
    setDecisionLogBase(logDir);
  });

  function inspectState(overrides: Partial<WorkPhaseState> = {}): WorkPhaseState {
    return {
      intentKey: 'intent-a',
      terminal: terminalAssessment(),
      terminalRequirement: 0.775,
      terminalBand: 'frontier',
      phase: 'inspect',
      phaseReason: 'explicit-compound-inspect',
      multiWorkEngaged: true,
      providerInvocation: 1,
      mutationGateBlocks: 0,
      mutationGateTriggered: false,
      mutationCompleted: false,
      pendingMutationToolCallIds: new Set(),
      observedReadTools: 0,
      observedMutationTools: 0,
      ...overrides,
    };
  }

  async function makeToolHandlers() {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const pi = {
      on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
      registerTool: vi.fn(),
    } as unknown as ExtensionAPI;
    await autoModelRouterExtension(pi);
    return handlers;
  }

  afterEach(() => {
    defaultRouterSession.reset();
    vi.mocked(evaluateMutationCall).mockRestore();
    setDecisionLogBase(undefined);
    rmSync(logDir, { recursive: true, force: true });
  });

  it('keeps concrete-model sessions a complete mutation-gate no-op', async () => {
    const handlers = await makeToolHandlers();
    const toolCall = handlers.get('tool_call')!;
    defaultRouterSession.intent.commitWorkPhaseState(inspectState());
    const before = defaultRouterSession.intent.getWorkPhaseState();
    expect(toolCall({ toolName: 'edit', toolCallId: 'e1', input: {} }, concreteCtx)).toBeUndefined();
    expect(defaultRouterSession.intent.getWorkPhaseState()).toEqual(before);
  });

  it('does not flush trajectory on turn_start when the session model is concrete', async () => {
    const handlers = await makeToolHandlers();
    const turnStart = handlers.get('turn_start')!;
    const flush = vi.spyOn(defaultRouterSession, 'flushAndArmUnresolvedTrajectory');
    const models = [registryModel('alpha/cheap')];
    await turnStart({}, contextWithRegistry(models, { provider: 'openai-codex', id: 'gpt-5.3' }));
    expect(flush).not.toHaveBeenCalled();
    flush.mockRestore();
  });

  it('flushes unresolved trajectory on turn_start when router/auto is active', async () => {
    const handlers = await makeToolHandlers();
    const turnStart = handlers.get('turn_start')!;
    const flush = vi.spyOn(defaultRouterSession, 'flushAndArmUnresolvedTrajectory');
    const models = [registryModel('alpha/cheap')];
    await turnStart({}, contextWithRegistry(models, { provider: ROUTER_PROVIDER_ID, id: AUTO_MODEL_ID }));
    expect(flush).toHaveBeenCalledTimes(1);
    flush.mockRestore();
  });

  it('returns a non-terminating intentional block for router/auto', async () => {
    const handlers = await makeToolHandlers();
    const toolCall = handlers.get('tool_call')!;
    defaultRouterSession.intent.commitWorkPhaseState(inspectState());
    defaultRouterSession.setLastServed({
      registryId: 'test/inspect',
      viaFallback: false,
      accumulatedCost: 0,
      capability: {
        providerInvocation: 1,
        terminalFloor: 0.85,
        terminalCapableInScoringSet: true,
        candidate: { clearsTerminalFloor: false, viaInspectPromotion: true },
      },
    });

    const result = await toolCall({ toolName: 'edit', toolCallId: 'e1', input: {} }, routerAutoCtx);
    expect(result).toEqual({ block: true, reason: expect.any(String) });
    expect(result).not.toHaveProperty('terminate');
  });

  it('shows editing as a phase without changing an unconfirmed plan task type', async () => {
    const handlers = await makeToolHandlers();
    const status = vi.fn();
    const ctx = { ...routerAutoCtx, ui: { setStatus: status } } as unknown as ExtensionContext;
    defaultRouterSession.intent.commitWorkPhaseState(inspectState({ phase: 'reason', multiWorkEngaged: false }));
    const decision = { ...routingDecision(['test/plan']), dimension: 'plan' as const, intentKey: 'intent-a' };
    defaultRouterSession.setLastDecision(decision);
    defaultRouterSession.setLastServed({ registryId: 'test/plan', viaFallback: false, accumulatedCost: 0 });

    await handlers.get('tool_call')!({ toolName: 'write', toolCallId: 'w1', input: { path: 'docs/notes.md' } }, ctx);

    expect(defaultRouterSession.getWorkPhaseState()?.observedMutationTools).toBe(1);
    expect(defaultRouterSession.getLastDecision()?.dimension).toBe('plan');
    expect(defaultRouterSession.getLastDecision()?.mutationObserved).toBe(true);
    expect(status).toHaveBeenCalledWith('router', expect.stringContaining('auto:plan · editing'));
  });

  it('registers commit_execution once and breaks its plan on an undeclared edit without blocking it', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const registerTool = vi.fn();
    await autoModelRouterExtension({
      on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
      registerTool,
    } as unknown as ExtensionAPI);
    expect(registerTool).toHaveBeenCalledTimes(1);
    const tool = registerTool.mock.calls[0]![0] as { name: string; execute: (...args: unknown[]) => Promise<{ details: { accepted: boolean } }> };
    expect(tool.name).toBe('commit_execution');

    const ctx = { ...routerAutoCtx, cwd: '/repo' } as unknown as ExtensionContext;
    defaultRouterSession.intent.commitWorkPhaseState(inspectState({ phase: 'reason', multiWorkEngaged: false }));
    defaultRouterSession.setLastDecision({ ...routingDecision(['test/plan']), dimension: 'plan' as const, intentKey: 'intent-a' });
    defaultRouterSession.setLastServed({ registryId: 'test/plan', viaFallback: false, accumulatedCost: 0 });
    const steps = [{ kind: 'edit', path: 'src/a.ts', change: 'reject expired tokens' }];
    const result = await tool.execute('c1', { steps }, undefined, undefined, ctx);
    expect(result.details.accepted).toBe(true);

    defaultRouterSession.setLastServed({ registryId: 'test/cheap', viaFallback: false, accumulatedCost: 0 });
    const toolCall = handlers.get('tool_call')!;
    expect(await toolCall({ toolName: 'edit', toolCallId: 'e1', input: { path: 'src/a.ts' } }, ctx)).toBeUndefined();
    expect(defaultRouterSession.getWorkPhaseState()?.contract?.status).toBe('active');
    expect(await toolCall({ toolName: 'edit', toolCallId: 'e2', input: { path: 'src/b.ts' } }, ctx)).toBeUndefined();
    expect(defaultRouterSession.getWorkPhaseState()?.contract)
      .toMatchObject({ status: 'broken', breakReason: 'undeclared-target', breaker: 'test/cheap' });
  });

  it('completes a plan from edit results and records the first verifier run of the review', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const registerTool = vi.fn();
    await autoModelRouterExtension({
      on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
      registerTool,
      exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false })),
    } as unknown as ExtensionAPI);
    const tool = registerTool.mock.calls[0]![0] as { execute: (...args: unknown[]) => Promise<{ details: { accepted: boolean } }> };
    const ctx = { ...routerAutoCtx, cwd: '/repo' } as unknown as ExtensionContext;
    defaultRouterSession.intent.commitWorkPhaseState(inspectState({ phase: 'reason', multiWorkEngaged: false }));
    defaultRouterSession.setLastDecision({ ...routingDecision(['test/plan']), dimension: 'plan' as const, intentKey: 'intent-a' });
    defaultRouterSession.setLastServed({ registryId: 'test/plan', viaFallback: false, accumulatedCost: 0 });
    const remainingWork = { openDecisions: 1, spread: 1, verification: 1, knowledge: 1, coupling: 1 };
    const steps = [{ kind: 'create', path: 'src/a.ts', change: 'add the helper' }];
    expect((await tool.execute('c1', { steps, remainingWork }, undefined, undefined, ctx)).details.accepted).toBe(true);

    defaultRouterSession.setLastServed({ registryId: 'test/cheap', viaFallback: false, accumulatedCost: 0 });
    const toolResult = handlers.get('tool_result')!;
    const content = [{ type: 'text', text: 'ok' }];
    await toolResult({ toolName: 'write', toolCallId: 'w1', input: { path: 'src/a.ts' }, content }, ctx);
    expect(defaultRouterSession.getWorkPhaseState()?.contract)
      .toMatchObject({ status: 'executed', executor: 'test/cheap', release: true });

    await toolResult({ toolName: 'bash', toolCallId: 'b1', input: { command: 'npm run test' }, content, isError: true }, ctx);
    expect(defaultRouterSession.getWorkPhaseState()?.contract?.reviewVerifier).toBe('fail');

    // The last entry of a session has no next entry: the settled run closes it.
    await handlers.get('agent_settled')!({ type: 'agent_settled' }, ctx);
    expect(defaultRouterSession.getWorkPhaseState()?.contract).toBeUndefined();
    const raw = readFileSync(join(logDir, DECISION_LOG_FILE), 'utf8');
    const outcomes = raw.trim().split('\n').map((line) => JSON.parse(line) as { executionContract?: { action: string } })
      .filter((record) => record.executionContract?.action === 'outcome');
    expect(outcomes.map((record) => record.executionContract)).toEqual([
      expect.objectContaining({ outcome: 'clean', meta: expect.objectContaining({ executor: 'test/cheap', reviewVerifier: 'fail' }) }),
    ]);
    expect(raw).not.toContain('src/a.ts');
    expect(raw).not.toContain('add the helper');
  });

  it('logs a rejected plan by code, never by its paths', async () => {
    const registerTool = vi.fn();
    await autoModelRouterExtension({ on: vi.fn(), registerTool, exec: vi.fn() } as unknown as ExtensionAPI);
    const tool = registerTool.mock.calls[0]![0] as { execute: (...args: unknown[]) => Promise<{ details: { accepted: boolean } }> };
    const ctx = { ...routerAutoCtx, cwd: '/repo' } as unknown as ExtensionContext;
    defaultRouterSession.intent.commitWorkPhaseState(inspectState({ phase: 'reason', multiWorkEngaged: false }));
    defaultRouterSession.setLastDecision({ ...routingDecision(['test/plan']), dimension: 'plan' as const, intentKey: 'intent-a' });
    defaultRouterSession.setLastServed({ registryId: 'test/plan', viaFallback: false, accumulatedCost: 0 });
    const steps = [{ kind: 'edit', path: 'secret-dir/*.ts', change: 'x' }];
    expect((await tool.execute('c1', { steps, remainingWork: {} }, undefined, undefined, ctx)).details.accepted).toBe(false);
    const raw = readFileSync(join(logDir, DECISION_LOG_FILE), 'utf8');
    expect(raw).toContain('"rejectReason":"pattern-path"');
    expect(raw).not.toContain('secret-dir');
  });

  it('appends the handoff reminder once to the first plan/review edit result without a plan', async () => {
    const handlers = await makeToolHandlers();
    const toolResult = handlers.get('tool_result')!;
    defaultRouterSession.intent.commitWorkPhaseState(inspectState({ phase: 'reason', multiWorkEngaged: false }));
    defaultRouterSession.setLastDecision({ ...routingDecision(['test/plan']), dimension: 'plan' as const, intentKey: 'intent-a' });
    defaultRouterSession.setLastServed({ registryId: 'test/plan', viaFallback: false, accumulatedCost: 0 });
    const content = [{ type: 'text', text: 'edited' }];

    expect(await toolResult({ toolName: 'read', toolCallId: 'r1', content }, routerAutoCtx)).toBeUndefined();
    const first = await toolResult({ toolName: 'edit', toolCallId: 'e1', content }, routerAutoCtx) as { content: Array<{ text: string }> };
    expect(first.content.map((c) => c.text)).toEqual(['edited', CONTRACT_NUDGE]);
    expect(await toolResult({ toolName: 'write', toolCallId: 'w1', content }, routerAutoCtx)).toBeUndefined();
    expect(await toolResult({ toolName: 'edit', toolCallId: 'e2', content }, concreteCtx)).toBeUndefined();
  });

  it('does not remind outside plan/review or for a plan-only deliverable', async () => {
    const handlers = await makeToolHandlers();
    const toolResult = handlers.get('tool_result')!;
    const content = [{ type: 'text', text: 'edited' }];
    defaultRouterSession.intent.commitWorkPhaseState(inspectState({ phase: 'mutate', multiWorkEngaged: false }));
    defaultRouterSession.setLastDecision({ ...routingDecision(['test/impl']), dimension: 'implement' as const, intentKey: 'intent-a' });
    expect(await toolResult({ toolName: 'edit', toolCallId: 'e1', content }, routerAutoCtx)).toBeUndefined();

    defaultRouterSession.setLastDecision({
      ...routingDecision(['test/plan']), dimension: 'plan' as const, intentKey: 'intent-a',
      assessment: { kind: 'plan', complexity: 'moderate', scope: 'bounded', compound: false, confidence: 'high', reasoning: 'plan', model: 'a/b', ms: 1, costUsd: 0, usage: { input: 0, output: 0 } },
    });
    expect(await toolResult({ toolName: 'edit', toolCallId: 'e2', content }, routerAutoCtx)).toBeUndefined();
  });

  it('projects the block onto the live decision so the commands can show it', async () => {
    const handlers = await makeToolHandlers();
    const toolCall = handlers.get('tool_call')!;
    defaultRouterSession.intent.commitWorkPhaseState(inspectState());
    defaultRouterSession.setLastServed({
      registryId: 'test/inspect',
      viaFallback: false,
      accumulatedCost: 0,
      capability: {
        providerInvocation: 1,
        terminalFloor: 0.85,
        terminalCapableInScoringSet: true,
        candidate: { clearsTerminalFloor: false, viaInspectPromotion: true },
      },
    });
    const decision = routingDecision(['test/inspect']);
    decision.multiWork = multiWorkRoutingMeta({ phase: 'inspect' });
    defaultRouterSession.setLastDecision(decision);

    await toolCall({ toolName: 'edit', toolCallId: 'e1', input: {} }, routerAutoCtx);

    expect(defaultRouterSession.getLastDecision()?.multiWork).toMatchObject({
      phase: 'mutate',
      phaseReason: 'gate-handoff',
      gateBlockedInvocation: 1,
    });
    expect(formatDecisionDetail(defaultRouterSession.getLastDecision(), undefined).join('\n')).toContain(
      'held at provider call 1 until a model strong enough for the final step serves',
    );
  });

  it('does not register a locally blocked mutation into the trajectory batch', async () => {
    const handlers = await makeToolHandlers();
    const toolCall = handlers.get('tool_call')!;
    defaultRouterSession.intent.commitWorkPhaseState(inspectState());
    defaultRouterSession.setLastServed({
      registryId: 'test/inspect',
      viaFallback: false,
      accumulatedCost: 0,
      capability: {
        providerInvocation: 1,
        terminalFloor: 0.85,
        terminalCapableInScoringSet: true,
        candidate: { clearsTerminalFloor: false, viaInspectPromotion: true },
      },
    });
    const note = vi.spyOn(defaultRouterSession, 'noteTrajectoryToolCall');

    const blocked = await toolCall({ toolName: 'edit', toolCallId: 'blocked', input: {} }, routerAutoCtx);
    expect(blocked).toEqual({ block: true, reason: expect.any(String) });
    expect(note).not.toHaveBeenCalled();

    await toolCall({ toolName: 'read', toolCallId: 'ok', input: { path: 'a.ts' } }, routerAutoCtx);
    expect(note).toHaveBeenCalledTimes(1);
    note.mockRestore();
  });

  it('projects the escape and its degradation onto the live decision', async () => {
    const handlers = await makeToolHandlers();
    const toolCall = handlers.get('tool_call')!;
    defaultRouterSession.intent.commitWorkPhaseState(inspectState({
      phase: 'mutate',
      mutationGateTriggered: true,
      mutationGateBlocks: 1,
      gateBlockedInvocation: 1,
    }));
    defaultRouterSession.setLastServed({
      registryId: 'test/inspect',
      viaFallback: false,
      accumulatedCost: 0,
      capability: {
        providerInvocation: 2,
        terminalFloor: 0.85,
        terminalCapableInScoringSet: true,
        candidate: { clearsTerminalFloor: false, viaInspectPromotion: true },
      },
    });
    const decision = routingDecision(['test/inspect']);
    decision.multiWork = multiWorkRoutingMeta({ phase: 'inspect' });
    defaultRouterSession.setLastDecision(decision);

    const result = await toolCall({ toolName: 'edit', toolCallId: 'e2', input: {} }, routerAutoCtx);

    expect(result).toBeUndefined();
    expect(defaultRouterSession.getLastDecision()?.multiWork).toMatchObject({
      mutationGateEscaped: true,
      capabilityDegraded: true,
    });
    expect(formatDecisionDetail(defaultRouterSession.getLastDecision(), undefined).join('\n')).toContain('then allowed without a strong enough model');
  });

  it('fails open without changing state when the gate throws', async () => {
    const handlers = await makeToolHandlers();
    const toolCall = handlers.get('tool_call')!;
    defaultRouterSession.intent.commitWorkPhaseState(inspectState());
    const before = defaultRouterSession.intent.getWorkPhaseState();
    vi.mocked(evaluateMutationCall).mockImplementationOnce(() => {
      throw new Error('boom');
    });

    const result = await toolCall({ toolName: 'edit', toolCallId: 'e1', input: {} }, routerAutoCtx);
    expect(result).toBeUndefined();
    expect(defaultRouterSession.intent.getWorkPhaseState()).toEqual(before);
  });

  it('correlates a mutation result back to its pending call', async () => {
    const handlers = await makeToolHandlers();
    const toolCall = handlers.get('tool_call')!;
    const toolResult = handlers.get('tool_result')!;
    defaultRouterSession.intent.commitWorkPhaseState(inspectState({ multiWorkEngaged: false, phase: 'mutate' }));

    await toolCall({ toolName: 'edit', toolCallId: 'e1', input: {} }, routerAutoCtx);
    expect(defaultRouterSession.intent.getWorkPhaseState()?.pendingMutationToolCallIds.has('e1')).toBe(true);

    await toolResult({ toolName: 'edit', toolCallId: 'e1', content: [], isError: false }, routerAutoCtx);
    expect(defaultRouterSession.intent.getWorkPhaseState()?.pendingMutationToolCallIds.has('e1')).toBe(false);
    expect(defaultRouterSession.intent.getWorkPhaseState()?.mutationCompleted).toBe(true);
  });

  it('gates a high-confidence mutating bash call for router/auto', async () => {
    const handlers = await makeToolHandlers();
    const toolCall = handlers.get('tool_call')!;
    defaultRouterSession.intent.commitWorkPhaseState(inspectState());
    defaultRouterSession.setLastServed({
      registryId: 'test/inspect',
      viaFallback: false,
      accumulatedCost: 0,
      capability: {
        providerInvocation: 1,
        terminalFloor: 0.85,
        terminalCapableInScoringSet: true,
        candidate: { clearsTerminalFloor: false, viaInspectPromotion: true },
      },
    });

    const result = await toolCall(
      { toolName: 'bash', toolCallId: 'bash-1', input: { command: 'echo x > out.txt' } },
      routerAutoCtx,
    );
    expect(result).toEqual({ block: true, reason: expect.any(String) });
    expect(defaultRouterSession.intent.getWorkPhaseState()).toMatchObject({ phase: 'mutate', mutationGateTriggered: true });
  });

  it('allows opaque python and read-only bash without state change', async () => {
    const handlers = await makeToolHandlers();
    const toolCall = handlers.get('tool_call')!;
    defaultRouterSession.intent.commitWorkPhaseState(inspectState());
    defaultRouterSession.setLastServed({
      registryId: 'test/inspect',
      viaFallback: false,
      accumulatedCost: 0,
      capability: {
        providerInvocation: 1,
        terminalFloor: 0.85,
        terminalCapableInScoringSet: true,
        candidate: { clearsTerminalFloor: false, viaInspectPromotion: true },
      },
    });

    expect(
      await toolCall({ toolName: 'bash', toolCallId: 'bash-2', input: { command: 'python script.py' } }, routerAutoCtx),
    ).toBeUndefined();
    expect(
      await toolCall({ toolName: 'bash', toolCallId: 'bash-3', input: { command: 'ls -la' } }, routerAutoCtx),
    ).toBeUndefined();
    expect(defaultRouterSession.intent.getWorkPhaseState()).toMatchObject({ phase: 'inspect', mutationGateBlocks: 0 });
    expect(defaultRouterSession.intent.getWorkPhaseState()?.pendingMutationToolCallIds.size).toBe(0);
  });

  it('records bash gate outcomes as enums only, never command text', async () => {
    const handlers = await makeToolHandlers();
    const toolCall = handlers.get('tool_call')!;
    defaultRouterSession.intent.commitWorkPhaseState(inspectState());
    defaultRouterSession.setLastServed({
      registryId: 'test/inspect',
      viaFallback: false,
      accumulatedCost: 0,
      capability: {
        providerInvocation: 1,
        terminalFloor: 0.85,
        terminalCapableInScoringSet: true,
        candidate: { clearsTerminalFloor: false, viaInspectPromotion: true },
      },
    });

    await toolCall(
      { toolName: 'bash', toolCallId: 'bash-1', input: { command: 'echo secret > out.txt' } },
      routerAutoCtx,
    );
    await toolCall(
      { toolName: 'bash', toolCallId: 'bash-2', input: { command: 'python script.py' } },
      routerAutoCtx,
    );

    const raw = readFileSync(join(logDir, DECISION_LOG_FILE), 'utf8');
    expect(raw).toContain('"mutationSignal":"shell-redirect"');
    expect(raw).toContain('"mutationSignal":"python-opaque"');
    expect(raw).not.toContain('out.txt');
    expect(raw).not.toContain('secret');
    expect(raw).not.toContain('script.py');
  });

  it('keeps concrete-model sessions a complete no-op for bash too', async () => {
    const handlers = await makeToolHandlers();
    const toolCall = handlers.get('tool_call')!;
    defaultRouterSession.intent.commitWorkPhaseState(inspectState());
    const before = defaultRouterSession.intent.getWorkPhaseState();
    expect(
      await toolCall({ toolName: 'bash', toolCallId: 'bash-1', input: { command: 'rm -rf x' } }, concreteCtx),
    ).toBeUndefined();
    expect(defaultRouterSession.intent.getWorkPhaseState()).toEqual(before);
  });
});
