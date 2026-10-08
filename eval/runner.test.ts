import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wholeTaskRecipe } from './recipe.ts';
import { evaluationProfile, PiAgentRunner, piInvocation, ranArmPolicy, runWholeTask } from './runner.ts';
import { sandboxAvailable } from './sandbox.ts';
import type { EvaluationArm, PublicTaskSpec } from './schema.ts';

const available = await sandboxAvailable();
const frozen = {
  task: { id: 't', baseRevision: 'r', publicFixtureDigest: 'f', environmentDigest: 'e' },
  runtime: {
    piRevision: 'p', pi8Commit: 'c', configDigest: 'cfg', benchmarkStoreDigest: 'b', candidateRegistryDigest: 'r',
    providerEndpointDigest: 'ep', systemPromptDigest: 's', toolsetDigest: 't', generationParametersDigest: 'g',
  },
};
const task: PublicTaskSpec = {
  id: 't', fixtureVersion: '1', workspace: { source: '', baseRevision: 'r', sandbox: 'os-isolated-process' },
  userRequest: 'Write made.txt', budget: { wallTimeMs: 20_000 },
};

describe('pi command line', () => {
  it('loads the extension for the router arm and not for a fixed candidate', () => {
    const auto: EvaluationArm = { id: 'a', policy: { kind: 'current-auto' }, continuation: 'normal-policy' };
    const fixed: EvaluationArm = { id: 'b', policy: { kind: 'fixed-candidate', candidateKey: 'deepseek/deepseek-flash' }, continuation: 'normal-policy' };
    expect(piInvocation({ task, arm: auto }, '/repo').args).toEqual(['-ne', '--session-dir', '/out/sessions', '-e', '/repo', '--model', 'router/auto', '-p', 'Write made.txt']);
    expect(piInvocation({ task, arm: fixed }, '/repo').args).not.toContain('-e');
    expect(piInvocation({ task, arm: fixed }, '/repo').args).toContain('deepseek/deepseek-flash');
    expect(piInvocation({ task, arm: auto }, '/repo').env).toBeUndefined();
  });

  it('names the candidate policy in the environment of the cheapest-sufficient selector arm, and rejects another selector', () => {
    const candidate: EvaluationArm = { id: 'c', policy: { kind: 'shadow-selector', selectorVersion: 'cheapest-sufficient' }, continuation: 'normal-policy' };
    const invocation = piInvocation({ task, arm: candidate }, '/repo');
    expect(invocation.args).toEqual(['-ne', '--session-dir', '/out/sessions', '-e', '/repo', '--model', 'router/auto', '-p', 'Write made.txt']);
    expect(invocation.env).toEqual({ PI8_POLICY_VERSION: 'cheapest-sufficient' });
    const other: EvaluationArm = { id: 'o', policy: { kind: 'shadow-selector', selectorVersion: 'other-selector' }, continuation: 'normal-policy' };
    expect(() => piInvocation({ task, arm: other }, '/repo')).toThrow(/does not run/);
  });

  it('keeps the user extensions and removes each excluded tool in a host directory run', () => {
    const auto: EvaluationArm = { id: 'a', policy: { kind: 'current-auto' }, continuation: 'normal-policy' };
    expect(piInvocation({ task, arm: auto }, '/repo', '/s', { userExtensions: true, excludeTools: ['web_search', 'subagent'] }).args)
      .toEqual(['--session-dir', '/s', '--exclude-tools', 'web_search,subagent', '--model', 'router/auto', '-p', 'Write made.txt']);
  });
});

describe('policy check of a router run', () => {
  const auto: EvaluationArm = { id: 'a', policy: { kind: 'current-auto' }, continuation: 'normal-policy' };
  const selector: EvaluationArm = { id: 'c', policy: { kind: 'shadow-selector', selectorVersion: 'cheapest-sufficient' }, continuation: 'normal-policy' };
  const fixed: EvaluationArm = { id: 'f', policy: { kind: 'fixed-candidate', candidateKey: 'p/m' }, continuation: 'normal-policy' };

  it('accepts a run only when every routing decision carries the version of the arm', () => {
    expect(ranArmPolicy(auto, { policyVersions: [undefined, undefined], benchmarkDigests: [] })).toBe(true);
    expect(ranArmPolicy(selector, { policyVersions: ['cheapest-sufficient'], benchmarkDigests: ['d'] })).toBe(true);
    expect(ranArmPolicy(selector, { policyVersions: [undefined], benchmarkDigests: ['d'] })).toBe(false);
    expect(ranArmPolicy(selector, { policyVersions: ['cheapest-sufficient', undefined], benchmarkDigests: ['d'] })).toBe(false);
    expect(ranArmPolicy(auto, { policyVersions: ['cheapest-sufficient'], benchmarkDigests: [] })).toBe(false);
  });

  it('rejects a selector run that compared on no benchmark snapshot or on more than one', () => {
    expect(ranArmPolicy(selector, { policyVersions: ['cheapest-sufficient', 'cheapest-sufficient'], benchmarkDigests: ['d', 'd'] })).toBe(true);
    expect(ranArmPolicy(selector, { policyVersions: ['cheapest-sufficient'], benchmarkDigests: [] })).toBe(false);
    expect(ranArmPolicy(selector, { policyVersions: ['cheapest-sufficient', 'cheapest-sufficient'], benchmarkDigests: ['d', 'e'] })).toBe(false);
  });

  it('rejects a router run without a routing decision, and does not check a fixed candidate', () => {
    expect(ranArmPolicy(auto, { policyVersions: [], benchmarkDigests: [] })).toBe(false);
    expect(ranArmPolicy(selector, { policyVersions: [], benchmarkDigests: [] })).toBe(false);
    expect(ranArmPolicy(fixed, { policyVersions: [], benchmarkDigests: [] })).toBe(true);
  });
});

describe.skipIf(!available)('whole-task run', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pi8-runner-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const arm: EvaluationArm = { id: 'a', policy: { kind: 'current-auto' }, continuation: 'normal-policy' };
  const profile = () => evaluationProfile({ repoRoot: dir, nodeRoot: process.execPath.replace(/\/bin\/node$/, ''), network: 'none' });

  it('runs in a fresh sandbox, seeds a private router directory, and captures the artifact and the logs', async () => {
    const environment = join(dir, 'environment');
    const template = join(dir, 'template');
    mkdirSync(environment);
    mkdirSync(template);
    writeFileSync(join(environment, 'task.txt'), 'public');
    writeFileSync(join(template, 'config.json'), '{"models":["x/*"]}');
    // A stand-in for `pi`: it writes a file, a session, and a decision log.
    const script = [
      'echo "dir=$PI8_DIR"; cat "$PI8_DIR/config.json"; echo made > made.txt',
      'echo \'{"type":"message","timestamp":"2026-01-01T00:00:00Z","message":{"role":"assistant","provider":"p","model":"m","stopReason":"stop","usage":{"input":3,"output":4,"cacheRead":0,"cacheWrite":0}}}\' > /out/sessions/s.jsonl',
      'echo \'{"kind":"decision","viaFallback":true,"cause":"error-fallback"}\' > /out/sessions/s.router-decisions.jsonl',
      'echo \'{"kind":"decision","cause":"trajectory-escalation"}\' >> /out/sessions/s.router-decisions.jsonl',
    ].join('\n');
    const runner = new PiAgentRunner({ repoRoot: dir, pi8Template: template, invocation: () => ({ command: 'sh', args: ['-c', script] }) });
    const recipe = wholeTaskRecipe(arm, frozen);
    const out = await runWholeTask({ runner, profile: profile(), task, recipe, arm, environmentPath: environment, runDir: join(dir, 'run'), runId: 'run-1' });
    expect(out.result).toMatchObject({
      status: 'completed',
      servedTarget: 'p/m',
      deployment: [{ provider: 'p', modelId: 'm' }],
      fallbackCount: 1,
      capabilityEscalations: 1,
      providerFailures: 0,
      rawUsage: { attempts: [{ source: 'main-agent', candidateKey: 'p/m', inputTokens: 3, outputTokens: 4 }], spendIncomplete: false },
    });
    expect(readFileSync(join(out.result.finalArtifact.path, 'made.txt'), 'utf8')).toBe('made\n');
    // The files outlive the sandbox.
    expect(readFileSync(out.files.trajectoryPath!, 'utf8')).toContain('"provider":"p"');
    expect(readFileSync(out.files.decisionLogPath!, 'utf8')).toContain('trajectory-escalation');
    // The public environment stays unchanged.
    expect(() => readFileSync(join(environment, 'made.txt'))).toThrow();
  });

  it('reports a harness error when a selector arm ran without its policy', async () => {
    const environment = join(dir, 'environment');
    mkdirSync(environment);
    const selector: EvaluationArm = { id: 'c', policy: { kind: 'shadow-selector', selectorVersion: 'cheapest-sufficient' }, continuation: 'normal-policy' };
    const script = 'echo \'{"kind":"decision","cause":"heuristic"}\' > /out/sessions/s.router-decisions.jsonl';
    const runner = new PiAgentRunner({ repoRoot: dir, invocation: () => ({ command: 'sh', args: ['-c', script] }) });
    const out = await runWholeTask({
      runner, profile: profile(), task, recipe: wholeTaskRecipe(selector, frozen), arm: selector, environmentPath: environment, runDir: join(dir, 'run'), runId: 'run-p',
    });
    expect(out.result.status).toBe('sandbox-error');
  });

  it('maps a time-out to an exhausted task budget', async () => {
    const environment = join(dir, 'environment');
    mkdirSync(environment);
    const runner = new PiAgentRunner({ repoRoot: dir, invocation: () => ({ command: 'sleep', args: ['30'] }) });
    const recipe = wholeTaskRecipe(arm, frozen);
    const out = await runWholeTask({ runner, profile: profile(), task: { ...task, budget: { wallTimeMs: 300 } }, recipe, arm, environmentPath: environment, runDir: join(dir, 'run'), runId: 'run-2' });
    expect(out.result.status).toBe('task-budget-exhausted');
  });

  it('rejects an arm that does not match the recipe', async () => {
    const environment = join(dir, 'environment');
    mkdirSync(environment);
    const runner = new PiAgentRunner({ repoRoot: dir, invocation: () => ({ command: 'true', args: [] }) });
    const recipe = wholeTaskRecipe(arm, frozen);
    const other: EvaluationArm = { ...arm, policy: { kind: 'fixed-candidate', candidateKey: 'a/b' } };
    await expect(runWholeTask({ runner, profile: profile(), task, recipe, arm: other, environmentPath: environment, runDir: join(dir, 'run'), runId: 'r' })).rejects.toThrow(/does not match/);
  });
});
