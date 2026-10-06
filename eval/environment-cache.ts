/**
 * Cache of public task environments (layer L1). An environment is a public
 * checkout with its dependencies and setup output. A cached environment is
 * immutable. A run copies it into a new writable sandbox, so mutable state and
 * secrets never move from one candidate run to the next.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { digestDirectory, writeJsonAtomic } from './fs-util.ts';
import { digestOf } from './recipe.ts';

export interface EnvironmentKeyV1 {
  baseRevision: string;
  lockfileDigest: string;
  containerImageDigest: string;
  publicSetupDigest: string;
  toolchainDigest: string;
  sandboxProfileDigest: string;
}

export interface ResolvedEnvironment {
  /** Host path of the immutable environment tree. */
  path: string;
  /** Digest of the tree. A recipe uses it as `environmentDigest`. */
  digest: string;
  /** True when the cache already had the environment. */
  hit: boolean;
}

export class EnvironmentCache {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** Return the cached environment. When it is missing, call `build` to fill a staging directory, then store it. */
  async resolve(key: EnvironmentKeyV1, build: (staging: string) => Promise<void>): Promise<ResolvedEnvironment> {
    const keyHash = digestOf(key);
    const home = join(this.dir, 'environments', keyHash);
    const read = (): ResolvedEnvironment | undefined => {
      try {
        const meta = JSON.parse(readFileSync(join(home, 'meta.json'), 'utf8')) as { digest: string };
        return existsSync(join(home, 'tree')) ? { path: join(home, 'tree'), digest: meta.digest, hit: true } : undefined;
      } catch {
        return undefined;
      }
    };
    const cached = read();
    if (cached) return cached;
    const staging = join(this.dir, 'staging', `${keyHash}-${randomBytes(4).toString('hex')}`);
    mkdirSync(join(staging, 'tree'), { recursive: true });
    try {
      await build(join(staging, 'tree'));
      writeJsonAtomic(join(staging, 'meta.json'), { key, digest: digestDirectory(join(staging, 'tree')) });
      mkdirSync(join(this.dir, 'environments'), { recursive: true });
      try {
        renameSync(staging, home);
      } catch {
        // Another process stored the same environment first. Use its copy.
      }
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    const stored = read();
    if (!stored) throw new Error('environment could not be stored');
    return { ...stored, hit: false };
  }

  /** Copy an environment into a new writable directory. */
  materialize(environment: ResolvedEnvironment, destination: string): void {
    cpSync(environment.path, destination, { recursive: true, verbatimSymlinks: true });
  }
}
