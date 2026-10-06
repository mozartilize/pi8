/**
 * Append-only store of execution evidence. It is outside every candidate sandbox.
 *
 *   recipes/<recipe-hash>.json
 *   executions/<recipe-hash>/<replicate>/<execution-id>/{manifest,result,usage}.json
 *   executions/<recipe-hash>/<replicate>/<execution-id>/{trajectory.jsonl,artifact/}
 *   operational/<recipe-hash>/<replicate>/<id>.json      failed attempts. They are not evidence.
 *   locks/<recipe-hash>-<replicate>.lock
 *
 * A later execution can fill the same slot, for example when the freshness rule
 * needs a new generation. It never replaces an older record. A report chooses
 * one generation for each slot. A slot is never two observations.
 */
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { chooseGeneration, isCompatible, isEvidenceStatus } from './freshness.ts';
import { sleepMs, writeJsonAtomic } from './fs-util.ts';
import { hashRecipe } from './recipe.ts';
import type {
  CompletedExecutionV1,
  EvidenceSelectionPolicy,
  ExecutionEvidenceV1,
  ExecutionRecipeV1,
  ExecutionRequestV1,
  ExecutionSlotKey,
} from './schema.ts';

export interface EvidenceLease {
  release(): Promise<void>;
}

export interface ExecutionFiles {
  trajectoryPath?: string;
  decisionLogPath?: string;
}

export interface ExecutionEvidenceStore {
  listCompatible(slot: ExecutionSlotKey, recipe: ExecutionRecipeV1, policy: EvidenceSelectionPolicy): Promise<ExecutionEvidenceV1[]>;
  selectOne(slot: ExecutionSlotKey, recipe: ExecutionRecipeV1, policy: EvidenceSelectionPolicy): Promise<ExecutionEvidenceV1 | undefined>;
  acquireLease(slot: ExecutionSlotKey): Promise<EvidenceLease>;
  appendExecution(
    slot: ExecutionSlotKey,
    recipe: ExecutionRecipeV1,
    result: CompletedExecutionV1,
    files?: ExecutionFiles,
  ): Promise<ExecutionEvidenceV1>;
  /** Store a failed attempt apart from the slot. It is not evidence, and it never fills the slot. */
  recordOperationalAttempt(slot: ExecutionSlotKey, result: CompletedExecutionV1): Promise<void>;
}

export interface FileStoreOptions {
  /** A lease older than this time is past its expiry. Another process can remove it. */
  leaseExpiryMs?: number;
  /** The time that `acquireLease` waits before it stops. */
  leaseWaitMs?: number;
  pollMs?: number;
  now?: () => number;
}

interface LeaseOwner {
  pid: number;
  host: string;
  startedAt: number;
  token: string;
}

/** The default location of the store. */
export function defaultEvalDir(): string {
  return process.env.PI8_EVAL_DIR ?? join(process.env.HOME ?? '.', '.pi', 'agent', 'pi8-eval');
}

export class FileEvidenceStore implements ExecutionEvidenceStore {
  readonly dir: string;
  private readonly leaseExpiryMs: number;
  private readonly leaseWaitMs: number;
  private readonly pollMs: number;
  private readonly now: () => number;

  constructor(dir: string, options: FileStoreOptions = {}) {
    this.dir = dir;
    this.leaseExpiryMs = options.leaseExpiryMs ?? 30 * 60_000;
    this.leaseWaitMs = options.leaseWaitMs ?? 60 * 60_000;
    this.pollMs = options.pollMs ?? 200;
    this.now = options.now ?? Date.now;
  }

  private slotDir(slot: ExecutionSlotKey): string {
    return join(this.dir, 'executions', slot.recipeHash, String(slot.replicate));
  }

  private lockPath(slot: ExecutionSlotKey): string {
    return join(this.dir, 'locks', `${slot.recipeHash}-${slot.replicate}.lock`);
  }

  /** Read every generation of a slot, oldest first. A read failure is a cache miss. It is not an error. */
  private readGenerations(slot: ExecutionSlotKey): ExecutionEvidenceV1[] {
    const root = this.slotDir(slot);
    let names: string[];
    try {
      names = readdirSync(root).sort();
    } catch {
      return [];
    }
    const found: ExecutionEvidenceV1[] = [];
    for (const name of names) {
      try {
        found.push(JSON.parse(readFileSync(join(root, name, 'manifest.json'), 'utf8')) as ExecutionEvidenceV1);
      } catch {
        // A generation that cannot be read is not evidence.
      }
    }
    return found;
  }

  async listCompatible(slot: ExecutionSlotKey, recipe: ExecutionRecipeV1, policy: EvidenceSelectionPolicy): Promise<ExecutionEvidenceV1[]> {
    if (hashRecipe(recipe) !== slot.recipeHash) return [];
    const now = this.now();
    return this.readGenerations(slot).filter((evidence) => isCompatible(evidence, policy, now));
  }

  async selectOne(slot: ExecutionSlotKey, recipe: ExecutionRecipeV1, policy: EvidenceSelectionPolicy): Promise<ExecutionEvidenceV1 | undefined> {
    return chooseGeneration(await this.listCompatible(slot, recipe, policy), policy);
  }

  async acquireLease(slot: ExecutionSlotKey): Promise<EvidenceLease> {
    const path = this.lockPath(slot);
    mkdirSync(join(this.dir, 'locks'), { recursive: true });
    const owner: LeaseOwner = { pid: process.pid, host: hostname(), startedAt: this.now(), token: randomBytes(8).toString('hex') };
    const deadline = this.now() + this.leaseWaitMs;
    for (;;) {
      try {
        writeFileSync(path, JSON.stringify(owner), { flag: 'wx' });
        return {
          release: async () => {
            // Remove the file only when this process owns it.
            try {
              const current = JSON.parse(readFileSync(path, 'utf8')) as LeaseOwner;
              if (current.token === owner.token) rmSync(path, { force: true });
            } catch {
              // The lease does not exist.
            }
          },
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      if (this.isLeaseExpired(path)) {
        // Rename the file first. When several processes find the same expired lease, only one rename succeeds.
        const expired = `${path}.expired.${randomBytes(4).toString('hex')}`;
        try {
          renameSync(path, expired);
          rmSync(expired, { force: true });
        } catch {
          // Another process already removed it.
        }
        continue;
      }
      if (this.now() > deadline) throw new Error(`lease wait timed out for ${slot.recipeHash}#${slot.replicate}`);
      await sleepMs(this.pollMs);
    }
  }

  private isLeaseExpired(path: string): boolean {
    try {
      const owner = JSON.parse(readFileSync(path, 'utf8')) as LeaseOwner;
      if (this.now() - owner.startedAt > this.leaseExpiryMs) return true;
      if (owner.host === hostname()) {
        try {
          process.kill(owner.pid, 0);
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === 'ESRCH';
        }
      }
      return false;
    } catch {
      // A lease file that no one can read expires when it is older than the expiry time.
      try {
        return this.now() - statSync(path).mtimeMs > this.leaseExpiryMs;
      } catch {
        return false;
      }
    }
  }

  async recordOperationalAttempt(slot: ExecutionSlotKey, result: CompletedExecutionV1): Promise<void> {
    writeJsonAtomic(join(this.dir, 'operational', slot.recipeHash, String(slot.replicate), `${this.now()}-${randomBytes(4).toString('hex')}.json`), { slot, result });
  }

  async appendExecution(
    slot: ExecutionSlotKey,
    recipe: ExecutionRecipeV1,
    result: CompletedExecutionV1,
    files: ExecutionFiles = {},
  ): Promise<ExecutionEvidenceV1> {
    if (hashRecipe(recipe) !== slot.recipeHash) throw new Error('recipe does not match the slot');
    if (!isEvidenceStatus(result.status)) {
      await this.recordOperationalAttempt(slot, result);
      throw new Error(`${result.status} is an operational failure, not execution evidence`);
    }
    writeJsonAtomic(join(this.dir, 'recipes', `${slot.recipeHash}.json`), recipe);
    const executionId = `${slot.recipeHash.slice(0, 12)}-${slot.replicate}-${this.now().toString(36)}-${randomBytes(4).toString('hex')}`;
    const finalDir = join(this.slotDir(slot), executionId);
    if (existsSync(finalDir)) throw new Error('execution record already exists');
    // Write the record in a staging directory, then rename the directory. A reader never sees a partial record.
    const staging = join(this.dir, 'staging', executionId);
    mkdirSync(staging, { recursive: true });
    const artifactSource = result.finalArtifact.path;
    let artifact = result.finalArtifact;
    if (artifactSource && existsSync(artifactSource)) {
      cpSync(artifactSource, join(staging, 'artifact'), { recursive: true });
      // The path names the final place of the artifact, so a later grade can read it.
      artifact = { ...artifact, path: join(finalDir, 'artifact') };
    }
    if (files.trajectoryPath && existsSync(files.trajectoryPath)) cpSync(files.trajectoryPath, join(staging, 'trajectory.jsonl'));
    if (files.decisionLogPath && existsSync(files.decisionLogPath)) cpSync(files.decisionLogPath, join(staging, 'decisions.jsonl'));
    const evidence: ExecutionEvidenceV1 = {
      ...result,
      finalArtifact: artifact,
      executionId,
      slot,
      recipeHash: slot.recipeHash,
      recipe,
    };
    writeJsonAtomic(join(staging, 'manifest.json'), evidence);
    writeJsonAtomic(join(staging, 'usage.json'), result.rawUsage);
    writeJsonAtomic(join(staging, 'result.json'), { status: result.status, wallTimeMs: result.wallTimeMs });
    mkdirSync(this.slotDir(slot), { recursive: true });
    renameSync(staging, finalDir);
    return evidence;
  }
}

export interface GetOrExecuteResult {
  evidence: ExecutionEvidenceV1;
  /** True when a stored execution answered the request and no execution ran. */
  reused: boolean;
}

/**
 * Select a stored execution. When none exists, run the recipe one time. A lease
 * stops two sessions from paying for the same slot. After the wait, select
 * again with the same frozen policy, because another process can finish while
 * this process waits.
 */
export async function getOrExecute(
  store: ExecutionEvidenceStore,
  request: ExecutionRequestV1,
  policy: EvidenceSelectionPolicy,
  executeRecipe: (request: ExecutionRequestV1) => Promise<{ result: CompletedExecutionV1; files?: ExecutionFiles }>,
): Promise<GetOrExecuteResult> {
  const slot: ExecutionSlotKey = { recipeHash: hashRecipe(request.recipe), replicate: request.replicate };
  const cached = await store.selectOne(slot, request.recipe, policy);
  if (cached) return { evidence: cached, reused: true };
  const lease = await store.acquireLease(slot);
  try {
    const afterWait = await store.selectOne(slot, request.recipe, policy);
    if (afterWait) return { evidence: afterWait, reused: true };
    const { result, files } = await executeRecipe(request);
    return { evidence: await store.appendExecution(slot, request.recipe, result, files), reused: false };
  } finally {
    await lease.release();
  }
}
