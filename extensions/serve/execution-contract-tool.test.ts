import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { observeTargets } from './execution-contract-tool.js';

describe('observeTargets', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pi8-contract-targets-'));
    writeFileSync(join(dir, 'a.ts'), 'one\ntwo\nthree');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const steps = [
    { kind: 'edit', path: 'a.ts', change: 'x' },
    { kind: 'delete', path: 'gone.ts' },
    { kind: 'create', path: 'new.ts', change: 'y' },
    { kind: 'verify', verifier: 'test' },
  ];

  it('sizes existing targets, counts missing ones, and reads fix commits from the target history', async () => {
    const exec = vi.fn(async () => ({
      stdout: 'fix: race\nfeat: add\nRevert "x"\nbugfix typo\nfeat: debug output\n',
      code: 0,
    }));
    const observed = await observeTargets(exec, dir, steps);
    // A created file is expected not to exist; only the missing delete target counts.
    expect(observed).toEqual({ existingLines: 3, missingTargets: 1, commits: 5, fixCommits: 3 });
    expect(exec).toHaveBeenCalledWith(
      'git',
      ['log', '--since=180.days', '--format=%s', '--', join(dir, 'a.ts'), join(dir, 'gone.ts'), join(dir, 'new.ts')],
      expect.objectContaining({ cwd: dir }),
    );
  });

  it('leaves the history unmeasured when git fails or is unavailable', async () => {
    expect(await observeTargets(async () => ({ stdout: '', code: 128 }), dir, steps))
      .toEqual({ existingLines: 3, missingTargets: 1 });
    expect(await observeTargets(async () => { throw new Error('ENOENT git'); }, dir, steps))
      .toEqual({ existingLines: 3, missingTargets: 1 });
  });

  it('leaves the size unmeasured for a target that is not a regular file, without blocking', async () => {
    const fifo = join(dir, 'pipe.ts');
    execFileSync('mkfifo', [fifo]);
    const exec = async () => ({ stdout: '', code: 0 });
    for (const path of [fifo, '/dev/zero']) {
      const observed = await observeTargets(exec, dir, [{ kind: 'edit', path, change: 'x' }]);
      expect(observed).toEqual({ missingTargets: 0, commits: 0, fixCommits: 0 });
    }
  });

  it('leaves existence unmeasured when a target cannot be checked', async () => {
    const loop = join(dir, 'loop.ts');
    symlinkSync(loop, loop);
    const exec = async () => ({ stdout: '', code: 0 });
    expect(await observeTargets(exec, dir, [{ kind: 'edit', path: loop, change: 'x' }]))
      .toEqual({ commits: 0, fixCommits: 0 });
  });

  it('keeps the file facts and leaves the history unmeasured once the deadline passes', async () => {
    const exec = () => new Promise<{ stdout: string; code: number }>(() => {});
    expect(await observeTargets(exec, dir, steps, undefined, 20)).toEqual({ existingLines: 3, missingTargets: 1 });
  });

  it('measures nothing for an invalid plan', async () => {
    const exec = vi.fn();
    expect(await observeTargets(exec, dir, [{ kind: 'investigate', path: 'a.ts' }])).toEqual({});
    expect(exec).not.toHaveBeenCalled();
  });
});
