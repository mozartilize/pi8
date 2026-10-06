import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EnvironmentCache } from './environment-cache.ts';
import {
  assertActivationGrade, BASE_ETC_ENTRIES, BASE_READ_ONLY_PATHS, createSandbox, sandboxAvailable,
  type PlainWorktree, type SandboxProfile, type SecureSandbox,
} from './sandbox.ts';

const available = await sandboxAvailable();

describe.skipIf(!available)('sandbox read boundary', () => {
  let host: string;
  let publicDir: string;
  let sandbox: SecureSandbox;
  const sentinel = () => join(host, 'store', 'oracle-sentinel.txt');
  const sh = (script: string) => sandbox.run({ command: 'sh', args: ['-c', script], timeoutMs: 20_000 });

  beforeAll(() => {
    host = mkdtempSync(join(tmpdir(), 'pi8-sandbox-test-'));
    mkdirSync(join(host, 'store'), { recursive: true });
    mkdirSync(join(host, 'repo', '.git', 'worktrees', 'x'), { recursive: true });
    writeFileSync(sentinel(), 'private oracle');
    writeFileSync(join(host, 'repo', '.git', 'worktrees', 'x', 'HEAD'), 'ref: refs/heads/main');
    writeFileSync(join(host, 'credential.json'), '{"token":"provider-only"}');
    writeFileSync(join(host, 'other-secret.txt'), 'not listed in the profile');
    publicDir = join(host, 'public');
    mkdirSync(publicDir);
    writeFileSync(join(publicDir, 'task.txt'), 'public task');
    writeFileSync(join(publicDir, '.git'), `gitdir: ${join(host, 'repo', '.git', 'worktrees', 'x')}\n`);
    symlinkSync(sentinel(), join(publicDir, 'link-to-sentinel'));
    const nodeRoot = process.execPath.replace(/\/bin\/node$/, '');
    const profile: SandboxProfile = {
      readOnlyPaths: [...BASE_READ_ONLY_PATHS, nodeRoot],
      etcEntries: BASE_ETC_ENTRIES,
      credentialFiles: [{ from: join(host, 'credential.json'), to: '.pi/agent/auth.json' }],
      env: { PATH: `${nodeRoot}/bin:/usr/bin:/bin` },
      network: 'none',
    };
    process.env.PI8_TEST_HOST_SECRET = 'host-env-secret';
    sandbox = createSandbox(profile, publicDir);
  });
  afterAll(() => {
    sandbox.destroy();
    rmSync(host, { recursive: true, force: true });
  });

  it('runs the candidate in the task directory with the public files', async () => {
    const result = await sh('pwd; cat task.txt; echo changed > made.txt');
    expect(result.stdout).toBe('/work\npublic task');
    expect(readFileSync(join(sandbox.workDir, 'made.txt'), 'utf8')).toBe('changed\n');
  });

  it('cannot read a known private path, by direct path, by .. traversal, or by symbolic link', async () => {
    expect(readFileSync(sentinel(), 'utf8')).toBe('private oracle');
    for (const script of [`cat ${sentinel()}`, `cat /work/../..${sentinel()}`, 'cat /work/link-to-sentinel']) {
      const result = await sh(script);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/No such file/);
      expect(result.stdout).not.toContain('private oracle');
    }
  });

  it('cannot reach the Git common directory that the worktree file names', async () => {
    const result = await sh(`cat ${join(host, 'repo', '.git', 'worktrees', 'x', 'HEAD')}`);
    expect(result.code).not.toBe(0);
    expect((await sh('git -C /work rev-parse --git-dir')).code).not.toBe(0);
  });

  it('has its own home with only the listed credential file, and no host environment', async () => {
    const result = await sh('echo "$HOME"; find /home/eval -type f; env | grep -c PI8_TEST_HOST_SECRET || true; test -e /var/run/docker.sock && echo socket');
    expect(result.stdout).toBe('/home/eval\n/home/eval/.pi/agent/auth.json\n0\n');
    expect((await sh(`cat ${join(host, 'other-secret.txt')}`)).code).not.toBe(0);
  });

  it('keeps the system paths read-only and has no network when the profile says none', async () => {
    expect((await sh('touch /usr/bin/x')).code).not.toBe(0);
    expect((await sh('node -e "require(\'node:dns\').lookup(\'example.com\', (e) => process.exit(e ? 1 : 0))"')).code).not.toBe(0);
  });

  it('stops a process that runs past its time limit', async () => {
    const result = await sandbox.run({ command: 'sleep', args: ['30'], timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
  });
});

describe('activation-grade check', () => {
  it('rejects a plain worktree', () => {
    const plain: PlainWorktree = { kind: 'plain-worktree', workDir: '/tmp/x' };
    expect(() => assertActivationGrade(plain)).toThrow(/no read boundary/);
  });
});

describe('environment cache', () => {
  it('builds once and gives each run its own copy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi8-envcache-'));
    try {
      const cache = new EnvironmentCache(dir);
      const key = { baseRevision: 'r', lockfileDigest: 'l', containerImageDigest: '', publicSetupDigest: 's', toolchainDigest: 't', sandboxProfileDigest: 'p' };
      let builds = 0;
      const build = async (staging: string) => { builds++; writeFileSync(join(staging, 'dep.txt'), 'dependency'); };
      const first = await cache.resolve(key, build);
      const second = await cache.resolve(key, build);
      expect(builds).toBe(1);
      expect([first.hit, second.hit]).toEqual([false, true]);
      expect(second.digest).toBe(first.digest);
      const copy = join(dir, 'run-copy');
      cache.materialize(first, copy);
      writeFileSync(join(copy, 'dep.txt'), 'changed by a run');
      chmodSync(copy, 0o755);
      expect(readFileSync(join(first.path, 'dep.txt'), 'utf8')).toBe('dependency');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
