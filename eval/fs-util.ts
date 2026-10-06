import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Write the file under a temporary name, then rename it. A reader never sees a partial file. */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  renameSync(temp, path);
}

export const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Digest of a directory tree: sorted relative paths, file modes, and file content. Symbolic links count by target. */
export function digestDirectory(root: string, skip: readonly string[] = []): string {
  const hash = createHash('sha256');
  const walk = (relative: string): void => {
    const names = readdirSync(join(root, relative)).sort();
    for (const name of names) {
      const path = relative ? `${relative}/${name}` : name;
      if (skip.includes(path)) continue;
      const full = join(root, path);
      const info = lstatSync(full);
      if (info.isSymbolicLink()) hash.update(`l ${path} ${readlinkSync(full)}\n`);
      else if (info.isDirectory()) {
        hash.update(`d ${path}\n`);
        walk(path);
      } else hash.update(`f ${path} ${info.mode & 0o777} ${createHash('sha256').update(readFileSync(full)).digest('hex')}\n`);
    }
  };
  walk('');
  return hash.digest('hex');
}

export interface FileLockOptions {
  /** A lock file older than this time has expired. */
  expiryMs?: number;
  pollMs?: number;
  waitMs?: number;
}

/** Run `action` while this process holds an exclusive lock file. Several processes can use the same file. */
export async function withFileLock<T>(path: string, action: () => T | Promise<T>, options: FileLockOptions = {}): Promise<T> {
  const { expiryMs = 30_000, pollMs = 10, waitMs = 60_000 } = options;
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      writeFileSync(path, String(process.pid), { flag: 'wx' });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(path).mtimeMs > expiryMs) rmSync(path, { force: true });
      } catch {
        // Another process removed the lock file.
      }
      if (Date.now() > deadline) throw new Error(`lock wait timed out: ${path}`);
      await sleepMs(pollMs);
    }
  }
  try {
    return await action();
  } finally {
    rmSync(path, { force: true });
  }
}
