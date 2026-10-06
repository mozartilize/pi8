import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HostPiAgentRunner } from './host-pi-runner.ts';
import { wholeTaskRecipe } from './recipe.ts';
import { runWholeTask } from './runner.ts';
import type { EvaluationArm, PublicTaskSpec } from './schema.ts';
import { vmSandboxAvailable, vmSandboxFactory, type VmSandboxFactory } from './vm-sandbox.ts';

const here = dirname(fileURLToPath(import.meta.url));
const available = vmSandboxAvailable();
const frozen = {
  task: { id: 't', baseRevision: 'r', publicFixtureDigest: 'f', environmentDigest: 'e' },
  runtime: {
    piRevision: 'p', pi8Commit: 'c', configDigest: 'cfg', benchmarkStoreDigest: 'b', candidateRegistryDigest: 'r',
    providerEndpointDigest: 'ep', systemPromptDigest: 's', toolsetDigest: 't', generationParametersDigest: 'g',
  },
};
const arm: EvaluationArm = { id: 'a', policy: { kind: 'fixed-candidate', candidateKey: 'scripted/script' }, continuation: 'normal-policy' };
const taskOf = (command: string): PublicTaskSpec => ({
  id: 't', fixtureVersion: '1', workspace: { source: '', baseRevision: 'r', sandbox: 'vm-isolated' }, userRequest: command, budget: { wallTimeMs: 120_000 },
});

describe.skipIf(!available)('host Pi run with tools in a VM', () => {
  let dir: string;
  let factory: VmSandboxFactory;
  let runner: HostPiAgentRunner;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pi8-host-pi-'));
    factory = await vmSandboxFactory({ network: 'none' });
    runner = new HostPiAgentRunner({ repoRoot: dir, vm: factory, extraExtensions: [join(here, 'test-support', 'scripted-model.ts')] });
  }, 120_000);
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  const toolResultText = (sessionPath: string): string =>
    readFileSync(sessionPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { message?: { role?: string; content?: unknown } })
      .filter((entry) => entry.message?.role === 'toolResult').map((entry) => JSON.stringify(entry.message?.content)).join('\n');

  it('runs the bash tool of the model in the guest, with no host variable and no host path', async () => {
    const environment = join(dir, 'environment');
    mkdirSync(environment);
    writeFileSync(join(environment, 'task.txt'), 'public');
    const secret = join(dir, 'host-secret.txt');
    writeFileSync(secret, 'host only');
    process.env.PI8_TEST_HOST_SECRET = 'host-env-secret';
    const command = `uname -r; pwd; echo made > made.txt; env; cat ${secret} 2>&1; cat /etc/os-release | head -1; ls /home`;
    const recipe = wholeTaskRecipe(arm, frozen);
    const out = await runWholeTask({
      runner, sandboxFactory: factory, task: taskOf(command), recipe, arm, environmentPath: environment, runDir: join(dir, 'run'), runId: 'run-1',
    });
    expect(out.result.status).toBe('completed');
    const text = toolResultText(out.files.trajectoryPath!);
    expect(text).toMatch(/-virt/);
    expect(text).toMatch(/Alpine/i);
    expect(text).not.toMatch(/host-env-secret|PI8_TEST_HOST_SECRET|PI8_DIR|PI8_VM_CONFIG|host only/);
    expect(text).toMatch(/No such file/);
    expect(readFileSync(join(out.result.finalArtifact.path, 'made.txt'), 'utf8')).toBe('made\n');
    expect(out.result.servedTarget).toBe('scripted/script');
  }, 180_000);

  it('sends the follow-up prompt in the same session only when the condition holds', async () => {
    const environment = join(dir, 'environment-followup');
    mkdirSync(environment);
    const withFollowUp = new HostPiAgentRunner({
      repoRoot: dir, vm: factory, extraExtensions: [join(here, 'test-support', 'scripted-model.ts')],
      followUp: () => ({ prompt: 'echo second > second.txt', when: (workDir) => !existsSync(join(workDir, 'second.txt')) }),
    });
    const recipe = wholeTaskRecipe(arm, frozen);
    const out = await runWholeTask({
      runner: withFollowUp, sandboxFactory: factory, task: taskOf('echo first > first.txt'), recipe, arm, environmentPath: environment, runDir: join(dir, 'run-followup'), runId: 'run-2',
    });
    expect(out.result.status).toBe('completed');
    expect(readFileSync(join(out.result.finalArtifact.path, 'first.txt'), 'utf8')).toBe('first\n');
    expect(readFileSync(join(out.result.finalArtifact.path, 'second.txt'), 'utf8')).toBe('second\n');
    const session = readFileSync(out.files.trajectoryPath!, 'utf8');
    expect(session.match(/"role":"user"/g)).toHaveLength(2);
  }, 240_000);

  it('rejects a sandbox that is not a VM', async () => {
    const fake = { kind: 'os-isolated-process' } as never;
    await expect(runner.run({ sandbox: fake, task: taskOf('x'), recipe: wholeTaskRecipe(arm, frozen), arm, runDir: dir })).rejects.toThrow(/needs a VM sandbox/);
  });
});
