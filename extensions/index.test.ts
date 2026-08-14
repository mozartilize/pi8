import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { RegistryModelInfo } from './scorer.js';
import { AUTO_MODEL_ID, ROUTER_PROVIDER_ID, type Role } from './types.js';

import autoModelRouterExtension from './index.js';
import { buildSubagentProviderAuthFilter } from './provider.js';
import { applyEscalation, requestEscalation, resetEscalation } from './escalation.js';
import { computeRoleModels } from './subagents.js';
import { multiWorkRoutingMeta, routingDecision, terminalAssessment } from './test-support/router-fixtures.js';
import { formatDecisionDetail } from './ui.js';
import {
  addAssessmentCost,
  bumpLatchGeneration,
  commitWorkPhaseState,
  getActiveSkillNames,
  getAssessmentCost,
  getCachedRoutingIntent,
  getLastDecision,
  getLatchGeneration,
  getWorkPhaseState,
  resetRouterSession,
  setActiveSkillNames,
  setCachedRoutingIntent,
  setLastDecision,
  setLastServed,
} from './router-session-state.js';
import type { WorkPhaseState } from './work-phase.js';
import { evaluateMutationCall } from './mutation-gate.js';

vi.mock('./commands.js', () => ({ registerCommands: vi.fn() }));
vi.mock('./mutation-gate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./mutation-gate.js')>();
  return { ...actual, evaluateMutationCall: vi.fn(actual.evaluateMutationCall) };
});
const mockBlacklist = new Set<string>();

vi.mock('./provider.js', () => ({
  registerAutoRouterProvider: vi.fn(),
  buildSubagentProviderAuthFilter: vi.fn(() => () => true),
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

      // A concrete-model session must be a complete no-op (hard rule 9): the
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

describe('mutation gate hooks', () => {
  const concreteCtx = { model: { provider: 'openai-codex', id: 'gpt-5.3' } } as unknown as ExtensionContext;
  const routerAutoCtx = { model: { provider: ROUTER_PROVIDER_ID, id: AUTO_MODEL_ID } } as unknown as ExtensionContext;

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
    resetRouterSession();
    vi.mocked(evaluateMutationCall).mockRestore();
  });

  it('keeps concrete-model sessions a complete mutation-gate no-op', async () => {
    const handlers = await makeToolHandlers();
    const toolCall = handlers.get('tool_call')!;
    commitWorkPhaseState(inspectState());
    const before = getWorkPhaseState();
    expect(toolCall({ toolName: 'edit', toolCallId: 'e1', input: {} }, concreteCtx)).toBeUndefined();
    expect(getWorkPhaseState()).toEqual(before);
  });

  it('returns a non-terminating intentional block for router/auto', async () => {
    const handlers = await makeToolHandlers();
    const toolCall = handlers.get('tool_call')!;
    commitWorkPhaseState(inspectState());
    setLastServed({
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

  it('projects the block onto the live decision so the commands can show it', async () => {
    const handlers = await makeToolHandlers();
    const toolCall = handlers.get('tool_call')!;
    commitWorkPhaseState(inspectState());
    setLastServed({
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
    setLastDecision(decision);

    await toolCall({ toolName: 'edit', toolCallId: 'e1', input: {} }, routerAutoCtx);

    expect(getLastDecision()?.multiWork).toMatchObject({
      phase: 'mutate',
      phaseReason: 'gate-handoff',
      gateBlockedInvocation: 1,
    });
    expect(formatDecisionDetail(getLastDecision(), undefined).join('\n')).toContain(
      'mutation blocked at invocation 1',
    );
  });

  it('projects the escape and its degradation onto the live decision', async () => {
    const handlers = await makeToolHandlers();
    const toolCall = handlers.get('tool_call')!;
    commitWorkPhaseState(inspectState({
      phase: 'mutate',
      mutationGateTriggered: true,
      mutationGateBlocks: 1,
      gateBlockedInvocation: 1,
    }));
    setLastServed({
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
    setLastDecision(decision);

    const result = await toolCall({ toolName: 'edit', toolCallId: 'e2', input: {} }, routerAutoCtx);

    expect(result).toBeUndefined();
    expect(getLastDecision()?.multiWork).toMatchObject({
      mutationGateEscaped: true,
      capabilityDegraded: true,
    });
    expect(formatDecisionDetail(getLastDecision(), undefined).join('\n')).toContain('escaped');
  });

  it('fails open without changing state when the gate throws', async () => {
    const handlers = await makeToolHandlers();
    const toolCall = handlers.get('tool_call')!;
    commitWorkPhaseState(inspectState());
    const before = getWorkPhaseState();
    vi.mocked(evaluateMutationCall).mockImplementationOnce(() => {
      throw new Error('boom');
    });

    const result = await toolCall({ toolName: 'edit', toolCallId: 'e1', input: {} }, routerAutoCtx);
    expect(result).toBeUndefined();
    expect(getWorkPhaseState()).toEqual(before);
  });

  it('correlates a mutation result back to its pending call', async () => {
    const handlers = await makeToolHandlers();
    const toolCall = handlers.get('tool_call')!;
    const toolResult = handlers.get('tool_result')!;
    commitWorkPhaseState(inspectState({ multiWorkEngaged: false, phase: 'mutate' }));

    await toolCall({ toolName: 'edit', toolCallId: 'e1', input: {} }, routerAutoCtx);
    expect(getWorkPhaseState()?.pendingMutationToolCallIds.has('e1')).toBe(true);

    await toolResult({ toolName: 'edit', toolCallId: 'e1', content: [], isError: false }, routerAutoCtx);
    expect(getWorkPhaseState()?.pendingMutationToolCallIds.has('e1')).toBe(false);
    expect(getWorkPhaseState()?.mutationCompleted).toBe(true);
  });
});
