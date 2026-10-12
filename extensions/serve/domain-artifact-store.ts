/**
 * File store for compiled preference domains, so a new Pi process finds the
 * artifact that `/router-sync` or an earlier run compiled. The identity in the
 * key covers the profile and every frozen input of the compile; the selector
 * checks each artifact against the live profile before it uses it.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveStoragePath } from '../bench/store.js';
import { reviveDomainArtifact, type DomainArtifact } from '../routing/optimization/domain.js';
import type { DomainStore } from '../routing/optimization/select.js';

const FILE = 'domain-artifacts.json';
/** Old profiles are dropped first. */
const MAX_ARTIFACTS = 8;

interface StoredFile {
  version: 1;
  artifacts: Record<string, unknown>;
}

function readFile(path: string): StoredFile {
  try {
    if (!existsSync(path)) return { version: 1, artifacts: {} };
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredFile>;
    return parsed.version === 1 && parsed.artifacts && typeof parsed.artifacts === 'object'
      ? { version: 1, artifacts: parsed.artifacts }
      : { version: 1, artifacts: {} };
  } catch {
    return { version: 1, artifacts: {} };
  }
}

/** The path is resolved on each call, so `PI8_DIR` applies as for the other stores. */
export const fileDomainStore: DomainStore = {
  read(identity: string): DomainArtifact | undefined {
    return reviveDomainArtifact(readFile(join(resolveStoragePath(), FILE)).artifacts[identity]);
  },
  write(artifact: DomainArtifact): void {
    const dir = resolveStoragePath();
    const path = join(dir, FILE);
    const { artifacts } = readFile(path);
    delete artifacts[artifact.identity];
    artifacts[artifact.identity] = artifact;
    for (const key of Object.keys(artifacts).slice(0, Math.max(0, Object.keys(artifacts).length - MAX_ARTIFACTS))) delete artifacts[key];
    mkdirSync(dir, { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, artifacts }));
    renameSync(temporary, path);
  },
};
