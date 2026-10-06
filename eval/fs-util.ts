import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, writeFileSync } from 'node:fs';
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
