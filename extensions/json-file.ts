import {
  chmodSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

/**
 * Write a JSON value to the given path atomically (temp + rename).
 *
 * The atomic rename guards against partial writes from a single process crash,
 * but concurrent writes from independent Pi processes (two sessions) can still
 * race: a stale-read → write overwrites the other writer's changes. Callers
 * doing read-modify-write on shared state (config, blacklist, profiles) are
 * expected to accept eventual-consistency semantics — this is a single-user
 * local tool, not a distributed database.
 */
export function writeJsonAtomic(path: string, value: unknown, mode?: number): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const temp = `${path}.tmp.${process.pid}.${randomUUID()}`;
  try {
    writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
    if (mode !== undefined) chmodSync(temp, mode);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
