/**
 * A version of the workspace: a digest of the files that Git does not ignore.
 * It binds a check receipt to the code, tests, and configuration that the run
 * used. It is not the commit and not the runtime environment.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkspaceSnapshot } from '../routing/policy/change-facts.js';
import { withDeadline, type Exec } from './execution-contract-tool.js';

const SNAPSHOT_DEADLINE_MS = 3000;
const GIT_TIMEOUT_MS = 1500;
const MAX_FILES = 3000;
const MAX_BYTES = 16 * 1024 * 1024;

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

async function digestWorkspace(exec: Exec, cwd: string, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
  const listed = await exec('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  });
  if (listed.code !== 0) return { status: 'unavailable', scope: 'git-worktree' };
  const files = [...new Set(listed.stdout.split('\0').filter(Boolean))].sort();
  if (files.length > MAX_FILES) return { status: 'limit', scope: 'git-worktree', files: files.length };
  const all = createHash('sha256');
  let bytes = 0;
  for (const file of files) {
    // A tracked file that was deleted is part of the version, as a marker.
    const body = await readFile(join(cwd, file)).catch(() => undefined);
    if (body) bytes += body.length;
    if (bytes > MAX_BYTES) return { status: 'limit', scope: 'git-worktree', files: files.length };
    all.update(`${file}\0${body ? sha256(body) : '-'}\n`);
  }
  return { status: 'measured', scope: 'git-worktree', digest: all.digest('hex'), files: files.length };
}

/** Digest the workspace within the deadline. A failure never throws; it gives a status without a digest. */
export function snapshotWorkspace(exec: Exec, cwd: string, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
  return withDeadline(
    digestWorkspace(exec, cwd, signal).catch((): WorkspaceSnapshot => ({ status: 'unavailable', scope: 'git-worktree' })),
    SNAPSHOT_DEADLINE_MS,
    (): WorkspaceSnapshot => ({ status: 'timeout', scope: 'git-worktree' }),
  );
}
