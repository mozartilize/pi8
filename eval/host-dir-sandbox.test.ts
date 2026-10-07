import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hostDirSandboxAvailable, hostDirSandboxFactory } from './host-dir-sandbox.ts';
import { assertActivationGrade } from './sandbox.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pi8-host-dir-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe.skipIf(!hostDirSandboxAvailable())('host directory sandbox', () => {
  it('hides each hidden path, shows a bind at its run path, and leaves the task output on the host', async () => {
    const workspace = join(dir, 'workspace');
    mkdirSync(workspace);
    writeFileSync(join(workspace, 'task.txt'), 'public');
    const hidden = join(dir, 'store');
    mkdirSync(join(hidden, 'oracle'), { recursive: true });
    writeFileSync(join(hidden, 'oracle', 'hidden.txt'), 'secret');
    const cache = join(hidden, 'cache');
    const factory = hostDirSandboxFactory({ workRoot: join(dir, 'runs'), hiddenPaths: [hidden], binds: { target: cache }, runDirEnv: { CACHE_DIR: 'target' } });
    const sandbox = await factory(workspace);
    try {
      const result = await sandbox.run({
        command: 'sh',
        args: ['-c', `cat task.txt; ls -A ${hidden} | wc -l; echo built > "$CACHE_DIR/out.txt"; echo made > made.txt`],
        timeoutMs: 30_000,
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toBe('public0\n');
      // The bind writes through to its host source, even though the source is under a hidden path.
      expect(readFileSync(join(cache, 'out.txt'), 'utf8')).toBe('built\n');
      // A file that the command writes belongs to the user on the host.
      expect(statSync(join(sandbox.workDir, 'made.txt')).uid).toBe(process.getuid?.());
      expect(readFileSync(join(hidden, 'oracle', 'hidden.txt'), 'utf8')).toBe('secret');
    } finally {
      await sandbox.destroy();
    }
    expect(existsSync(sandbox.workDir)).toBe(false);
    expect(() => assertActivationGrade(sandbox)).toThrow(/read boundary/);
  });

  it('stops a command at its time limit', async () => {
    const factory = hostDirSandboxFactory({ workRoot: join(dir, 'runs'), hiddenPaths: [] });
    const workspace = join(dir, 'workspace');
    mkdirSync(workspace);
    const sandbox = await factory(workspace);
    try {
      const result = await sandbox.run({ command: 'sleep', args: ['30'], timeoutMs: 300 });
      expect(result.timedOut).toBe(true);
    } finally {
      await sandbox.destroy();
    }
  });
});
