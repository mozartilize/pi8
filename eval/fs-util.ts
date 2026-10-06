import { randomBytes } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Write the file under a temporary name, then rename it. A reader never sees a partial file. */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  renameSync(temp, path);
}

export const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
