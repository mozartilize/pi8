import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';

/** Write the file under a temporary name, then rename it. A reader never sees a partial file. */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  renameSync(temp, path);
}

export interface SafeCopyResult {
  /** Entries that the copy left out: a special file, or a link that leaves the tree. */
  dropped: string[];
}

/**
 * Copy a tree that a candidate wrote. The candidate can create any entry in it, so the copy
 * keeps only directories, regular files, and relative links that stay inside the tree. A copy
 * with such links is safe to write into later: no write can pass through a link to a host path.
 * A special file, such as a pipe, would block a plain copy, so it is left out.
 */
export function copyTreeSafely(source: string, destination: string, skipDirectories: readonly string[] = []): SafeCopyResult {
  const dropped: string[] = [];
  mkdirSync(destination, { recursive: true });
  const walk = (relative: string): void => {
    for (const name of readdirSync(join(source, relative)).sort()) {
      const path = relative ? `${relative}/${name}` : name;
      const from = join(source, path);
      const info = lstatSync(from);
      if (info.isDirectory()) {
        if (skipDirectories.includes(name)) continue;
        mkdirSync(join(destination, path), { recursive: true });
        walk(path);
      } else if (info.isFile()) {
        copyFileSync(from, join(destination, path));
      } else if (info.isSymbolicLink()) {
        const target = readlinkSync(from);
        const resolved = normalize(join(dirname(path), target));
        if (isAbsolute(target) || resolved === '..' || resolved.startsWith(`..${sep}`)) dropped.push(path);
        else symlinkSync(target, join(destination, path));
      } else dropped.push(path);
    }
  };
  walk('');
  return { dropped };
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
