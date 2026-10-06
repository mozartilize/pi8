/**
 * Host-side store of grades. A grade belongs to an execution, an oracle, and a
 * grader runtime. The full key is in the storage path and in the lookup, so a
 * new oracle or a new grader runtime makes a new grade. It never replaces an
 * old grade, and it never answers from a grade that another key made.
 *
 *   grades/<execution-id>/<oracle-digest>/<grader-runtime-digest>.json
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from './fs-util.ts';
import { digestOf } from './recipe.ts';
import type { GradeEvidenceV1, GradeKeyV1 } from './schema.ts';

export interface GradeStore {
  findGrade(key: GradeKeyV1): Promise<GradeEvidenceV1 | undefined>;
  appendGrade(key: GradeKeyV1, grade: GradeEvidenceV1): Promise<void>;
  /** The keys of every grade of one execution. */
  listGradeKeys(executionId: string): Promise<GradeKeyV1[]>;
}

export const gradeIdOf = (key: GradeKeyV1): string => digestOf(key).slice(0, 24);

export class FileGradeStore implements GradeStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private path(key: GradeKeyV1): string {
    return join(this.dir, 'grades', key.executionId, key.oracleDigest, `${key.graderRuntimeDigest}.json`);
  }

  async findGrade(key: GradeKeyV1): Promise<GradeEvidenceV1 | undefined> {
    try {
      const grade = JSON.parse(readFileSync(this.path(key), 'utf8')) as GradeEvidenceV1;
      // A record that carries another key is not a hit.
      const same = grade.key.executionId === key.executionId
        && grade.key.oracleDigest === key.oracleDigest
        && grade.key.graderRuntimeDigest === key.graderRuntimeDigest;
      return same ? grade : undefined;
    } catch {
      // A read failure is a cache miss.
      return undefined;
    }
  }

  async appendGrade(key: GradeKeyV1, grade: GradeEvidenceV1): Promise<void> {
    if (existsSync(this.path(key))) throw new Error('a grade with this key already exists');
    writeJsonAtomic(this.path(key), grade);
  }

  async listGradeKeys(executionId: string): Promise<GradeKeyV1[]> {
    const root = join(this.dir, 'grades', executionId);
    if (!existsSync(root)) return [];
    const keys: GradeKeyV1[] = [];
    for (const oracleDigest of readdirSync(root)) {
      for (const file of readdirSync(join(root, oracleDigest))) {
        if (file.endsWith('.json')) keys.push({ executionId, oracleDigest, graderRuntimeDigest: file.slice(0, -'.json'.length) });
      }
    }
    return keys;
  }
}
