/**
 * Router measurements of a declared change: the size and history of its
 * targets, how many files name them, the tests and type checker that can
 * check it, and the tools for a visual check. Each measurement that fails or
 * does not finish in time stays undefined: the facts requirement treats it as
 * unknown, never as easy.
 */
import { stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { ChangeMeasurements } from '../routing/policy/change-facts.js';
import { MAX_FACT_ITEMS } from '../routing/policy/change-facts.js';
import { insideCwd } from './context-grounding.js';
import { observeFiles, withDeadline, type Exec } from './execution-contract-tool.js';

/** Every measurement together finishes within this. */
const MEASURE_DEADLINE_MS = 3000;
const GIT_TIMEOUT_MS = 1500;
/** Targets whose fan-in is counted: each costs one `git grep`. */
const MAX_FAN_IN_TARGETS = 5;
/** A shorter file stem matches too many unrelated names to count references. */
const MIN_STEM_LENGTH = 4;
const GENERIC_STEMS = new Set(['index', 'main', 'mod', 'init', '__init__', 'types', 'utils', 'util']);
const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z0-9]+$|_test\.[a-z0-9]+$|(^|\/)test_[^/]+$/i;
const TYPE_CHECKER_FILES = ['tsconfig.json', 'jsconfig.json', 'mypy.ini', 'pyrightconfig.json', 'go.mod', 'Cargo.toml'];
const VISUAL_TOOL = /screenshot|browser|playwright|puppeteer|chrome/i;

export interface ChangeTargets {
  modify: readonly string[];
  create: readonly string[];
}

export interface MeasureInput {
  targets?: ChangeTargets;
  precedent?: string;
  /** Tool names declared to the model. */
  tools?: readonly string[];
  scoutFiles?: number;
  scoutRequests?: number;
}

const stem = (path: string): string => basename(path, extname(path));

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

/** Most tracked files, other than the target itself, that contain a target's stem. */
async function fanIn(exec: Exec, cwd: string, rel: readonly string[], signal?: AbortSignal): Promise<number | undefined> {
  const counted = rel.filter((path) => stem(path).length >= MIN_STEM_LENGTH && !GENERIC_STEMS.has(stem(path).toLowerCase()))
    .slice(0, MAX_FAN_IN_TARGETS);
  if (counted.length === 0) return undefined;
  const counts = await Promise.all(counted.map(async (path) => {
    const result = await exec('git', ['grep', '-l', '-F', '-e', stem(path)], { cwd, timeout: GIT_TIMEOUT_MS, ...(signal ? { signal } : {}) });
    // `git grep` exits 1 when nothing matches.
    if (result.code === 1) return 0;
    if (result.code !== 0) throw new Error('git grep failed');
    return result.stdout.split('\n').filter((line) => line.trim() && line.trim() !== path).length;
  }));
  return Math.max(...counts);
}

/** Tracked test files whose name contains the stem of a target. */
async function coveringTests(exec: Exec, cwd: string, rel: readonly string[], signal?: AbortSignal): Promise<number> {
  const result = await exec('git', ['ls-files'], { cwd, timeout: GIT_TIMEOUT_MS, ...(signal ? { signal } : {}) });
  if (result.code !== 0) throw new Error('git ls-files failed');
  const stems = [...new Set(rel.map(stem).filter((s) => s.length >= MIN_STEM_LENGTH && !GENERIC_STEMS.has(s.toLowerCase())))];
  if (stems.length === 0) return 0;
  return result.stdout.split('\n')
    .filter((file) => TEST_FILE.test(file) && stems.some((s) => basename(file).includes(s)))
    .length;
}

async function measure(exec: Exec, cwd: string, input: MeasureInput, observed: ChangeMeasurements, signal?: AbortSignal): Promise<ChangeMeasurements> {
  if (input.scoutFiles !== undefined) observed.scoutFiles = input.scoutFiles;
  if (input.scoutRequests !== undefined) observed.scoutRequests = input.scoutRequests;
  if (input.tools) observed.visualTool = input.tools.some((name) => VISUAL_TOOL.test(name));
  const inside = (paths: readonly string[] | undefined) => (paths ?? [])
    .map((path) => insideCwd(cwd, path))
    .filter((path): path is { abs: string; rel: string } => path !== undefined)
    .slice(0, MAX_FACT_ITEMS);
  const modify = inside(input.targets?.modify);
  const create = inside(input.targets?.create);
  const all = [...new Map([...modify, ...create].map((path) => [path.abs, path])).values()];
  if (input.targets) {
    observed.files = all.length;
    observed.directories = new Set(all.map((path) => dirname(path.abs))).size;
  }
  const probes: Promise<unknown>[] = [
    Promise.all(TYPE_CHECKER_FILES.map((file) => exists(join(cwd, file))))
      .then((found) => { observed.typeChecker = found.some(Boolean); }),
  ];
  if (input.precedent !== undefined) {
    const precedent = insideCwd(cwd, input.precedent);
    probes.push((precedent ? exists(precedent.abs) : Promise.resolve(false)).then((found) => { observed.precedentExists = found; }));
  }
  if (modify.length > 0) {
    probes.push(observeFiles(exec, cwd, modify.map((path) => path.abs), signal).then((files) => {
      if (files.existingLines !== undefined) observed.existingLines = files.existingLines;
      if (files.missingTargets !== undefined) observed.missingTargets = files.missingTargets;
      if (files.commits !== undefined) observed.commits = files.commits;
      if (files.fixCommits !== undefined) observed.fixCommits = files.fixCommits;
    }));
    probes.push(fanIn(exec, cwd, modify.map((path) => path.rel), signal).then((count) => {
      if (count !== undefined) observed.fanIn = count;
    }));
  }
  if (all.length > 0) {
    probes.push(coveringTests(exec, cwd, all.map((path) => path.rel), signal).then((count) => { observed.coveringTests = count; }));
  }
  // One failed probe leaves only its own measurement undefined.
  await Promise.allSettled(probes);
  return observed;
}

/** Measure a declared change within the deadline; whatever finished in time is kept. */
export function measureChange(
  exec: Exec,
  cwd: string,
  input: MeasureInput,
  signal?: AbortSignal,
  deadlineMs = MEASURE_DEADLINE_MS,
): Promise<ChangeMeasurements> {
  const observed: ChangeMeasurements = {};
  return withDeadline(
    measure(exec, cwd, input, observed, signal).catch(() => ({ ...observed })),
    deadlineMs,
    () => ({ ...observed }),
  );
}
