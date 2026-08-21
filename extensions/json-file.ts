import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

interface JsonCacheEntry {
  mtimeNs: bigint;
  size: bigint;
  parsed: unknown;
}

const jsonCache = new Map<string, JsonCacheEntry>();

/**
 * Read + parse JSON behind an mtime/size guard so repeated same-turn reads of
 * one file skip the syscall + parse. Returns `undefined` when the file is
 * missing; a present-but-corrupt file caches (and returns) `parsed: undefined`
 * so a broken file is not re-read every turn. `writeJsonAtomic` invalidates the
 * path it writes, so in-process writers never observe a stale cache; the
 * mtime/size guard catches external edits wherever the filesystem clock
 * resolves them. Callers re-shape the raw value on every call, so the shared
 * cached parse is never handed out for mutation.
 */
export function readJsonCached(path: string): { parsed: unknown } | undefined {
  let st;
  try {
    st = statSync(path, { bigint: true });
  } catch {
    jsonCache.delete(path);
    return undefined;
  }
  const hit = jsonCache.get(path);
  if (hit && hit.mtimeNs === st.mtimeNs && hit.size === st.size) {
    return { parsed: hit.parsed };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    parsed = undefined;
  }
  jsonCache.set(path, { mtimeNs: st.mtimeNs, size: st.size, parsed });
  return { parsed };
}

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
    jsonCache.delete(path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
