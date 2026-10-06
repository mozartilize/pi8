import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureArtifact } from './runner.ts';
import { assertActivationGrade, type SecureSandbox } from './sandbox.ts';
import { vmSandboxAvailable, vmSandboxFactory } from './vm-sandbox.ts';
import { nodeTestGraderRuntimeDigest, nodeTestOracle } from './oracle.ts';

const available = vmSandboxAvailable();

describe.skipIf(!available)('VM sandbox read boundary', () => {
  let host: string;
  let publicDir: string;
  let sandbox: SecureSandbox;
  let factoryIdentity: string;
  const sentinel = () => join(host, 'store', 'oracle-sentinel.txt');
  const sh = (script: string) => sandbox.run({ command: 'sh', args: ['-c', script], timeoutMs: 30_000 });

  beforeAll(async () => {
    host = mkdtempSync(join(tmpdir(), 'pi8-vm-test-'));
    mkdirSync(join(host, 'store'), { recursive: true });
    writeFileSync(sentinel(), 'private oracle');
    writeFileSync(join(host, 'credential.json'), '{"token":"provider-only"}');
    publicDir = join(host, 'public');
    mkdirSync(publicDir);
    writeFileSync(join(publicDir, 'task.txt'), 'public task');
    symlinkSync(sentinel(), join(publicDir, 'link-to-sentinel'));
    process.env.PI8_TEST_HOST_SECRET = 'host-env-secret';
    const factory = await vmSandboxFactory({ network: 'none' });
    factoryIdentity = factory.identity;
    sandbox = await factory(publicDir);
  }, 120_000);
  afterAll(async () => {
    await sandbox?.destroy();
    rmSync(host, { recursive: true, force: true });
  });

  it('is an activation-grade sandbox that runs the candidate in the task directory', async () => {
    expect(() => assertActivationGrade(sandbox)).not.toThrow();
    expect(sandbox.profileDigest).toBe(factoryIdentity);
    const result = await sh('pwd; cat task.txt; echo changed > made.txt');
    expect(result.stdout.trim()).toBe('/work\npublic task');
    expect(readFileSync(join(sandbox.workDir, 'made.txt'), 'utf8')).toBe('changed\n');
  });

  it('cannot read a known private path, by direct path, by .. traversal, or by symbolic link', async () => {
    for (const script of [`cat ${sentinel()}`, `cat /work/../..${sentinel()}`, 'cat /work/link-to-sentinel', 'cat /work/../../../../../etc/hostname-of-host-not-guest-x']) {
      const result = await sh(script);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/can't open|No such file/);
    }
  });

  it('writes nothing to a host path through a link that the candidate creates', async () => {
    await sh(`ln -s ${sentinel()} planted && echo overwritten > planted; ln -s ../../store deep; echo x > deep/new.txt`);
    expect(readFileSync(sentinel(), 'utf8')).toBe('private oracle');
    expect(existsSync(join(host, 'store', 'new.txt'))).toBe(false);
  });

  it('has no host environment, credential file, home directory, or container socket', async () => {
    const result = await sh('env; ls /home; ls /var/run/docker.sock /run/docker.sock 2>&1');
    expect(result.stdout).not.toMatch(/host-env-secret|PI8_TEST/);
    expect(result.stdout).not.toContain('mozart');
    expect(result.stdout + result.stderr).toMatch(/docker.sock: No such file/);
    expect((await sh(`cat ${join(host, 'credential.json')}`)).code).not.toBe(0);
  });

  it('blocks the network when the list of host names is empty', async () => {
    const result = await sh('wget -T 5 -qO- https://example.com 2>&1; wget -T 5 -qO- http://1.1.1.1 2>&1');
    expect(result.stdout + result.stderr).toMatch(/403|Forbidden|bad address|can't connect|timed out/i);
    expect(result.stdout).not.toMatch(/Example Domain/);
  });

  it('stops a command at the time limit', async () => {
    const result = await sandbox.run({ command: 'sh', args: ['-c', 'sleep 30'], timeoutMs: 1500 });
    expect(result.timedOut).toBe(true);
  });

  it('capture keeps no link that leaves the tree, so a later write cannot pass through it', async () => {
    await sh('mkdir -p keep && echo ok > keep/a.txt && ln -s a.txt keep/inside && ln -s /etc/passwd keep/absolute && ln -s ../../../../x keep/escape ');
    const runDir = mkdtempSync(join(host, 'run-'));
    const artifact = captureArtifact(sandbox.workDir, runDir);
    expect(readlinkSync(join(artifact.path, 'keep', 'inside'))).toBe('a.txt');
    for (const name of ['keep/absolute', 'keep/escape', 'pipe', 'link-to-sentinel', 'planted', 'deep']) {
      expect(() => lstatSync(join(artifact.path, name))).toThrow();
    }
    expect(artifact.droppedEntries).toEqual(expect.arrayContaining(['keep/absolute', 'keep/escape', 'link-to-sentinel']));
  });

  it('runs a private oracle in a fresh VM and gets the same verdict as a host run', async () => {
    const factory = await vmSandboxFactory({ network: 'none' });
    const privateDir = join(host, 'private');
    mkdirSync(privateDir);
    writeFileSync(join(privateDir, 'hidden.test.mjs'), `import { test } from 'node:test'; import assert from 'node:assert/strict'; import { value } from './value.mjs'; test('v', () => assert.equal(value, 2));\n`);
    const oracle = nodeTestOracle({ taskId: 't', oracleVersion: 'v1', privateDir, testFiles: ['hidden.test.mjs'], runIn: factory });
    const artifactOf = (value: number) => {
      const path = join(host, `artifact-${value}`);
      mkdirSync(path);
      writeFileSync(join(path, 'value.mjs'), `export const value = ${value};\n`);
      return { digest: 'd', path, regradeable: true, stateKinds: [] as never[] };
    };
    expect((await oracle.evaluate(artifactOf(2))).verdict).toBe('pass');
    expect((await oracle.evaluate(artifactOf(3))).verdict).toBe('fail');
    expect(nodeTestGraderRuntimeDigest(factory)).not.toBe(nodeTestGraderRuntimeDigest());
  }, 120_000);
});
