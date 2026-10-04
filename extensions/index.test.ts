import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { RegistryModelInfo } from './routing/score/scorer.js';
import { AUTO_MODEL_ID, ROUTER_PROVIDER_ID, type Role, type RoutingDecision } from './types.js';

import { CONTRACT_GATE, CONTRACT_REMINDER } from './serve/execution-contract-tool.js';
import { CONTEXT_HANDOFF_REMINDER } from './serve/gathering-gate.js';
import autoModelRouterExtension from './index.js';
import { registerCommands } from './host/commands.js';
import { buildSubagentProviderAuthFilter } from './serve/provider.js';
import { computeRoleModels } from './agents/subagents.js';
import { routingDecision, terminalAssessment } from './test-support/router-fixtures.js';
import { DECISION_LOG_FILE, setDecisionLogBase } from './host/decisionlog.js';
import { defaultRouterSession } from './serve/router-session-state.js';
import type { WorkPhaseState } from './routing/policy/work-phase.js';
import { SessionTree } from './test-support/session-tree.js';
import { activateEvent, createEvent, workItem } from './test-support/context-fixtures.js';
import { CONTEXT_ENTRY_TYPE, SELECTION_ENTRY_TYPE, requestRouting } from './routing/context/persistence.js';

vi.mock('./host/commands.js', () => ({ registerCommands: vi.fn(() => vi.fn()) }));
vi.mock('./serve/provider.js', () => ({
  registerAutoRouterProvider: vi.fn(),
  buildSubagentProviderAuthFilter: vi.fn(() => () => true),
  getBlacklistDebugState: vi.fn(() => ({ instance: 'test' })),
}));
vi.mock('./bench/store.js', () => ({
  loadStore: vi.fn(() => undefined),
  // The real decisionlog module resolves its log path through this; without it
  // handoff-log writes throw inside their fail-open catch and never land.
  resolveStoragePath: (base?: string) => base ?? '/tmp/pi8-test-store',
}));
vi.mock('./config.js', () => ({
  loadConfig: vi.fn(() => ({ debug: false })),
}));
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

    it('restarts the credential sweep when the user switches TO router/auto', async () => {
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
      // must restart it so subagent role routing is populated mid-session.
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

describe('session lifecycle resets', () => {
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
    it(`clears session-scoped routing state on session_start(${reason})`, async () => {
      const { handlers, pi } = makePi();
      await autoModelRouterExtension(pi);

      defaultRouterSession.setActiveSkillNames(['writing-plans']);
      defaultRouterSession.intent.setCachedIntent({
        key: 'k',
        dimension: 'gather',
        cause: 'heuristic',
      });

      const sessionStart = handlers.get('session_start');
      await sessionStart?.(
        { reason },
        {
          modelRegistry: {},
          sessionManager: { getSessionFile: () => undefined },
        } as unknown as ExtensionContext,
      );

      expect(defaultRouterSession.getActiveSkillNames()).toEqual([]);
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

describe('work ledger lifecycle', () => {
  function makePi(tree: SessionTree) {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const appendEntry = vi.fn(tree.appendEntry);
    const pi = {
      on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
      registerTool: vi.fn(),
      appendEntry,
    } as unknown as ExtensionAPI;
    return { handlers, pi, appendEntry };
  }

  const ctxFor = (tree: SessionTree) => ({
    modelRegistry: {},
    sessionManager: tree.manager(),
  }) as unknown as ExtensionContext;

  afterEach(() => {
    defaultRouterSession.reset();
  });

  for (const reason of ['startup', 'reload', 'resume', 'fork'] as const) {
    it(`rebuilds the branch ledger on session_start(${reason})`, async () => {
      const tree = new SessionTree();
      const u = tree.user('implement the export');
      tree.event(createEvent(workItem('w_1', 't_1'), u));
      tree.event(activateEvent('w_1', u));
      const { handlers, pi } = makePi(tree);
      await autoModelRouterExtension(pi);

      await handlers.get('session_start')!({ reason }, ctxFor(tree));

      expect(defaultRouterSession.context.getBranchState()).toBe('tracked');
      expect(defaultRouterSession.context.getLedger().activeWorkItemId).toBe('w_1');
    });
  }

  it('loads a long pre-pi8 session as legacy without writing to it', async () => {
    const tree = new SessionTree();
    for (let i = 0; i < 50; i += 1) {
      tree.user(`request ${i}`);
      tree.assistant(`answer ${i}`);
    }
    const leaf = tree.getLeafId();
    const { handlers, pi, appendEntry } = makePi(tree);
    await autoModelRouterExtension(pi);

    await handlers.get('session_start')!({ reason: 'resume' }, ctxFor(tree));
    await handlers.get('session_start')!({ reason: 'reload' }, ctxFor(tree));
    await handlers.get('session_tree')!({ newLeafId: leaf, oldLeafId: leaf }, ctxFor(tree));

    expect(defaultRouterSession.context.getBranchState()).toBe('legacy-uninitialized');
    expect(appendEntry).not.toHaveBeenCalled();
    expect(tree.getLeafId()).toBe(leaf);
  });

  it('rebuilds from the new branch on session_tree', async () => {
    const tree = new SessionTree();
    const u1 = tree.user('first');
    tree.event(createEvent(workItem('w_1'), u1));
    const before = tree.getLeafId();
    const u2 = tree.user('second');
    tree.event(createEvent(workItem('w_2'), u2));
    const after = tree.getLeafId();
    const { handlers, pi } = makePi(tree);
    await autoModelRouterExtension(pi);
    await handlers.get('session_start')!({ reason: 'resume' }, ctxFor(tree));
    expect(defaultRouterSession.context.getLedger().items.size).toBe(2);

    tree.navigate(before);
    await handlers.get('session_tree')!({ newLeafId: before, oldLeafId: after }, ctxFor(tree));
    expect([...defaultRouterSession.context.getLedger().items.keys()]).toEqual(['w_1']);

    tree.navigate(after);
    await handlers.get('session_tree')!({ newLeafId: after, oldLeafId: before }, ctxFor(tree));
    expect(defaultRouterSession.context.getLedger().items.size).toBe(2);
  });

  it('keeps the entry state on session_tree only while its entry is on the branch', async () => {
    const tree = new SessionTree();
    const u1 = tree.user('plan the export', 100);
    tree.event(createEvent(workItem('w_1', 't_1', { lastDeliverable: 'plan' }), u1));
    tree.event(activateEvent('w_1', u1));
    const fork = tree.assistant('planned');
    tree.user('look up the export callers', 200);
    const leaf = tree.getLeafId();
    const { handlers, pi } = makePi(tree);
    await autoModelRouterExtension(pi);
    await handlers.get('session_start')!({ reason: 'resume' }, ctxFor(tree));
    const state: WorkPhaseState = {
      intentKey: '2:200:abcd',
      deliverable: 'gather',
      terminal: terminalAssessment({ kind: 'gather' }),
      terminalBand: 'standard',
      providerInvocation: 3,
      observedMutationTools: 1,
      contractStrikes: { 'beta/strong': 2 },
      excludedExecutors: ['beta/strong'],
      contextStatus: 'acquiring',
      workItemId: 'w_1',
    };
    defaultRouterSession.commitWorkPhaseState(state);

    await handlers.get('session_tree')!({ newLeafId: leaf, oldLeafId: leaf }, ctxFor(tree));
    expect(defaultRouterSession.getWorkPhaseState()).toBe(state);

    // Off the entry's branch, only what a thin continuation inherits stays,
    // raised to the restored active item's task type.
    tree.navigate(fork);
    await handlers.get('session_tree')!({ newLeafId: fork, oldLeafId: leaf }, ctxFor(tree));
    expect(defaultRouterSession.getWorkPhaseState()).toEqual({
      intentKey: '2:200:abcd',
      deliverable: 'plan',
      terminal: state.terminal,
      terminalBand: 'standard',
      providerInvocation: 3,
      observedMutationTools: 0,
    });
  });

  it('reads an untracked branch as legacy after a switch to router/auto, without writing to it', async () => {
    const tree = new SessionTree();
    tree.modelChange('openai', 'gpt-5');
    const { handlers, pi, appendEntry } = makePi(tree);
    await autoModelRouterExtension(pi);
    await handlers.get('session_start')!({ reason: 'new' }, ctxFor(tree));
    expect(defaultRouterSession.context.getBranchState()).toBe('native-empty');

    tree.user('refactor the cache');
    tree.assistant('done');
    tree.modelChange(ROUTER_PROVIDER_ID, AUTO_MODEL_ID);
    await handlers.get('model_select')!({ model: { provider: ROUTER_PROVIDER_ID, id: AUTO_MODEL_ID } }, ctxFor(tree));
    expect(defaultRouterSession.context.getBranchState()).toBe('legacy-uninitialized');
    expect(appendEntry).not.toHaveBeenCalled();
  });

  it('records the session model before a request only when the branch records another one', async () => {
    const tree = new SessionTree();
    tree.modelChange(ROUTER_PROVIDER_ID, AUTO_MODEL_ID);
    tree.user('implement the export');
    tree.assistant('done');
    const { handlers, pi, appendEntry } = makePi(tree);
    await autoModelRouterExtension(pi);
    const withModel = (provider: string, id: string) => ({ ...ctxFor(tree), model: { provider, id } }) as unknown as ExtensionContext;
    const prompt = { prompt: 'next', systemPromptOptions: {} };

    // Opening or navigating writes nothing.
    await handlers.get('session_start')!({ reason: 'resume' }, withModel('openai', 'gpt-5'));
    await handlers.get('session_tree')!({}, withModel('openai', 'gpt-5'));
    expect(appendEntry).not.toHaveBeenCalled();

    await handlers.get('before_agent_start')!(prompt, withModel(ROUTER_PROVIDER_ID, AUTO_MODEL_ID));
    expect(appendEntry).not.toHaveBeenCalled();

    // Resumed with --model: Pi records nothing, so the router records it before the request.
    await handlers.get('before_agent_start')!(prompt, withModel('openai', 'gpt-5'));
    expect(appendEntry).toHaveBeenCalledTimes(1);
    expect(appendEntry).toHaveBeenCalledWith(SELECTION_ENTRY_TYPE, { provider: 'openai', modelId: 'gpt-5' });
    await handlers.get('before_agent_start')!(prompt, withModel('openai', 'gpt-5'));
    expect(appendEntry).toHaveBeenCalledTimes(1);

    const concrete = tree.user('sent to gpt-5');
    expect(requestRouting(tree.getBranch()).unrouted.has(concrete)).toBe(true);
  });

  it('stops continuing the active item when router/auto returns after requests to another model', async () => {
    const tree = new SessionTree();
    tree.modelChange(ROUTER_PROVIDER_ID, AUTO_MODEL_ID);
    const u = tree.user('implement the export');
    tree.event(createEvent(workItem('w_1', 't_1'), u));
    tree.event(activateEvent('w_1', u));
    const { handlers, pi } = makePi(tree);
    await autoModelRouterExtension(pi);
    await handlers.get('session_start')!({ reason: 'resume' }, ctxFor(tree));
    expect(defaultRouterSession.context.getLedger().activeWorkItemId).toBe('w_1');

    tree.modelChange('openai', 'gpt-5');
    tree.user('fix the login page');
    tree.assistant('done');
    tree.modelChange(ROUTER_PROVIDER_ID, AUTO_MODEL_ID);
    await handlers.get('model_select')!({ model: { provider: ROUTER_PROVIDER_ID, id: AUTO_MODEL_ID } }, ctxFor(tree));
    expect(defaultRouterSession.context.getLedger().activeWorkItemId).toBeUndefined();
    expect(defaultRouterSession.context.getLedger().items.get('w_1')?.status).toBe('active');
  });

  it('ends the served model when Pi selects a concrete model, so it sets no minimum after router/auto returns', async () => {
    const tree = new SessionTree();
    tree.modelChange(ROUTER_PROVIDER_ID, AUTO_MODEL_ID);
    const { handlers, pi } = makePi(tree);
    await autoModelRouterExtension(pi);
    await handlers.get('session_start')!({ reason: 'new' }, ctxFor(tree));
    defaultRouterSession.setLastDecision(routingDecision(['alpha/strong:high']));
    defaultRouterSession.setLastServed({ registryId: 'alpha/strong', thinkingLevel: 'high', viaFallback: false, accumulatedCost: 0 });

    tree.modelChange('openai', 'gpt-5');
    await handlers.get('model_select')!({ model: { provider: 'openai', id: 'gpt-5' } }, ctxFor(tree));
    tree.modelChange(ROUTER_PROVIDER_ID, AUTO_MODEL_ID);
    await handlers.get('model_select')!({ model: { provider: ROUTER_PROVIDER_ID, id: AUTO_MODEL_ID } }, ctxFor(tree));
    defaultRouterSession.rotateServedForNewTurn();

    expect(defaultRouterSession.getPreviousServed()).toBeUndefined();
    expect(defaultRouterSession.getLastChosenRegistryId()).toBeUndefined();
  });

  it('keeps the ledger across compaction', async () => {
    const tree = new SessionTree();
    const u = tree.user('first');
    tree.event(createEvent(workItem('w_1'), u));
    const { handlers, pi } = makePi(tree);
    await autoModelRouterExtension(pi);
    await handlers.get('session_start')!({ reason: 'resume' }, ctxFor(tree));

    await handlers.get('session_compact')!({}, ctxFor(tree));
    expect(defaultRouterSession.context.getLedger().items.has('w_1')).toBe(true);
  });

  it('grounds an anchored file from a read result, only while router/auto serves', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi8-index-ground-'));
    try {
      writeFileSync(join(cwd, 'req.md'), 'spec\n');
      const tree = new SessionTree();
      const u = tree.user('@req.md implement this');
      tree.event(createEvent(workItem('w_1', 't_1', { anchors: [{ kind: 'path', value: 'req.md', source: 'user' }] }), u));
      tree.event(activateEvent('w_1', u));
      const { handlers, pi } = makePi(tree);
      await autoModelRouterExtension(pi);
      const base = { ...ctxFor(tree), cwd } as ExtensionContext;
      await handlers.get('session_start')!({ reason: 'resume' }, base);
      const read = { toolName: 'read', toolCallId: 'r1', input: { path: 'req.md' }, content: [{ type: 'text', text: 'spec\n' }] };

      await handlers.get('tool_result')!(read, { ...base, model: { provider: 'openai', id: 'gpt' } });
      expect(defaultRouterSession.context.getLedger().items.get('w_1')!.grounding).toEqual([]);

      await handlers.get('tool_result')!(read, { ...base, model: { provider: ROUTER_PROVIDER_ID, id: AUTO_MODEL_ID } });
      expect(defaultRouterSession.context.getLedger().items.get('w_1')!.grounding).toHaveLength(1);
      expect(tree.getBranch().at(-1)).toMatchObject({ customType: CONTEXT_ENTRY_TYPE, data: { op: 'grounding-upsert' } });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('registers lifecycle and metadata tools once and never changes the tool list afterwards', async () => {
    const tree = new SessionTree();
    const { handlers, pi } = makePi(tree);
    await autoModelRouterExtension(pi);
    const registerTool = vi.mocked(pi.registerTool);
    const names = () => registerTool.mock.calls.map(([tool]) => (tool as { name: string }).name);
    expect(names().filter((name) => name === 'routing_context')).toHaveLength(1);
    expect(names().filter((name) => name === 'complete_work')).toHaveLength(1);
    expect(names().filter((name) => name === 'reopen_work')).toHaveLength(1);
    const before = registerTool.mock.calls.length;
    const ctx = { ...ctxFor(tree), model: { provider: ROUTER_PROVIDER_ID, id: AUTO_MODEL_ID } };
    await handlers.get('session_start')!({ reason: 'startup' }, ctx);
    await handlers.get('before_agent_start')!({ prompt: 'implement it', systemPromptOptions: {} }, ctx);
    await handlers.get('turn_start')!({}, ctx);
    await handlers.get('session_tree')!({ newLeafId: null, oldLeafId: null }, ctx);
    expect(registerTool.mock.calls.length).toBe(before);
  });

  it('writes appended events to the session branch as custom entries', async () => {
    const tree = new SessionTree();
    const { handlers, pi, appendEntry } = makePi(tree);
    await autoModelRouterExtension(pi);
    await handlers.get('session_start')!({ reason: 'new' }, ctxFor(tree));
    const u = tree.user('implement the export');

    expect(defaultRouterSession.context.append(createEvent(workItem('w_1'), u))).toBe(true);
    // A duplicate does not apply and is not written.
    expect(defaultRouterSession.context.append(createEvent(workItem('w_1'), u))).toBe(false);

    expect(appendEntry).toHaveBeenCalledTimes(1);
    expect(appendEntry).toHaveBeenCalledWith(CONTEXT_ENTRY_TYPE, expect.objectContaining({ op: 'work-create' }));
    expect(tree.getBranch().at(-1)).toMatchObject({ type: 'custom', customType: CONTEXT_ENTRY_TYPE });
  });
});

describe('mutation observation hooks', () => {
  const concreteCtx = { model: { provider: 'openai-codex', id: 'gpt-5.3' } } as unknown as ExtensionContext;
  const routerAutoCtx = { model: { provider: ROUTER_PROVIDER_ID, id: AUTO_MODEL_ID } } as unknown as ExtensionContext;

  let logDir: string;

  beforeEach(() => {
    // Keep handoff-log writes out of the real user-scope decision log.
    logDir = mkdtempSync(join(tmpdir(), 'ar-index-log-'));
    setDecisionLogBase(logDir);
  });

  function entryState(overrides: Partial<WorkPhaseState> = {}): WorkPhaseState {
    return {
      intentKey: 'intent-a',
      terminal: terminalAssessment(),
      terminalBand: 'frontier',
      providerInvocation: 1,
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
    setDecisionLogBase(undefined);
    rmSync(logDir, { recursive: true, force: true });
  });

  it('uses the completed-work gate before mutation observation and subagent routing', async () => {
    const handlers = await makeToolHandlers();
    const toolCall = handlers.get('tool_call')!;
    defaultRouterSession.setLastDecision({ ...routingDecision(['a/model']), intentKey: 'intent-a' });
    for (const marker of [
      { priorCompletion: { workItemId: 'w_1' } },
      { completion: { workItemId: 'w_1', status: 'done' as const } },
    ]) {
      defaultRouterSession.commitWorkPhaseState(entryState(marker));
      for (const toolName of ['write', 'commit_execution', 'subagent']) {
        expect(await toolCall({ toolName, input: {} }, routerAutoCtx)).toMatchObject({ block: true });
      }
      expect(defaultRouterSession.getWorkPhaseState()?.observedMutationTools).toBe(0);
      expect(defaultRouterSession.getWorkPhaseState()?.contextDenials).toBeUndefined();
      expect(await toolCall({ toolName: 'write', input: {} }, concreteCtx)).toBeUndefined();
    }
  });

  it('keeps concrete-model sessions a complete no-op', async () => {
    const handlers = await makeToolHandlers();
    const toolCall = handlers.get('tool_call')!;
    defaultRouterSession.intent.commitWorkPhaseState(entryState());
    const before = defaultRouterSession.intent.getWorkPhaseState();
    expect(toolCall({ toolName: 'edit', toolCallId: 'e1', input: {} }, concreteCtx)).toBeUndefined();
    expect(defaultRouterSession.intent.getWorkPhaseState()).toEqual(before);
  });

  it('does not flush trajectory on turn_start when the session model is concrete', async () => {
    const handlers = await makeToolHandlers();
    const turnStart = handlers.get('turn_start')!;
    const flush = vi.spyOn(defaultRouterSession, 'flushAndSetUnresolvedTrajectory');
    const models = [registryModel('alpha/cheap')];
    await turnStart({}, contextWithRegistry(models, { provider: 'openai-codex', id: 'gpt-5.3' }));
    expect(flush).not.toHaveBeenCalled();
    flush.mockRestore();
  });

  it('flushes unresolved trajectory on turn_start when router/auto is active', async () => {
    const handlers = await makeToolHandlers();
    const turnStart = handlers.get('turn_start')!;
    const flush = vi.spyOn(defaultRouterSession, 'flushAndSetUnresolvedTrajectory');
    const models = [registryModel('alpha/cheap')];
    await turnStart({}, contextWithRegistry(models, { provider: ROUTER_PROVIDER_ID, id: AUTO_MODEL_ID }));
    expect(flush).toHaveBeenCalledTimes(1);
    flush.mockRestore();
  });

  it('lets an edit of an investigation that owes no handoff run, without changing the routed task type', async () => {
    const handlers = await makeToolHandlers();
    const toolCall = handlers.get('tool_call')!;
    defaultRouterSession.intent.commitWorkPhaseState(entryState());
    defaultRouterSession.setLastDecision({ ...routingDecision(['test/cheap']), dimension: 'gather' as const, intentKey: 'intent-a' });
    defaultRouterSession.setLastServed({ registryId: 'test/cheap', viaFallback: false, accumulatedCost: 0 });
    const note = vi.spyOn(defaultRouterSession, 'noteTrajectoryToolCall');

    expect(await toolCall({ toolName: 'edit', toolCallId: 'e1', input: { path: 'a.ts' } }, routerAutoCtx)).toBeUndefined();
    expect(defaultRouterSession.getWorkPhaseState()?.observedMutationTools).toBe(1);
    expect(defaultRouterSession.getLastDecision()?.dimension).toBe('gather');
    expect(note).toHaveBeenCalledTimes(1);
    note.mockRestore();
  });

  it('shows editing as a phase without changing an unconfirmed plan task type', async () => {
    const handlers = await makeToolHandlers();
    const status = vi.fn();
    const ctx = { ...routerAutoCtx, ui: { setStatus: status } } as unknown as ExtensionContext;
    defaultRouterSession.intent.commitWorkPhaseState(entryState());
    const decision = { ...routingDecision(['test/plan']), dimension: 'plan' as const, intentKey: 'intent-a' };
    defaultRouterSession.setLastDecision(decision);
    defaultRouterSession.setLastServed({ registryId: 'test/plan', viaFallback: false, accumulatedCost: 0 });

    // The first change without a plan is stopped; the repeated one runs.
    await handlers.get('tool_call')!({ toolName: 'write', toolCallId: 'w1', input: { path: 'docs/notes.md' } }, ctx);
    expect(defaultRouterSession.getWorkPhaseState()?.observedMutationTools).toBe(0);
    await handlers.get('tool_call')!({ toolName: 'write', toolCallId: 'w2', input: { path: 'docs/notes.md' } }, ctx);

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
    // Every router tool is registered once, up front, so the tool list never changes mid-session.
    expect(registerTool.mock.calls.map(([tool]) => (tool as { name: string }).name))
        .toEqual(['commit_execution', 'hand_off_context', 'routing_context', 'complete_work', 'reopen_work']);
    const tool = registerTool.mock.calls[0]![0] as { name: string; execute: (...args: unknown[]) => Promise<{ details: { accepted: boolean } }> };

    const ctx = { ...routerAutoCtx, cwd: '/repo' } as unknown as ExtensionContext;
    defaultRouterSession.intent.commitWorkPhaseState(entryState());
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
    defaultRouterSession.intent.commitWorkPhaseState(entryState());
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
    defaultRouterSession.intent.commitWorkPhaseState(entryState());
    defaultRouterSession.setLastDecision({ ...routingDecision(['test/plan']), dimension: 'plan' as const, intentKey: 'intent-a' });
    defaultRouterSession.setLastServed({ registryId: 'test/plan', viaFallback: false, accumulatedCost: 0 });
    const steps = [{ kind: 'edit', path: 'secret-dir/*.ts', change: 'x' }];
    expect((await tool.execute('c1', { steps, remainingWork: {} }, undefined, undefined, ctx)).details.accepted).toBe(false);
    const raw = readFileSync(join(logDir, DECISION_LOG_FILE), 'utf8');
    expect(raw).toContain('"rejectReason":"pattern-path"');
    expect(raw).not.toContain('secret-dir');
  });

  const DIFFICULTY = { alternatives: 3, stakes: 2, spread: 1, knowledge: 1, uncertainty: 1 };

  function handoffTool(registerTool: ReturnType<typeof vi.fn>) {
    const tool = registerTool.mock.calls[1]![0] as {
      name: string;
      execute: (...args: unknown[]) => Promise<{ details: { accepted: boolean } }>;
    };
    return tool;
  }

  const READY = { outcome: 'ready', deliverable: 'plan', complexity: 'trivial', scope: 'bounded', findings: 'f', question: 'q', difficulty: DIFFICULTY };

  function investigating(over: Partial<WorkPhaseState> = {}) {
    defaultRouterSession.intent.commitWorkPhaseState(entryState({ deliverable: 'plan', contextStatus: 'acquiring', ...over }));
    defaultRouterSession.setLastDecision({ ...routingDecision(['test/cheap']), dimension: 'gather' as const, intentKey: 'intent-a' });
    defaultRouterSession.setLastServed({ registryId: 'test/cheap', viaFallback: false, accumulatedCost: 0 });
  }

  it('hands context off through hand_off_context, logging codes and levels but never findings or paths', async () => {
    const registerTool = vi.fn();
    const exec = vi.fn(async () => ({ stdout: 'fix: secret subject\n', stderr: '', code: 0, killed: false }));
    await autoModelRouterExtension({ on: vi.fn(), registerTool, exec } as unknown as ExtensionAPI);
    const tool = handoffTool(registerTool);
    expect(tool.name).toBe('hand_off_context');
    const ctx = { ...routerAutoCtx, cwd: '/repo' } as unknown as ExtensionContext;
    investigating({ readPaths: ['/repo/secret-read.ts'] });
    const request = {
      outcome: 'ready', deliverable: 'plan', complexity: 'trivial', scope: 'bounded',
      findings: 'secret-finding', question: 'secret-question', files: ['secret-dir/a.ts'], difficulty: DIFFICULTY,
    };

    expect((await tool.execute('p0', { ...request, question: ' ' }, undefined, undefined, ctx)).details.accepted).toBe(false);
    expect(exec).not.toHaveBeenCalled();
    expect((await tool.execute('p1', request, undefined, undefined, ctx)).details.accepted).toBe(true);
    const handoff = defaultRouterSession.getWorkPhaseState()?.reasoningHandoff;
    expect(handoff).toMatchObject({ requester: 'test/cheap', target: 'plan', pending: true, rubric: DIFFICULTY });
    // Declared file first, then the read one; the missing file counts as unmeasured.
    expect(handoff?.evidence).toMatchObject({ applicable: true, files: 2, directories: 2, fixCommits: 1 });
    expect(handoff?.evidence.existingLines).toBeUndefined();
    expect((exec.mock.calls[0] as unknown[])[1]).toEqual(expect.arrayContaining(['/repo/secret-dir/a.ts', '/repo/secret-read.ts']));

    // The same handoff again is idempotent; a different one is declined.
    expect((await tool.execute('p2', request, undefined, undefined, ctx)).details.accepted).toBe(true);
    expect((await tool.execute('p3', { ...request, deliverable: 'review' }, undefined, undefined, ctx)).details.accepted).toBe(false);

    const raw = readFileSync(join(logDir, DECISION_LOG_FILE), 'utf8');
    const records = raw.trim().split('\n').map((line) => JSON.parse(line) as {
      investigationHandoff: { action: string; rejectReason?: string; contextReasons?: string[] };
    });
    expect(records.map((record) => [record.investigationHandoff.action, record.investigationHandoff.rejectReason])).toEqual([
      ['reject', 'missing-findings'],
      ['accept', undefined],
      ['reject', 'already-handed-off'],
    ]);
    // Transitions carry why context was owed, as categories only.
    expect(records[1]?.investigationHandoff.contextReasons).toEqual(['reasoning-prep']);
    expect(raw).not.toContain('secret');
  });

  it('accepts a handoff whose evidence is in the conversation without measuring anything', async () => {
    const registerTool = vi.fn();
    const exec = vi.fn();
    await autoModelRouterExtension({ on: vi.fn(), registerTool, exec } as unknown as ExtensionAPI);
    investigating({ deliverable: 'review' });
    const ctx = { ...routerAutoCtx, cwd: '/repo' } as unknown as ExtensionContext;
    const request = { ...READY, deliverable: 'review', files: [] };
    expect((await handoffTool(registerTool).execute('p1', request, undefined, undefined, ctx)).details.accepted).toBe(true);
    expect(exec).not.toHaveBeenCalled();
    expect(defaultRouterSession.getWorkPhaseState()?.reasoningHandoff)
      .toMatchObject({ target: 'review', evidence: { applicable: false } });
  });

  it('takes a pinned model\'s handoff, and declines one outside collecting context', async () => {
    const registerTool = vi.fn();
    await autoModelRouterExtension({ on: vi.fn(), registerTool, exec: vi.fn() } as unknown as ExtensionAPI);
    const tool = handoffTool(registerTool);
    investigating({ contextStatus: undefined });
    defaultRouterSession.setLastDecision({ ...routingDecision(['test/plan']), dimension: 'plan' as const, intentKey: 'intent-a' });
    expect((await tool.execute('p1', READY, undefined, undefined, routerAutoCtx)).details.accepted).toBe(false);
    expect(defaultRouterSession.getWorkPhaseState()?.reasoningHandoff).toBeUndefined();

    investigating();
    defaultRouterSession.setManualModel('test/cheap');
    expect((await tool.execute('p2', READY, undefined, undefined, routerAutoCtx)).details.accepted).toBe(true);
    defaultRouterSession.resumeManual();
    expect(defaultRouterSession.getWorkPhaseState()?.contextStatus).toBe('ready-pending');
  });

  it('uses the declared task type without keyword-based adoption', async () => {
    const registerTool = vi.fn();
    await autoModelRouterExtension({ on: vi.fn(), registerTool, exec: vi.fn() } as unknown as ExtensionAPI);
    const tool = handoffTool(registerTool);
    const hand = async (over: Partial<WorkPhaseState>, request: Record<string, unknown>) => {
      investigating(over);
      await tool.execute('p', { ...READY, ...request }, undefined, undefined, routerAutoCtx);
      return defaultRouterSession.getWorkPhaseState()!;
    };
    // A ready handoff names the next work phase; gather is not a ready work phase.
    const change = { deliverable: 'implement' as const, contextReasons: ['carried-open-context' as const], contextSatisfied: false };
    expect((await hand(change, { deliverable: 'gather', scope: 'bounded' })).deliverable).toBe('implement');
    expect((await hand(change, { deliverable: 'implement' })).reasoningHandoff).toBeUndefined();
    expect((await hand(change, { deliverable: 'plan' })).reasoningHandoff).toMatchObject({ target: 'plan' });
    expect((await hand({}, { deliverable: 'review', scope: 'bounded' })).deliverable).toBe('review');
    expect((await hand({}, { deliverable: 'review' })).deliverable).toBe('review');
  });

  it('raises a planning minimum to the band of the final step, never lowers it', async () => {
    const registerTool = vi.fn();
    await autoModelRouterExtension({ on: vi.fn(), registerTool, exec: vi.fn() } as unknown as ExtensionAPI);
    const tool = handoffTool(registerTool);
    const easy = { alternatives: 1, stakes: 1, spread: 1, knowledge: 1, uncertainty: 1 };
    const minimum = async (over: Partial<WorkPhaseState>, request: Record<string, unknown>) => {
      investigating(over);
      await tool.execute('p', { ...READY, difficulty: easy, ...request }, undefined, undefined, routerAutoCtx);
      return defaultRouterSession.getWorkPhaseState()!.reasoningHandoff!.minimum;
    };
    const economy = { terminal: terminalAssessment({ kind: 'lightweight', complexity: 'trivial', scope: 'bounded' }), terminalBand: 'economy' as const };
    const strong = { terminal: terminalAssessment({ kind: 'plan', complexity: 'moderate', scope: 'open-ended' }), terminalBand: 'strong' as const };
    expect(await minimum(economy, {})).toBeCloseTo(0.45);
    expect(await minimum(strong, {})).toBeCloseTo(0.7);
    // The handoff's own reading of the final step can only raise it.
    expect(await minimum(economy, { complexity: 'hard', scope: 'open-ended' })).toBeCloseTo(0.85);
    expect(await minimum(strong, { complexity: 'trivial', scope: 'bounded' })).toBeCloseTo(0.7);
  });

  it.each(['complexity', 'scope'])(
    'rejects a ready handoff without %s', async (missing) => {
      const registerTool = vi.fn();
      await autoModelRouterExtension({ on: vi.fn(), registerTool, exec: vi.fn() } as unknown as ExtensionAPI);
      const tool = handoffTool(registerTool);
      investigating({ terminal: undefined, terminalBand: undefined });
      const request: Record<string, unknown> = { ...READY };
      delete request[missing];
      expect((await tool.execute('shape', request, undefined, undefined, routerAutoCtx)).details.accepted).toBe(false);
      expect(defaultRouterSession.getWorkPhaseState()?.contextStatus).toBe('acquiring');
      expect(defaultRouterSession.getWorkPhaseState()?.terminal).toBeUndefined();
    },
  );

  it('hands the entry back to the user and then refuses every call', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const registerTool = vi.fn();
    await autoModelRouterExtension({
      on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
      registerTool,
      exec: vi.fn(),
    } as unknown as ExtensionAPI);
    const tool = handoffTool(registerTool);
    investigating();
    expect((await tool.execute('p0', { outcome: 'needs-user', question: ' ' }, undefined, undefined, routerAutoCtx)).details.accepted)
      .toBe(false);
    const asked = await tool.execute('p1', { outcome: 'needs-user', reason: 'ambiguous-request', question: 'which exporter?' }, undefined, undefined, routerAutoCtx);
    expect(asked.details.accepted).toBe(true);
    expect(defaultRouterSession.getWorkPhaseState()?.contextStatus).toBe('clarification-only');
    for (const toolName of ['read', 'ask_user_question', 'hand_off_context', 'edit']) {
      expect(await handlers.get('tool_call')!({ toolName, toolCallId: toolName, input: {} }, routerAutoCtx)).toMatchObject({ block: true });
    }
    expect((await tool.execute('p2', READY, undefined, undefined, routerAutoCtx)).details.accepted).toBe(false);
    expect(gateRecords('investigationHandoff').map((r) => (r as { action: string }).action))
      .toEqual(['reject', 'needs-user', 'deny', 'deny', 'deny', 'deny', 'reject']);
  });

  it('declines a ready handoff until every referenced file is read as it is now', async () => {
    const registerTool = vi.fn();
    await autoModelRouterExtension({ on: vi.fn(), registerTool, exec: vi.fn() } as unknown as ExtensionAPI);
    const tool = handoffTool(registerTool);
    const repo = mkdtempSync(join(tmpdir(), 'ar-handoff-'));
    writeFileSync(join(repo, 'spec.md'), 'the spec\n');
    try {
      const ctx = { ...routerAutoCtx, cwd: repo } as unknown as ExtensionContext;
      defaultRouterSession.context.append(createEvent(workItem('w_1', 't_1', {
        anchors: [{ kind: 'path', value: 'spec.md', role: 'reference', source: 'user' }], openContext: ['referenced-artifact'],
      })));
      investigating({
        deliverable: 'implement', workItemId: 'w_1', contextReasons: ['referenced-artifact'], contextSatisfied: false,
      });
      const request = { ...READY, deliverable: 'implement' };
      const declined = await tool.execute('p1', request, undefined, undefined, ctx) as unknown as { content: Array<{ text: string }>; details: { accepted: boolean } };
      expect(declined.details.accepted).toBe(false);
      expect(declined.content[0]!.text).toContain('spec.md');
      expect(defaultRouterSession.getWorkPhaseState()?.contextDenials).toBe(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('never hangs measuring a declared file that is a device', async () => {
    const registerTool = vi.fn();
    const exec = vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false }));
    await autoModelRouterExtension({ on: vi.fn(), registerTool, exec } as unknown as ExtensionAPI);
    investigating();
    const ctx = { ...routerAutoCtx, cwd: '/repo' } as unknown as ExtensionContext;
    const request = { ...READY, files: ['/dev/zero'] };
    expect((await handoffTool(registerTool).execute('p1', request, undefined, undefined, ctx)).details.accepted).toBe(true);
    expect(defaultRouterSession.getWorkPhaseState()?.reasoningHandoff?.evidence.existingLines).toBeUndefined();
  });

  it('records existing files inside the working directory that successful reads name, for the handoff evidence', async () => {
    const handlers = await makeToolHandlers();
    const toolResult = handlers.get('tool_result')!;
    const content = [{ type: 'text', text: 'read' }];
    investigating();
    const repo = mkdtempSync(join(tmpdir(), 'ar-read-paths-'));
    mkdirSync(join(repo, 'src'));
    for (const file of ['a.ts', 'b.ts']) writeFileSync(join(repo, 'src', file), 'x\n');
    try {
      const ctx = { ...routerAutoCtx, cwd: repo } as unknown as ExtensionContext;
      const read = (id: string, path: string, isError = false) =>
        toolResult({ toolName: 'read', toolCallId: id, input: { path }, content, isError }, ctx);
      await read('r1', 'src/a.ts');
      await read('r2', 'src/missing.ts', true);
      await read('r3', '/home/user/.pi/agent/skills/x/SKILL.md');
      await read('r4', '../sibling/c.ts');
      await read('r5', join(repo, 'src/b.ts'));
      expect(defaultRouterSession.getWorkPhaseState()?.readPaths).toEqual([join(repo, 'src/b.ts'), join(repo, 'src/a.ts')]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('records files any reading tool names, and none a write, a directory, or the router\'s own tools name', async () => {
    const handlers = await makeToolHandlers();
    const toolResult = handlers.get('tool_result')!;
    const content = [{ type: 'text', text: 'out' }];
    investigating();
    const repo = mkdtempSync(join(tmpdir(), 'ar-read-paths-'));
    mkdirSync(join(repo, 'src'));
    for (const file of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) writeFileSync(join(repo, 'src', file), 'x\n');
    try {
      const ctx = { ...routerAutoCtx, cwd: repo } as unknown as ExtensionContext;
      const call = (toolName: string, input: unknown) =>
        toolResult({ toolName, toolCallId: toolName, input, content, isError: false }, ctx);
      await call('tilth_read', { path: 'src/a.ts', mode: 'full' });
      await call('ctx_execute_file', { path: join(repo, 'src/b.ts'), language: 'python', code: 'print(1)' });
      await call('tilth_read', { paths: ['src/c.ts', 'src'] });
      await call('write', { path: 'src/d.ts', content: 'y' });
      await call('bash', { command: 'echo y > src/d.ts' });
      await call('hand_off_context', { files: ['src/d.ts'] });
      expect(defaultRouterSession.getWorkPhaseState()?.readPaths).toEqual(
        ['src/c.ts', 'src/b.ts', 'src/a.ts'].map((path) => join(repo, path)),
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('does not record a read before its result', async () => {
    const handlers = await makeToolHandlers();
    investigating();
    const ctx = { ...routerAutoCtx, cwd: '/repo' } as unknown as ExtensionContext;
    await handlers.get('tool_call')!({ toolName: 'read', toolCallId: 'r1', input: { path: 'src/a.ts' } }, ctx);
    expect(defaultRouterSession.getWorkPhaseState()?.readPaths).toBeUndefined();
  });

  it('reminds an owed investigation once, on its first tool result', async () => {
    const handlers = await makeToolHandlers();
    const toolResult = handlers.get('tool_result')!;
    const content = [{ type: 'text', text: 'read' }];
    investigating({ deliverable: 'review' });
    const first = await toolResult({ toolName: 'read', toolCallId: 'r1', content }, routerAutoCtx) as { content: Array<{ text: string }> };
    expect(first.content[1]!.text).toContain('needs a review');
    expect(first.content[1]!.text).toContain('hand_off_context');
    expect(await toolResult({ toolName: 'read', toolCallId: 'r2', content }, routerAutoCtx)).toBeUndefined();
  });

  it('reminds a gather entry with an ordinary final step only on its first edit result, and never after a handoff', async () => {
    const handlers = await makeToolHandlers();
    const toolResult = handlers.get('tool_result')!;
    const content = [{ type: 'text', text: 'edited' }];
    investigating({ deliverable: 'gather', terminalBand: 'standard', contextStatus: undefined });

    expect(await toolResult({ toolName: 'read', toolCallId: 'r1', content }, routerAutoCtx)).toBeUndefined();
    expect(await handlers.get('tool_call')!({ toolName: 'edit', toolCallId: 'e1', input: { path: 'src/a.ts' } }, routerAutoCtx))
      .toBeUndefined();
    const first = await toolResult({ toolName: 'edit', toolCallId: 'e1', content }, routerAutoCtx) as { content: Array<{ text: string }> };
    expect(first.content.map((c) => c.text)).toEqual(['edited', CONTEXT_HANDOFF_REMINDER]);
    expect(await toolResult({ toolName: 'edit', toolCallId: 'e2', content }, routerAutoCtx)).toBeUndefined();

    investigating({ deliverable: 'plan', contextStatus: 'served' });
    const state = defaultRouterSession.getWorkPhaseState()!;
    defaultRouterSession.commitWorkPhaseState({
      ...state,
      reasoningHandoff: {
        id: 'intent-a', requester: 'test/cheap', target: 'plan', minimum: 0.5, requirement: 0.5,
        rubric: DIFFICULTY, evidence: { applicable: false, files: 0, directories: 0 }, pending: true,
      },
    });
    expect(await toolResult({ toolName: 'read', toolCallId: 'r3', content }, routerAutoCtx)).toBeUndefined();
  });

  it('logs no-handoff when an owed investigation ends without handing off', async () => {
    const handlers = await makeToolHandlers();
    investigating();
    await handlers.get('agent_settled')!({ type: 'agent_settled' }, routerAutoCtx);
    await handlers.get('agent_settled')!({ type: 'agent_settled' }, routerAutoCtx);
    const raw = readFileSync(join(logDir, DECISION_LOG_FILE), 'utf8').trim().split('\n');
    expect(raw.map((line) => (JSON.parse(line) as { investigationHandoff: unknown }).investigationHandoff)).toEqual([
      { action: 'no-handoff', deliverable: 'plan', contextReasons: ['reasoning-prep'] },
    ]);
  });

  it('appends the handoff reminder once to the first plan/review edit result without a plan', async () => {
    const handlers = await makeToolHandlers();
    const toolResult = handlers.get('tool_result')!;
    defaultRouterSession.intent.commitWorkPhaseState(entryState());
    defaultRouterSession.setLastDecision({ ...routingDecision(['test/plan']), dimension: 'plan' as const, intentKey: 'intent-a' });
    defaultRouterSession.setLastServed({ registryId: 'test/plan', viaFallback: false, accumulatedCost: 0 });
    const content = [{ type: 'text', text: 'edited' }];

    expect(await toolResult({ toolName: 'read', toolCallId: 'r1', content }, routerAutoCtx)).toBeUndefined();
    const first = await toolResult({ toolName: 'edit', toolCallId: 'e1', content }, routerAutoCtx) as { content: Array<{ text: string }> };
    expect(first.content.map((c) => c.text)).toEqual(['edited', CONTRACT_REMINDER]);
    expect(await toolResult({ toolName: 'write', toolCallId: 'w1', content }, routerAutoCtx)).toBeUndefined();
    expect(await toolResult({ toolName: 'edit', toolCallId: 'e2', content }, concreteCtx)).toBeUndefined();
  });

  it('does not remind outside plan/review or for a plan-only deliverable', async () => {
    const handlers = await makeToolHandlers();
    const toolResult = handlers.get('tool_result')!;
    const content = [{ type: 'text', text: 'edited' }];
    defaultRouterSession.intent.commitWorkPhaseState(entryState());
    defaultRouterSession.setLastDecision({ ...routingDecision(['test/impl']), dimension: 'implement' as const, intentKey: 'intent-a' });
    expect(await toolResult({ toolName: 'edit', toolCallId: 'e1', content }, routerAutoCtx)).toBeUndefined();

    defaultRouterSession.commitWorkPhaseState({ ...defaultRouterSession.getWorkPhaseState()!, deliverable: 'plan' });
    defaultRouterSession.setLastDecision({
      ...routingDecision(['test/plan']), dimension: 'plan' as const, intentKey: 'intent-a',
    });
    expect(await toolResult({ toolName: 'edit', toolCallId: 'e2', content }, routerAutoCtx)).toBeUndefined();
  });

  it('reminds an implement entry only when the incumbent minimums raised its pick', async () => {
    const handlers = await makeToolHandlers();
    const toolResult = handlers.get('tool_result')!;
    const content = [{ type: 'text', text: 'edited' }];
    defaultRouterSession.intent.commitWorkPhaseState(entryState());
    const scoredReason = { score: 0.8, quality: 0.5, cost: 0.2, speed: 0.1, costBasis: 'per-1m' as const };
    defaultRouterSession.setLastDecision({
      ...routingDecision(['test/impl']), dimension: 'implement' as const, intentKey: 'intent-a',
      scoredReason: { ...scoredReason, details: [{ kind: 'incumbent-model' as const }] },
    });
    const first = await toolResult({ toolName: 'edit', toolCallId: 'e1', content }, routerAutoCtx) as { content: Array<{ text: string }> };
    expect(first.content.map((c) => c.text)).toEqual(['edited', CONTRACT_REMINDER]);
    expect(CONTRACT_REMINDER).toContain('if the user asked for this change');
  });

  function planEntry(over: Partial<WorkPhaseState> = {}, decision: Partial<RoutingDecision> = {}) {
    defaultRouterSession.intent.commitWorkPhaseState(entryState(over));
    defaultRouterSession.setLastDecision({
      ...routingDecision(['test/plan']), dimension: 'plan' as const, intentKey: 'intent-a', ...decision,
    });
    defaultRouterSession.setLastServed({ registryId: 'test/plan', viaFallback: false, accumulatedCost: 0 });
  }

  function gateRecords(key: 'executionContract' | 'investigationHandoff'): unknown[] {
    const raw = readFileSync(join(logDir, DECISION_LOG_FILE), 'utf8').trim().split('\n');
    return raw.map((line) => (JSON.parse(line) as Record<string, unknown>)[key]).filter(Boolean);
  }

  it('stops the first change of a plan/review entry without a plan once, before it runs', async () => {
    const handlers = await makeToolHandlers();
    const toolCall = handlers.get('tool_call')!;
    const toolResult = handlers.get('tool_result')!;
    planEntry();
    const note = vi.spyOn(defaultRouterSession, 'noteTrajectoryToolCall');

    expect(await toolCall({ toolName: 'bash', toolCallId: 'b0', input: { command: 'ls -la' } }, routerAutoCtx)).toBeUndefined();
    expect(await toolCall({ toolName: 'edit', toolCallId: 'e1', input: { path: 'src/a.ts' } }, routerAutoCtx))
      .toEqual({ block: true, reason: CONTRACT_GATE });
    expect(CONTRACT_GATE).toContain('commit_execution');
    expect(defaultRouterSession.getWorkPhaseState()?.observedMutationTools).toBe(0);
    expect(note).toHaveBeenCalledTimes(1);
    note.mockRestore();

    expect(await toolCall({ toolName: 'edit', toolCallId: 'e2', input: { path: 'src/a.ts' } }, routerAutoCtx)).toBeUndefined();
    expect(defaultRouterSession.getWorkPhaseState()?.observedMutationTools).toBe(1);
    expect(defaultRouterSession.getLastDecision()?.dimension).toBe('plan');
    // The stop was the entry's one reminder.
    const content = [{ type: 'text', text: 'edited' }];
    expect(await toolResult({ toolName: 'edit', toolCallId: 'e2', content }, routerAutoCtx)).toBeUndefined();
    expect(gateRecords('executionContract')).toEqual([{ action: 'reminder' }]);
  });

  it('stops a high-confidence shell write of a review entry without a plan', async () => {
    const handlers = await makeToolHandlers();
    const toolCall = handlers.get('tool_call')!;
    planEntry({}, { dimension: 'review' });
    expect(await toolCall({ toolName: 'bash', toolCallId: 'b1', input: { command: 'python script.py' } }, routerAutoCtx))
      .toBeUndefined();
    expect(await toolCall({ toolName: 'bash', toolCallId: 'b2', input: { command: 'echo x > out.txt' } }, routerAutoCtx))
      .toMatchObject({ block: true });
  });

  it('never stops a change with a plan, a pinned model, a plan-only request, or outside plan/review', async () => {
    const handlers = await makeToolHandlers();
    const toolCall = handlers.get('tool_call')!;
    const edit = (id: string) => toolCall({ toolName: 'edit', toolCallId: id, input: { path: 'src/a.ts' } }, routerAutoCtx);

    planEntry({ contract: { status: 'broken' } as WorkPhaseState['contract'] });
    expect(await edit('e1')).toBeUndefined();

    planEntry();
    defaultRouterSession.setManualModel('test/plan');
    expect(await edit('e2')).toBeUndefined();
    defaultRouterSession.resumeManual();

    planEntry({ deliverable: 'plan' });
    expect(await edit('e3')).toBeUndefined();

    planEntry({}, {
      dimension: 'implement',
      scoredReason: { score: 0.8, quality: 0.5, cost: 0.2, speed: 0.1, costBasis: 'per-1m', details: [{ kind: 'incumbent-model' }] },
    });
    expect(await edit('e4')).toBeUndefined();

    planEntry();
    expect(await toolCall({ toolName: 'edit', toolCallId: 'e5', input: { path: 'src/a.ts' } }, concreteCtx)).toBeUndefined();
    expect(defaultRouterSession.getWorkPhaseState()?.contractReminded).toBeUndefined();
  });

  it('refuses every call outside the allowed tools until the handoff, and ends acquisition at the second refusal', async () => {
    const handlers = await makeToolHandlers();
    const toolCall = handlers.get('tool_call')!;
    const toolResult = handlers.get('tool_result')!;
    const call = (toolName: string, input: unknown = { path: 'src/a.ts' }) =>
      toolCall({ toolName, toolCallId: toolName, input }, routerAutoCtx) as Promise<{ block: boolean; reason: string } | undefined>;
    investigating({ deliverable: 'review' });

    // The note on the first tool result does not use up a refusal.
    await toolResult({ toolName: 'read', toolCallId: 'r1', content: [{ type: 'text', text: 'read' }] }, routerAutoCtx);
    expect(await call('read')).toBeUndefined();
    expect(await call('tilth_search', { query: 'x' })).toBeUndefined();
    expect(await call('routing_context', { op: 'update', summary: 's' })).toBeUndefined();
    const stopped = await call('write');
    expect(stopped?.block).toBe(true);
    expect(stopped?.reason).toContain('needs a review');
    expect(stopped?.reason).toContain('hand_off_context');
    // A runner and a read-only shell are refused and do not count; a write in
    // the same invocation already used the one counted refusal.
    expect(await call('ctx_execute_file', { path: 'src/a.ts', code: 'print(1)' })).toMatchObject({ block: true });
    expect(await call('bash', { command: 'rg foo' })).toMatchObject({ block: true });
    expect(defaultRouterSession.getWorkPhaseState()).toMatchObject({ contextDenials: 1, contextStatus: 'acquiring' });
    expect(defaultRouterSession.getWorkPhaseState()?.observedMutationTools).toBe(0);

    defaultRouterSession.commitWorkPhaseState({ ...defaultRouterSession.getWorkPhaseState()!, providerInvocation: 2 });
    expect(await call('bash', { command: 'rg bar' })).toMatchObject({ block: true });
    expect(defaultRouterSession.getWorkPhaseState()).toMatchObject({ contextDenials: 1, contextStatus: 'acquiring' });
    defaultRouterSession.commitWorkPhaseState({ ...defaultRouterSession.getWorkPhaseState()!, providerInvocation: 3 });
    expect((await call('edit'))?.reason).toContain('Reply to the user now');
    expect(defaultRouterSession.getWorkPhaseState()?.contextStatus).toBe('clarification-only');
    expect(await call('read')).toMatchObject({ block: true });
    expect(defaultRouterSession.getLastDecision()?.dimension).toBe('gather');

    // A pinned model is held to the same phase.
    investigating({ deliverable: 'implement', contextReasons: ['referenced-artifact'], contextSatisfied: false });
    defaultRouterSession.setManualModel('test/cheap');
    expect(await call('write')).toMatchObject({ block: true });
    defaultRouterSession.resumeManual();

    // A ready handoff still refuses changes until the next phase serves, without counting them.
    investigating({ contextStatus: 'ready-pending' });
    expect(await call('write')).toMatchObject({ block: true });
    expect(defaultRouterSession.getWorkPhaseState()?.contextDenials).toBeUndefined();
    investigating({ contextStatus: 'served' });
    expect(await call('write')).toBeUndefined();
  });

  it('lets a gather entry hand off to implement, review, or plan, and declines a handoff with no next step', async () => {
    const registerTool = vi.fn();
    await autoModelRouterExtension({ on: vi.fn(), registerTool, exec: vi.fn() } as unknown as ExtensionAPI);
    const tool = handoffTool(registerTool);
    const hand = async (deliverable: string) => {
      investigating({ deliverable: 'gather', contextStatus: undefined });
      await tool.execute('p', { ...READY, deliverable }, undefined, undefined, routerAutoCtx);
      return defaultRouterSession.getWorkPhaseState()!;
    };
    expect((await hand('implement')).deliverable).toBe('implement');
    expect((await hand('implement')).reasoningHandoff).toBeUndefined();
    expect((await hand('review')).reasoningHandoff).toMatchObject({ target: 'review' });
    expect((await hand('plan')).reasoningHandoff).toMatchObject({ target: 'plan' });
    expect((await hand('gather')).contextStatus).toBeUndefined();
    expect((await hand('lightweight')).contextStatus).toBeUndefined();
  });

  it('refuses a subagent spawn while collecting context', async () => {
    const handlers = await makeToolHandlers();
    investigating();
    expect(await handlers.get('tool_call')!({ toolName: 'subagent', toolCallId: 's1', input: { agent: 'worker' } }, routerAutoCtx))
      .toMatchObject({ block: true });
    expect(defaultRouterSession.getWorkPhaseState()?.contextDenials).toBe(1);
  });

  it('refuses a call it cannot check while collecting context, and never one outside the phase', async () => {
    const handlers = await makeToolHandlers();
    investigating();
    const spy = vi.spyOn(defaultRouterSession, 'getLastServed').mockImplementation(() => { throw new Error('boom'); });
    expect(await handlers.get('tool_call')!({ toolName: 'edit', toolCallId: 'e1', input: {} }, routerAutoCtx))
      .toMatchObject({ block: true });
    investigating({ contextStatus: 'served' });
    expect(await handlers.get('tool_call')!({ toolName: 'edit', toolCallId: 'e2', input: {} }, routerAutoCtx))
      .toBeUndefined();
    spy.mockRestore();
  });

  it('counts a high-confidence mutating bash call without blocking it', async () => {
    const handlers = await makeToolHandlers();
    const toolCall = handlers.get('tool_call')!;
    defaultRouterSession.intent.commitWorkPhaseState(entryState());

    const result = await toolCall(
      { toolName: 'bash', toolCallId: 'bash-1', input: { command: 'echo x > out.txt' } },
      routerAutoCtx,
    );
    expect(result).toBeUndefined();
    expect(defaultRouterSession.intent.getWorkPhaseState()?.observedMutationTools).toBe(1);
  });

  it('does not count opaque python or read-only bash', async () => {
    const handlers = await makeToolHandlers();
    const toolCall = handlers.get('tool_call')!;
    defaultRouterSession.intent.commitWorkPhaseState(entryState());

    expect(
      await toolCall({ toolName: 'bash', toolCallId: 'bash-2', input: { command: 'python script.py' } }, routerAutoCtx),
    ).toBeUndefined();
    expect(
      await toolCall({ toolName: 'bash', toolCallId: 'bash-3', input: { command: 'ls -la' } }, routerAutoCtx),
    ).toBeUndefined();
    expect(defaultRouterSession.intent.getWorkPhaseState()?.observedMutationTools).toBe(0);
  });

  it('keeps concrete-model sessions a complete no-op for bash too', async () => {
    const handlers = await makeToolHandlers();
    const toolCall = handlers.get('tool_call')!;
    defaultRouterSession.intent.commitWorkPhaseState(entryState());
    const before = defaultRouterSession.intent.getWorkPhaseState();
    expect(
      await toolCall({ toolName: 'bash', toolCallId: 'bash-1', input: { command: 'rm -rf x' } }, concreteCtx),
    ).toBeUndefined();
    expect(defaultRouterSession.intent.getWorkPhaseState()).toEqual(before);
  });
});

describe('router tool declaration', () => {
  const ROUTER_TOOLS = ['commit_execution', 'hand_off_context', 'routing_context', 'complete_work', 'reopen_work'];

  async function setup(initial: string[]) {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    let active = [...initial];
    const setActiveTools = vi.fn((names: string[]) => { active = [...names]; });
    const pi = {
      on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
      registerTool: vi.fn(),
      getActiveTools: () => [...active],
      setActiveTools,
    } as unknown as ExtensionAPI;
    await autoModelRouterExtension(pi);
    return { handlers, setActiveTools, active: () => active };
  }

  it('declares the router tools only while router/auto is the session model', async () => {
    const { handlers, active } = await setup(['read', 'bash', ...ROUTER_TOOLS, 'other_ext']);
    const concrete = { provider: 'github-copilot', id: 'gpt-5.4' };
    await handlers.get('session_start')!({ reason: 'new' }, contextWithRegistry([registryModel('alpha/cheap')], concrete));
    expect(active()).toEqual(['read', 'bash', 'other_ext']);

    const auto = { provider: ROUTER_PROVIDER_ID, id: AUTO_MODEL_ID };
    await handlers.get('model_select')!({ model: auto }, contextWithRegistry([registryModel('alpha/cheap')], auto));
    expect(active()).toEqual(['read', 'bash', 'other_ext', ...ROUTER_TOOLS]);

    await handlers.get('model_select')!({ model: concrete }, contextWithRegistry([registryModel('alpha/cheap')], concrete));
    expect(active()).toEqual(['read', 'bash', 'other_ext']);
  });

  it('does not set an unchanged tool set again, so Pi records no tool change', async () => {
    const { handlers, setActiveTools } = await setup(['read', ...ROUTER_TOOLS]);
    const auto = { provider: ROUTER_PROVIDER_ID, id: AUTO_MODEL_ID };
    await handlers.get('session_start')!({ reason: 'new' }, contextWithRegistry([registryModel('alpha/cheap')], auto));
    await handlers.get('model_select')!({ model: auto }, contextWithRegistry([registryModel('alpha/cheap')], auto));
    expect(setActiveTools).not.toHaveBeenCalled();
  });
});
