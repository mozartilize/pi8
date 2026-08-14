/**
 * Subagent role injection tests.
 *
 * Focus: the correctness invariants of router-owned subagent routing:
 *  - role → dimension mapping
 *  - reviewer ≠ worker (and not same-family)
 *  - user-pinned models survive a sync/refresh
 *  - settings.json is read only to detect user pins; models are injected per
 *    spawn via the tool_call hook and never written to user-scope settings
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import {
  computeRoleAssignments,
  computeRoleModels,
  injectSubagentRoutingWithMetadata,
  pickSubagentDefaultModel,
  resolveLiveRoleModels,
  stripThinkingSuffix,
  sameFamily,
  buildSubagentCandidates,
  resolveUserSettingsPath,
  AUTO_ROUTER_SOURCE,
  ALL_ROLES,
  type RoleAssignment,
  type ExistingOverride,
} from './subagents.js';
import type { RegistryModelInfo } from './scorer.js';
import { buildModelFilter } from './allowlist.js';
import type { BenchModel, Candidate, Role } from './types.js';
import { SUBAGENT_ESCALATION_MARKER } from './subagent-escalation.js';
import { benchRow, registryModel } from './test-support/router-fixtures.js';

// ─── Fixtures ─────────────────────────────────────────────────────────

const REGISTRY: RegistryModelInfo[] = [
  registryModel('anthropic/claude-opus-4-6', { contextWindow: 200000, maxTokens: 8192, cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } }),
  registryModel('anthropic/claude-sonnet-4-6', { contextWindow: 200000, maxTokens: 8192, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }),
  registryModel('openai/gpt-5', { contextWindow: 128000, maxTokens: 8192, cost: { input: 10, output: 30, cacheRead: 2.5, cacheWrite: 15 } }),
  registryModel('openai/gpt-5-mini', { contextWindow: 128000, maxTokens: 8192, cost: { input: 1, output: 4, cacheRead: 0.25, cacheWrite: 1.5 } }),
  registryModel('deepseek/deepseek-v3', { contextWindow: 64000, maxTokens: 8192, cost: { input: 0.5, output: 1, cacheRead: 0.1, cacheWrite: 0.5 } }),
];

const BENCH: BenchModel[] = [
  benchRow('anthropic/claude-opus-4-6', { quality: { intelligence: 95, coding: 92, agenticCoding: 90 }, source: 'artificial-analysis' }),
  benchRow('anthropic/claude-sonnet-4-6', { quality: { intelligence: 80, coding: 80, agenticCoding: 78 }, source: 'artificial-analysis' }),
  benchRow('openai/gpt-5', { quality: { intelligence: 90, coding: 88, agenticCoding: 86 }, source: 'artificial-analysis' }),
  benchRow('openai/gpt-5-mini', { quality: { intelligence: 70, coding: 66, agenticCoding: 64 }, source: 'artificial-analysis' }),
  benchRow('deepseek/deepseek-v3', { quality: { intelligence: 72, coding: 71, agenticCoding: 69 }, source: 'artificial-analysis' }),
];

function candidatesFor(benchModels: BenchModel[] = BENCH): Candidate[] {
  const { candidates } = buildSubagentCandidates(REGISTRY, benchModels);
  return candidates;
}

// ─── sameFamily ────────────────────────────────────────────────────────

describe('resolveUserSettingsPath', () => {
  it('expands tilde-valued PI_CODING_AGENT_DIR like pi-subagents', () => {
    const path = resolveUserSettingsPath('~/custom/pi-agent');
    expect(path).toBe(join(homedir(), 'custom/pi-agent', 'settings.json'));
  });
});

describe('sameFamily', () => {
  it('treats all claude-opus variants as one family', () => {
    expect(sameFamily('anthropic/claude-opus-4-6', 'anthropic/claude-opus-4-6-20260115')).toBe(true);
  });
  it('does not collapse opus into sonnet', () => {
    expect(sameFamily('anthropic/claude-opus-4-6', 'anthropic/claude-sonnet-4-6')).toBe(false);
  });
  it('does not collapse gpt-5 into gpt-5-mini', () => {
    expect(sameFamily('openai/gpt-5', 'openai/gpt-5-mini')).toBe(false);
  });
});

// ─── role → dimension mapping ───────────────────────────────────────────

describe('computeRoleAssignments — role→dimension', () => {
  it('maps each role to its expected dimension and picks a model', () => {
    const a = computeRoleAssignments(candidatesFor());
    const byRole = Object.fromEntries(a.map((x) => [x.role, x])) as Record<string, RoleAssignment>;
    expect(byRole.researcher.dimension).toBe('gather');
    expect(byRole.planner.dimension).toBe('plan');
    expect(byRole.worker.dimension).toBe('implement');
    expect(byRole.reviewer.dimension).toBe('review');
    expect(byRole.advisor.dimension).toBe('plan');
    for (const role of ALL_ROLES) {
      expect(byRole[role].model).toBeTruthy();
    }
  });
});

// ─── reviewer complementarity ──────────────────────────────────────────

describe('computeRoleAssignments — reviewer complementarity', () => {
  it('reviewer is never the same model as the worker', () => {
    const a = computeRoleAssignments(candidatesFor());
    const worker = a.find((x) => x.role === 'worker')!;
    const reviewer = a.find((x) => x.role === 'reviewer')!;
    expect(reviewer.model).not.toBe(worker.model);
  });

  it('reviewer is never same-family as the worker', () => {
    const a = computeRoleAssignments(candidatesFor());
    const worker = a.find((x) => x.role === 'worker')!;
    const reviewer = a.find((x) => x.role === 'reviewer')!;
    expect(sameFamily(reviewer.model!, worker.model!)).toBe(false);
  });

  it('falls back gracefully when no independent model exists', () => {
    // Only one provider with a single model → reviewer must still get *something*.
    const solo: RegistryModelInfo[] = [
      registryModel('anthropic/claude-opus-4-6', { contextWindow: 200000, maxTokens: 8192, cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } }),
    ];
    const a = computeRoleAssignments(buildSubagentCandidates(solo, [benchRow('anthropic/claude-opus-4-6', { quality: { intelligence: 95 }, source: 'artificial-analysis' })]).candidates);
    const reviewer = a.find((x) => x.role === 'reviewer')!;
    expect(reviewer.model).toBeTruthy();
  });
});

// ─── user-pin protection ───────────────────────────────────────────────

describe('computeRoleAssignments — user-pin protection', () => {
  it('preserves a user override and does not overwrite it', () => {
    const existing: Partial<Record<Role, ExistingOverride>> = {
      worker: { model: 'custom/worker-model', source: 'user' },
    };
    const a = computeRoleAssignments(candidatesFor(), { existingOverrides: existing });
    const worker = a.find((x) => x.role === 'worker')!;
    expect(worker.model).toBe('custom/worker-model');
    expect(worker.userPinned).toBe(true);
    expect(worker.applied).toBe(false);
  });

  it('recomputes a slot it previously owned (source === pi8)', () => {
    const existing = {
      worker: { model: 'anthropic/claude-opus-4-6', source: AUTO_ROUTER_SOURCE },
    };
    const a = computeRoleAssignments(candidatesFor(), { existingOverrides: existing });
    const worker = a.find((x) => x.role === 'worker')!;
    expect(worker.applied).toBe(true);
  });

  it('keeps an automatic reviewer independent of a user-pinned worker', () => {
    const pinnedWorker = 'openai/gpt-5';
    const a = computeRoleAssignments(candidatesFor(), {
      existingOverrides: { worker: { model: pinnedWorker, source: 'user' } },
    });
    const reviewer = a.find((x) => x.role === 'reviewer')!;
    expect(reviewer.model).not.toBe(pinnedWorker);
    expect(sameFamily(reviewer.model!, pinnedWorker)).toBe(false);
  });

  it('returns safe empty assignments when there are no routable candidates', () => {
    const a = computeRoleAssignments([]);
    expect(a).toHaveLength(ALL_ROLES.length);
    expect(a.every((x) => x.model === undefined && !x.applied)).toBe(true);
    expect(a.every((x) => x.reason === 'no routable models')).toBe(true);
  });
});

// ─── no settings writing (regression) ──────────────────────────────────

describe('computeRoleModels — never writes settings', () => {
  let dir: string;
  let path: string;
  let storeDir: string | undefined;
  let previousRouterDir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ar-sync-'));
    path = join(dir, 'settings.json');
    previousRouterDir = process.env.PI8_DIR;
    // Isolate from the user's real config so the allowlist does not
    // inadvertently exclude test mock models.
    process.env.PI8_DIR = dir;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (storeDir) rmSync(storeDir, { recursive: true, force: true });
    if (previousRouterDir === undefined) delete process.env.PI8_DIR;
    else process.env.PI8_DIR = previousRouterDir;
  });

  it('does not create a settings file', () => {
    storeDir = mkdtempSync(join(tmpdir(), 'ar-store-'));
    process.env.PI8_DIR = storeDir;
    computeRoleModels(REGISTRY, { settingsPath: path });
    expect(existsSync(path)).toBe(false);
  });

  it('leaves an existing settings file byte-identical', () => {
    const seeded = JSON.stringify(
      { subagents: { agentOverrides: { worker: { model: 'custom/pinned-worker' } } } },
      null,
      2,
    );
    writeFileSync(path, seeded, 'utf8');
    computeRoleModels(REGISTRY, { settingsPath: path });
    expect(readFileSync(path, 'utf8')).toBe(seeded);
  });

  it('returns a model for every router-owned role', () => {
    const { roleModels } = computeRoleModels(REGISTRY, { settingsPath: path });
    expect(roleModels.size).toBe(ALL_ROLES.length);
    expect(roleModels.get('worker')).not.toBe(roleModels.get('reviewer'));
  });

  it('omits user-pinned roles so the pin wins at spawn time', () => {
    const seeded = {
      subagents: { agentOverrides: { worker: { model: 'custom/pinned-worker' } } },
    };
    writeFileSync(path, JSON.stringify(seeded), 'utf8');
    const { roleModels } = computeRoleModels(REGISTRY, { settingsPath: path });
    expect(roleModels.has('worker')).toBe(false);
    expect(roleModels.has('reviewer')).toBe(true);
  });

  it('omits project-pinned roles so the project pin wins at spawn time', () => {
    const projectDir = join(dir, '.pi');
    mkdirSync(projectDir, { recursive: true });
    const projectPath = join(projectDir, 'settings.json');
    const projectSettings = {
      subagents: { agentOverrides: { reviewer: { model: 'project/pinned-reviewer' } } },
    };
    writeFileSync(projectPath, JSON.stringify(projectSettings), 'utf8');
    const { roleModels } = computeRoleModels(REGISTRY, {
      settingsPath: path,
      ctx: { cwd: dir } as unknown as ExtensionContext,
    });
    expect(roleModels.has('reviewer')).toBe(false);
    expect(roleModels.has('worker')).toBe(true);
  });

  it('lets project pin win over user pin (project takes precedence)', () => {
    const userSettings = {
      subagents: { agentOverrides: { worker: { model: 'user/pinned-worker' } } },
    };
    writeFileSync(path, JSON.stringify(userSettings), 'utf8');
    const projectDir = join(dir, '.pi');
    mkdirSync(projectDir, { recursive: true });
    const projectPath = join(projectDir, 'settings.json');
    const projectSettings = {
      subagents: { agentOverrides: { worker: { model: 'project/pinned-worker' } } },
    };
    writeFileSync(projectPath, JSON.stringify(projectSettings), 'utf8');
    const { roleModels } = computeRoleModels(REGISTRY, {
      settingsPath: path,
      ctx: { cwd: dir } as unknown as ExtensionContext,
    });
    // Both user and project pin the worker → worker is omitted from roleModels.
    expect(roleModels.has('worker')).toBe(false);
    // Reviewer is not pinned → router owns it.
    expect(roleModels.has('reviewer')).toBe(true);
  });

  it('ignores project settings when cwd is missing', () => {
    const projectDir = join(dir, '.pi');
    mkdirSync(projectDir, { recursive: true });
    const projectPath = join(projectDir, 'settings.json');
    const projectSettings = {
      subagents: { agentOverrides: { worker: { model: 'project/pinned-worker' } } },
    };
    writeFileSync(projectPath, JSON.stringify(projectSettings), 'utf8');
    // No cwd passed → project settings are not consulted.
    const { roleModels } = computeRoleModels(REGISTRY, { settingsPath: path });
    // Without cwd, only user settings are read — worker is not pinned.
    expect(roleModels.has('worker')).toBe(true);
  });

  it('omits roles whose provider has no credentials', () => {
    const { roleModels } = computeRoleModels(REGISTRY, {
      settingsPath: path,
      isProviderUsable: (p) => p === 'openai',
    });
    for (const model of roleModels.values()) {
      expect(model.startsWith('openai/')).toBe(true);
    }
  });

  it('honours the models allowlist', () => {
    const { roleModels } = computeRoleModels(REGISTRY, {
      settingsPath: path,
      isModelAllowed: buildModelFilter(['openai/gpt-5-mini', 'deepseek/*']),
    });
    expect(roleModels.size).toBeGreaterThan(0);
    for (const model of roleModels.values()) {
      expect(['openai/gpt-5-mini', 'deepseek/deepseek-v3']).toContain(model);
    }
  });
});

// ─── spawn-time injection ──────────────────────────────────────────────

describe('resolveLiveRoleModels', () => {
  it('skips a runtime-blacklisted top pick and uses the next in the chain', () => {
    const fallbacks = new Map<Role, string[]>([
      ['worker', ['google/gemini-flash-3.5', 'openai/gpt-5-mini', 'deepseek/deepseek-v3']],
      ['reviewer', ['anthropic/claude-opus-4-6', 'openai/gpt-5']],
    ]);
    const blacklist = new Set(['google/gemini-flash-3.5']);
    const live = resolveLiveRoleModels(fallbacks, (id) => blacklist.has(id));
    expect(live.get('worker')).toBe('openai/gpt-5-mini');
    expect(live.get('reviewer')).toBe('anthropic/claude-opus-4-6');
  });

  it('omits a role entirely when every model in its chain is blacklisted', () => {
    const fallbacks = new Map<Role, string[]>([
      ['worker', ['google/gemini-flash-3.5', 'google/gemini-pro-3.5']],
    ]);
    const blacklist = new Set(['google/gemini-flash-3.5', 'google/gemini-pro-3.5']);
    const live = resolveLiveRoleModels(fallbacks, (id) => blacklist.has(id));
    expect(live.has('worker')).toBe(false);
  });
});

describe('injectSubagentRoutingWithMetadata — basic injection', () => {
  const roleModels = new Map<Role, string>([
    ['reviewer', 'openai/gpt-5'],
    ['worker', 'deepseek/deepseek-v3'],
  ]);

  it('fills model on a single spec', () => {
    const input: Record<string, unknown> = { agent: 'reviewer', task: 'review' };
    const traversal = injectSubagentRoutingWithMetadata(input, roleModels);
    expect(traversal.injected).toHaveLength(1);
    expect(input.model).toBe('openai/gpt-5');
  });

  it('injects the selected concrete model for a role', () => {
    const input: Record<string, unknown> = { agent: 'worker', task: 'build' };
    injectSubagentRoutingWithMetadata(input, roleModels);
    expect(input.model).toBe(roleModels.get('worker'));
  });

  it('preserves an explicit concrete model on the call', () => {
    const input: Record<string, unknown> = {
      agent: 'reviewer',
      task: 'review',
      model: 'claude-sonnet-5',
    };
    const traversal = injectSubagentRoutingWithMetadata(input, roleModels);
    expect(traversal.injected).toHaveLength(0);
    expect(input.model).toBe('claude-sonnet-5');
  });

  it('ignores agents the router does not own', () => {
    // Scoped to structured specs: a non-role agent here gets no per-role
    // model. Scripted spawns of any agent are governed by the tool-level
    // default instead (see the workflow-scripted describe below).
    const input: Record<string, unknown> = { agent: 'oracle', task: 'x' };
    const traversal = injectSubagentRoutingWithMetadata(input, roleModels);
    expect(traversal.injected).toHaveLength(0);
    expect(input.model).toBeUndefined();
  });

  it('patches tasks[], chain[] and nested parallel[]', () => {
    const input = {
      tasks: [{ agent: 'reviewer', task: 'a' }],
      chain: [
        { agent: 'worker', task: 'b' },
        { parallel: [{ agent: 'reviewer', task: 'c' }] },
      ],
    } as Record<string, unknown>;
    const traversal = injectSubagentRoutingWithMetadata(input, roleModels);
    expect(traversal.injected).toHaveLength(3);
    const tasks = input.tasks as Array<{ model?: string }>;
    const chain = input.chain as Array<{ model?: string; parallel?: Array<{ model?: string }> }>;
    expect(tasks[0].model).toBe('openai/gpt-5');
    expect(chain[0].model).toBe('deepseek/deepseek-v3');
    expect(chain[1].parallel![0].model).toBe('openai/gpt-5');
  });

  it('is a no-op for an empty role map or non-object input', () => {
    const input: Record<string, unknown> = { agent: 'reviewer' };
    expect(injectSubagentRoutingWithMetadata(input, new Map()).injected).toHaveLength(0);
    expect(injectSubagentRoutingWithMetadata(null, roleModels).injected).toHaveLength(0);
    expect(input.model).toBeUndefined();
  });
});

describe('tool-level default model for workflow-scripted spawns', () => {
  const roleModels = new Map<Role, string>([
    ['worker', 'deepseek/deepseek-v3'],
    ['reviewer', 'openai/gpt-5'],
  ]);
  // Deliberately distinct from every role pick so a test can tell whether the
  // tool-level default or the per-role pick applied.
  const defaultModel = 'openai/root-default';

  it('fills the top-level model on a workflowScript call with no model', () => {
    const input: Record<string, unknown> = {
      workflowScript: "runs.run('k', { agent: 'scout', task: 'recon' })",
    };
    const traversal = injectSubagentRoutingWithMetadata(input, roleModels, { defaultModel });
    expect(input.model).toBe('openai/root-default');
    // Scripted children are invisible to the structured walker; the tool-level
    // slot is the only thing patched.
    expect(traversal.injected).toHaveLength(0);
  });

  it('replaces the router/auto sentinel with the default', () => {
    const input: Record<string, unknown> = {
      workflowScript: "runs.run('k', { agent: 'scout', task: 'recon' })",
      model: 'router/auto',
    };
    injectSubagentRoutingWithMetadata(input, roleModels, { defaultModel });
    expect(input.model).toBe('openai/root-default');
  });

  it('preserves an explicit tool-level model', () => {
    const input: Record<string, unknown> = {
      workflowScript: "runs.run('k', { agent: 'scout', task: 'recon' })",
      model: 'anthropic/claude-4',
    };
    injectSubagentRoutingWithMetadata(input, roleModels, { defaultModel });
    expect(input.model).toBe('anthropic/claude-4');
  });

  it('leaves management actions alone', () => {
    const input: Record<string, unknown> = { action: 'status', id: 'run-1' };
    injectSubagentRoutingWithMetadata(input, roleModels, { defaultModel });
    expect(input.model).toBeUndefined();
  });

  it('leaves an action call alone even when it also carries a script', () => {
    // schedule.create is the one surface pi-subagents accepts with both an
    // action and a workflowScript; it stores only the script and would drop a
    // filled model, so the default must not touch it.
    const input: Record<string, unknown> = {
      action: 'schedule.create',
      workflowScript: "runs.run('k', { agent: 'scout', task: 'recon' })",
    };
    injectSubagentRoutingWithMetadata(input, roleModels, { defaultModel });
    expect(input.model).toBeUndefined();
  });

  it('does not fill a whitespace-only script', () => {
    const input: Record<string, unknown> = { workflowScript: '   ' };
    injectSubagentRoutingWithMetadata(input, roleModels, { defaultModel });
    expect(input.model).toBeUndefined();
  });

  it('does not touch non-scripted calls, so role-specific injection stays authoritative', () => {
    // A single-child structured call has no workflowScript: the per-role
    // injection above already owns its model slot, and the tool-level default
    // must not preempt it. The distinct default value makes a wrong fill
    // observable (it would overwrite the worker pick).
    const input: Record<string, unknown> = { agent: 'worker', task: 'build' };
    injectSubagentRoutingWithMetadata(input, roleModels, { defaultModel });
    expect(input.model).toBe('deepseek/deepseek-v3');
  });

  it('leaves a structured non-role call alone even with a default available', () => {
    const input: Record<string, unknown> = { agent: 'oracle', task: 'second opinion' };
    injectSubagentRoutingWithMetadata(input, roleModels, { defaultModel });
    expect(input.model).toBeUndefined();
  });

  it('is a no-op without a default', () => {
    const input: Record<string, unknown> = {
      workflowScript: "runs.run('k', { agent: 'scout', task: 'recon' })",
    };
    injectSubagentRoutingWithMetadata(input, roleModels);
    expect(input.model).toBeUndefined();
  });
});

describe('pickSubagentDefaultModel', () => {
  it('prefers the worker pick and falls back in a fixed order', () => {
    expect(pickSubagentDefaultModel(new Map([['reviewer', 'a'], ['planner', 'b']]))).toBe('b');
    expect(pickSubagentDefaultModel(new Map([['worker', 'w'], ['planner', 'b']]))).toBe('w');
    expect(pickSubagentDefaultModel(new Map([['researcher', 'r'], ['advisor', 'v']]))).toBe('r');
  });

  it('returns undefined when no role is routable', () => {
    expect(pickSubagentDefaultModel(new Map())).toBeUndefined();
  });
});

describe('explicit model ownership', () => {
  const roleModels = new Map<Role, string>([
    ['reviewer', 'openai/gpt-5'],
    ['worker', 'deepseek/deepseek-v3'],
  ]);

  it('injects the routed model when model is omitted', () => {
    const input: { agent: string; task: string; model?: string } = {
      agent: 'worker',
      task: 'build',
    };
    const traversal = injectSubagentRoutingWithMetadata(input, roleModels);
    expect(input.model).toBe('deepseek/deepseek-v3');
    expect(traversal.injected[0]?.routerOwned).toBe(true);
  });

  it('injects the routed model for the router/auto sentinel', () => {
    const input: { agent: string; task: string; model?: string } = {
      agent: 'reviewer',
      task: 'review',
      model: 'router/auto',
    };
    const traversal = injectSubagentRoutingWithMetadata(input, roleModels);
    expect(input.model).toBe('openai/gpt-5');
    expect(traversal.injected[0]?.requestedModel).toBe('router/auto');
    expect(traversal.injected[0]?.routerOwned).toBe(true);
  });

  it('preserves an explicit concrete model unchanged', () => {
    const input: { agent: string; task: string; model?: string } = {
      agent: 'worker',
      task: 'build',
      model: 'github-copilot/claude-sonnet-4.6',
    };
    const traversal = injectSubagentRoutingWithMetadata(input, roleModels);
    expect(input.model).toBe('github-copilot/claude-sonnet-4.6');
    expect(traversal.injected).toHaveLength(0);
  });

  it('fails open when the role has no routed model', () => {
    const input: { agent: string; task: string; model?: string } = {
      agent: 'planner',
      task: 'plan',
      model: 'router/auto',
    };
    const traversal = injectSubagentRoutingWithMetadata(input, roleModels);
    // No base model for 'planner', so the sentinel is not consumed.
    expect(input.model).toBe('router/auto');
    expect(traversal.injected).toHaveLength(0);
  });

  it('passes router/auto sentinel through when the role is pinned', () => {
    // Pinned roles are absent from roleModels. When the caller still passes
    // the sentinel, it passes through unexpanded — the pin wins and the
    // sentinel is the caller's own problem.
    const pinnedRoleModels = new Map<Role, string>([
      ['reviewer', 'openai/gpt-5'],
      // worker is pinned by user/project, intentionally omitted
    ]);
    const input: { agent: string; task: string; model?: string } = {
      agent: 'worker',
      task: 'build',
      model: 'router/auto',
    };
    const traversal = injectSubagentRoutingWithMetadata(input, pinnedRoleModels);
    // Pin wins: sentinel is NOT consumed, no model is injected.
    expect(input.model).toBe('router/auto');
    expect(traversal.injected).toHaveLength(0);
  });

  it('treats omitted and sentinel identically across tasks and chains', () => {
    const input: {
      tasks: Array<{ agent: string; task: string; model?: string }>;
      chain: Array<{ parallel: Array<{ agent: string; task: string; model?: string }> }>;
    } = {
      tasks: [
        { agent: 'worker', task: 'a', model: 'router/auto' },
        { agent: 'reviewer', task: 'b' },
      ],
      chain: [{ parallel: [{ agent: 'worker', task: 'c', model: 'old/b' }] }],
    };
    const traversal = injectSubagentRoutingWithMetadata(input, roleModels);
    // Sentinel consumed.
    expect(input.tasks[0].model).toBe('deepseek/deepseek-v3');
    // Omitted → router-owned.
    expect(input.tasks[1].model).toBe('openai/gpt-5');
    // Explicit concrete → preserved.
    expect(input.chain[0].parallel[0].model).toBe('old/b');
    expect(traversal.injected).toHaveLength(2);
  });
});

describe('count-repeated tasks', () => {
  const roleModels = new Map<Role, string>([
    ['reviewer', 'openai/gpt-5'],
    ['worker', 'deepseek/deepseek-v3'],
  ]);

  it('reserves count spans for top-level tasks[] entries', () => {
    const input = {
      tasks: [
        { agent: 'reviewer', task: 'review', count: 2 },
        { agent: 'worker', task: 'implement' },
      ],
    };
    const traversal = injectSubagentRoutingWithMetadata(input, roleModels);

    // First reviewer at index 0, second at index 1.
    expect(traversal.children[0]).toMatchObject({
      childIndex: 0, childIndexSpan: 2, role: 'reviewer',
    });
    // Worker at index 2 (after 2 reviewer slots).
    expect(traversal.children[1]).toMatchObject({
      childIndex: 2, role: 'worker',
    });
  });

  it('reserves count spans for chain parallel[] entries', () => {
    const input = {
      chain: [{
        parallel: [
          { agent: 'worker', task: 'a', count: 3 },
          { agent: 'reviewer', task: 'b' },
        ],
      }],
    };
    const traversal = injectSubagentRoutingWithMetadata(input, roleModels);

    // Three worker slots then one reviewer.
    expect(traversal.children[0]).toMatchObject({
      childIndex: 0, childIndexSpan: 3, role: 'worker',
    });
    expect(traversal.children[1]).toMatchObject({
      childIndex: 3, role: 'reviewer',
    });
  });

  it('fails open on invalid count values', () => {
    const tests: unknown[] = [
      { agent: 'worker', task: 'a', count: 0 },
      { agent: 'worker', task: 'a', count: -1 },
      { agent: 'worker', task: 'a', count: 2.5 },
      { agent: 'worker', task: 'a', count: '3' },
      { agent: 'worker', task: 'a', count: null },
      { agent: 'worker', task: 'a', count: true },
      { agent: 'worker', task: 'a', count: {} },
    ];
    for (const task of tests) {
      const input = { tasks: [task] };
      const traversal = injectSubagentRoutingWithMetadata(input, roleModels);
      // Invalid count → stableIndexKnown = false, no childIndex.
      expect(traversal.children[0]?.stableIndexKnown).toBe(false);
      expect(traversal.children[0]?.childIndex).toBeUndefined();
    }
  });

  it('correlates the correct role with count-aware indexing', () => {
    // Simulate pi-subagents expansion:
    //   reviewer count=2 → indexes 0,1
    //   worker            → index 2
    const input = {
      tasks: [
        { agent: 'reviewer', task: 'review', count: 2 },
        { agent: 'worker', task: 'implement' },
      ],
    };
    const traversal = injectSubagentRoutingWithMetadata(input, roleModels);

    // Index 0 → first reviewer
    expect(traversal.children.find(
      c => c.childIndex !== undefined && 0 >= c.childIndex && 0 < c.childIndex + (c.childIndexSpan ?? 1),
    )?.role).toBe('reviewer');
    // Index 1 → second reviewer (same span)
    expect(traversal.children.find(
      c => c.childIndex !== undefined && 1 >= c.childIndex && 1 < c.childIndex + (c.childIndexSpan ?? 1),
    )?.role).toBe('reviewer');
    // Index 2 → worker
    expect(traversal.children.find(
      c => c.childIndex !== undefined && 2 >= c.childIndex && 2 < c.childIndex + (c.childIndexSpan ?? 1),
    )?.role).toBe('worker');
  });

  it('still injects model for router-owned roles with count', () => {
    const input: { tasks: Array<{ agent: string; task: string; count: number; model?: string }> } = {
      tasks: [
        { agent: 'worker', task: 'build', count: 2 },
      ],
    };
    const traversal = injectSubagentRoutingWithMetadata(input, roleModels);
    expect(input.tasks[0].model).toBe('deepseek/deepseek-v3');
    expect(traversal.injected).toHaveLength(1);
  });

  it('does not inject for non-router-owned roles with count', () => {
    const input: { tasks: Array<{ agent: string; task: string; count: number; model?: string }> } = {
      tasks: [
        { agent: 'planner', task: 'plan', count: 2 },
      ],
    };
    const traversal = injectSubagentRoutingWithMetadata(input, roleModels);
    expect(input.tasks[0].model).toBeUndefined();
    expect(traversal.injected).toHaveLength(0);
  });
});

describe('escalation contract injection', () => {
  const roleModels = new Map<Role, string>([
    ['reviewer', 'openai/gpt-5'],
    ['worker', 'deepseek/deepseek-v3'],
  ]);

  it('appends the contract to a router-owned single spec after concrete model injection', () => {
    const input: { agent: string; task: string; model?: string } = { agent: 'worker', task: 'build it' };
    const { injected } = injectSubagentRoutingWithMetadata(input, roleModels);

    expect(input.model).toBe('deepseek/deepseek-v3');
    expect(input.task).toContain(SUBAGENT_ESCALATION_MARKER);
    expect(injected).toMatchObject([
      { role: 'worker', model: 'deepseek/deepseek-v3', originalTask: 'build it' },
    ]);
  });

  it('covers tasks, chains, and nested parallel specs without duplicating the contract', () => {
    const alreadyContracted: { agent: string; task: string; model?: string } = { agent: 'worker', task: 'repeat' };
    injectSubagentRoutingWithMetadata(alreadyContracted, roleModels);
    delete alreadyContracted.model;
    const input = {
      tasks: [{ agent: 'reviewer', task: 'a' }],
      chain: [
        alreadyContracted,
        { parallel: [{ agent: 'worker', task: 'c' }] },
      ],
    };

    expect(injectSubagentRoutingWithMetadata(input, roleModels).injected).toHaveLength(3);
    const tasks = [
      input.tasks[0].task,
      alreadyContracted.task,
      (input.chain[1] as { parallel: Array<{ task: string }> }).parallel[0]!.task,
    ];
    for (const task of tasks) {
      expect(task.match(/\[router-escalate\]/g)).toHaveLength(1);
    }
  });

  it('injects object-valued dynamic parallel templates with ownership metadata', () => {
    const input = {
      chain: [{
        expand: { from: { output: 'targets', path: '/items' }, maxItems: 3 },
        parallel: { agent: 'worker', task: 'inspect {item}' },
        collect: { as: 'reviews' },
      }],
    };

    const { injected } = injectSubagentRoutingWithMetadata(input, roleModels);
    expect(injected).toMatchObject([{
      childIndex: 0,
      path: '$.chain[0].parallel',
      role: 'worker',
      model: 'deepseek/deepseek-v3',
      routerOwned: true,
      originalTask: 'inspect {item}',
    }]);
    const template = input.chain[0]!.parallel as { model?: string; task: string };
    expect(template.model).toBe('deepseek/deepseek-v3');
    expect(template.task).toContain(SUBAGENT_ESCALATION_MARKER);
  });

  it('fails open after a dynamic template whose globally configured span is unknown', () => {
    const input = {
      chain: [
        {
          expand: { from: { output: 'targets', path: '/items' } },
          parallel: { agent: 'worker', task: 'inspect {item}' },
          collect: { as: 'reviews' },
        },
        { agent: 'worker', task: 'summarize' },
      ],
    };

    const { injected } = injectSubagentRoutingWithMetadata(input, roleModels);
    expect(injected).toHaveLength(2);
    expect(injected).toMatchObject([
      { path: '$.chain[0].parallel', stableIndexKnown: false, routerOwned: true },
      { path: '$.chain[1]', stableIndexKnown: false, routerOwned: true },
    ]);
    expect(injected.every((child) => child.childIndex === undefined)).toBe(true);
    const template = input.chain[0]!.parallel as { model?: string; task: string };
    const later = input.chain[1] as { model?: string; task: string };
    expect(template.model).toBe('deepseek/deepseek-v3');
    expect(later.model).toBe('deepseek/deepseek-v3');
    expect(template.task).not.toContain(SUBAGENT_ESCALATION_MARKER);
    expect(later.task).not.toContain(SUBAGENT_ESCALATION_MARKER);
  });

  it('keeps async model injection but omits the synchronous escalation contract', () => {
    const input: { agent: string; task: string; async: boolean; model?: string } = {
      agent: 'worker',
      task: 'background',
      async: true,
    };

    // Async children are model-injected but get no escalation contract — the
    // same option the production tool_call hook passes for async launches.
    const { injected } = injectSubagentRoutingWithMetadata(
      input,
      roleModels,
      { appendEscalationContract: false },
    );
    expect(injected).toHaveLength(1);
    expect(input.model).toBe('deepseek/deepseek-v3');
    expect(input.task).not.toContain(SUBAGENT_ESCALATION_MARKER);
  });

  it('consumes a one-shot override only for the next router-owned spec of that role', () => {
    const overrides = new Map<Role, string>([['worker', 'provider/strong']]);
    const input = {
      tasks: [
        { agent: 'worker', model: 'user/explicit', task: 'explicit' },
        { agent: 'worker', task: 'first routed' },
        { agent: 'worker', task: 'second routed' },
      ],
    };

    injectSubagentRoutingWithMetadata(input, roleModels, {
      consumeOverride: (role) => {
        const model = overrides.get(role);
        overrides.delete(role);
        return model;
      },
    });
    expect(input.tasks.map((task) => task.model)).toEqual([
      'user/explicit',
      'provider/strong',
      'deepseek/deepseek-v3',
    ]);
    expect(overrides.size).toBe(0);
  });

  it('leaves explicit models, user-pinned roles, and non-string tasks untouched', () => {
    const input = {
      tasks: [
        { agent: 'worker', model: 'user/explicit', task: 'explicit' },
        { agent: 'planner', task: 'user-pinned role' },
        { agent: 'reviewer', task: { structured: true } },
      ],
    };

    const { injected } = injectSubagentRoutingWithMetadata(input, roleModels);
    expect(injected).toMatchObject([
      { role: 'reviewer', model: 'openai/gpt-5' },
    ]);
    expect(input.tasks[0]).toEqual({ agent: 'worker', model: 'user/explicit', task: 'explicit' });
    expect(input.tasks[1]).toEqual({ agent: 'planner', task: 'user-pinned role' });
    expect(input.tasks[2].task).toEqual({ structured: true });
  });
});

// ─── credential gating (regression) ────────────────────────────────────

describe('buildSubagentCandidates — credential gate', () => {
  it('excludes providers without credentials and counts them', () => {
    const { candidates, skippedUnauthenticated } = buildSubagentCandidates(
      REGISTRY,
      BENCH,
      (p) => p === 'openai',
    );
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((c) => c.registryId.startsWith('openai/'))).toBe(true);
    // anthropic (2) + deepseek (1) were skipped.
    expect(skippedUnauthenticated).toBe(3);
  });

  it('excludes models outside the allowlist and counts them', () => {
    const { candidates, skippedNotAllowed } = buildSubagentCandidates(
      REGISTRY,
      BENCH,
      undefined,
      buildModelFilter(['openai/*']),
    );
    expect(candidates.every((c) => c.registryId.startsWith('openai/'))).toBe(true);
    expect(skippedNotAllowed).toBe(3);
  });

  it('stays permissive when no predicate is supplied', () => {
    const { candidates, skippedUnauthenticated } = buildSubagentCandidates(REGISTRY, BENCH);
    expect(candidates.length).toBe(REGISTRY.length);
    expect(skippedUnauthenticated).toBe(0);
  });

  it('never assigns a role to an unauthenticated provider', () => {
    // Regression: anthropic/claude-opus-* scores highest overall, so without a
    // credential gate every role was pinned to it even with no anthropic auth,
    // and pi-subagents then hard-failed with "No API key found for anthropic".
    const { candidates } = buildSubagentCandidates(REGISTRY, BENCH, (p) => p !== 'anthropic');
    const assignments = computeRoleAssignments(candidates);
    for (const a of assignments) {
      expect(a.model?.startsWith('anthropic/')).toBeFalsy();
    }
  });
});

// ─── no-data never blocks (registry-only fallback) ──────────────────────

describe('registry-only fallback (no benchmark data)', () => {
  it('still assigns every role from registry models alone', () => {
    // Empty bench list → scorer falls back to price/cost heuristics.
    const a = computeRoleAssignments(buildSubagentCandidates(REGISTRY, []).candidates);
    for (const role of ALL_ROLES) {
      const found = a.find((x) => x.role === role)!;
      expect(found.model).toBeTruthy();
    }
    // Reviewer must still differ from worker even without benchmark quality.
    const worker = a.find((x) => x.role === 'worker')!;
    const reviewer = a.find((x) => x.role === 'reviewer')!;
    expect(reviewer.model).not.toBe(worker.model);
  });
});

// ─── Thinking-suffix stripping ────────────────────────────────────────

describe('stripThinkingSuffix', () => {
  it('strips a known trailing thinking level', () => {
    expect(stripThinkingSuffix('github-copilot/gpt-5.4-nano:high')).toBe('github-copilot/gpt-5.4-nano');
    expect(stripThinkingSuffix('opencode-go/deepseek-v4-pro:off')).toBe('opencode-go/deepseek-v4-pro');
  });

  it('leaves a bare id and an unknown colon suffix intact', () => {
    expect(stripThinkingSuffix('github-copilot/gpt-5.4-nano')).toBe('github-copilot/gpt-5.4-nano');
    // ":latest" is not a thinking level — must not be stripped.
    expect(stripThinkingSuffix('vendor/model:latest')).toBe('vendor/model:latest');
  });
});
