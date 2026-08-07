import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { RegistryModelInfo } from './scorer.js';
import { AUTO_MODEL_ID, ROUTER_PROVIDER_ID, type Role } from './types.js';

import autoModelRouterExtension from './index.js';
import { applyEscalation, requestEscalation, resetEscalation } from './escalation.js';
import { computeRoleModels } from './subagents.js';
import {
  addAssessmentCost,
  bumpLatchGeneration,
  getActiveSkillNames,
  getAssessmentCost,
  getCachedRoutingIntent,
  getLatchGeneration,
  resetRouterSession,
  setActiveSkillNames,
  setCachedRoutingIntent,
} from './router-session-state.js';

vi.mock('./commands.js', () => ({ registerCommands: vi.fn() }));
const mockBlacklist = new Set<string>();

vi.mock('./provider.js', () => ({
  registerAutoRouterProvider: vi.fn(),
  buildSubagentProviderAuthFilter: vi.fn(async () => () => true),
  addSessionBlacklistPatterns: vi.fn(() => []),
  clearSessionBlacklist: vi.fn(() => mockBlacklist.clear()),
  getBlacklistedModels: vi.fn(() => new Set(mockBlacklist)),
  getBlacklistedProviders: vi.fn(() => new Set()),
  getSessionBlacklistPatterns: vi.fn(() => []),
  blacklistModel: vi.fn((model: string) => mockBlacklist.add(model)),
}));
vi.mock('./store.js', () => ({ loadStore: vi.fn(() => undefined) }));
vi.mock('./config.js', () => ({ loadConfig: vi.fn(() => ({ debug: false })) }));
vi.mock('./allowlist.js', () => ({
  loadModelFilter: vi.fn(() => () => true),
  buildExcludeFilter: vi.fn(() => () => false),
}));
const mockRoleModels = new Map<Role, string>([
  ['worker', 'alpha/cheap'],
  ['reviewer', 'gamma/moderate'],
]);
const mockRoleFallbacks = new Map<Role, string[]>([
  ['worker', ['alpha/cheap', 'beta/strong']],
  ['reviewer', ['gamma/moderate', 'delta/strong']],
]);

vi.mock('./subagents.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./subagents.js')>();
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
  beforeEach(() => {
    resetEscalation();
  });

  afterEach(() => {
    resetEscalation();
  });

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

    const input: { agent: string; task: string; model?: string } = {
      agent: 'worker',
      task: 'implement the change',
    };
    toolCall!({ toolName: 'subagent', toolCallId: 'call-1', input }, ctx);

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
  it('blacklists the failed model and emits per-task retry directives', async () => {
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
    )) as { content?: Array<{ type: string; text?: string }> };

    expect(mockBlacklist.has('gamma/moderate')).toBe(true);
    expect(plan?.content?.some((part: { type?: string; text?: string }) =>
      part.type === 'text' && part.text?.includes('delta/strong'),
    )).toBe(true);

    const retry: {
      tasks: Array<{ agent: string; task: string; model?: string }>;
    } = {
      tasks: [
        { agent: 'reviewer', task: 'review routing' },
        { agent: 'reviewer', task: 'review routing' },
      ],
    };
    toolCall!({ toolName: 'subagent', toolCallId: 'call-retry', input: retry }, ctx);
    expect(retry.tasks.map((task) => task.model)).toEqual(['delta/strong', 'delta/strong']);
    expect(input.tasks[2].model).toBe('user/explicit');
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

    mockBlacklist.clear();
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
    expect(mockBlacklist.size).toBe(0);
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
    expect(mockBlacklist.size).toBe(0);
    expect(dynamicPlan?.content).toBeUndefined();
  });
});

  it('clears a pending escalation and its cooldown at session_start', async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const pi = {
      on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
      registerTool: vi.fn(),
    } as unknown as ExtensionAPI;
    await autoModelRouterExtension(pi);

    expect(requestEscalation('gather', 'first session request', 2).ok).toBe(true);

    const sessionStart = handlers.get('session_start');
    expect(sessionStart).toBeDefined();
    await sessionStart?.(
      { reason: 'new' },
      {
        modelRegistry: {},
        sessionManager: { getSessionFile: () => undefined },
      } as unknown as ExtensionContext,
    );

    expect(applyEscalation('lightweight')).toBeUndefined();
    expect(requestEscalation('plan', 'new session request', 1).ok).toBe(true);
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
    resetRouterSession();
  });

  for (const reason of ['startup', 'resume', 'fork', 'new'] as const) {
    it(`clears assessment state on session_start(${reason})`, async () => {
      const { handlers, pi } = makePi();
      await autoModelRouterExtension(pi);

      bumpLatchGeneration();
      addAssessmentCost(0.05);
      setActiveSkillNames(['writing-plans']);
      setCachedRoutingIntent({
        key: 'k',
        classifyResult: {
          dimension: 'gather',
          confidence: 0.8,
          signals: [],
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

      expect(getLatchGeneration()).toBe(0);
      expect(getAssessmentCost()).toBe(0);
      expect(getCachedRoutingIntent()).toBeUndefined();
    });
  }

  it('captures skill names only when the router is the active model', async () => {
    const { handlers, pi } = makePi();
    await autoModelRouterExtension(pi);

    const beforeAgentStart = handlers.get('before_agent_start');
    expect(beforeAgentStart).toBeDefined();

    // Concrete session model: complete no-op (hard rule 9).
    resetRouterSession();
    beforeAgentStart?.(
      { systemPromptOptions: { skills: ['writing-plans', { name: 'context-mode' }] } },
      { model: { provider: 'openai-codex', id: 'gpt-5.3' } } as unknown as ExtensionContext,
    );
    expect(getActiveSkillNames()).toEqual([]);

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
    expect(getActiveSkillNames()).toEqual(['writing-plans', 'systematic-debugging']);
  });
});
