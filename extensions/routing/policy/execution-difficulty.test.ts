import { describe, expect, it } from 'vitest';
import type { ExecutionRubric, MeasuredFeatures } from '../../types.js';
import {
  BASE_REQUIREMENT,
  RUBRIC_CRITERIA,
  bandForRequirement,
  executionRequirement,
  isTestPath,
  parseRubric,
} from './execution-difficulty.js';

const EASY: ExecutionRubric = { openDecisions: 1, spread: 1, verification: 1, knowledge: 1, coupling: 1 };
const HARD: ExecutionRubric = { openDecisions: 5, spread: 5, verification: 5, knowledge: 5, coupling: 5 };
const QUIET: MeasuredFeatures = {
  files: 1, directories: 1, steps: 2, testTargets: 0, existingLines: 100, missingTargets: 0, commits: 0, fixCommits: 0,
};

describe('execution requirement', () => {
  it('starts at the economy minimum for fully decided, isolated, quiet work', () => {
    expect(executionRequirement(EASY, QUIET)).toBe(BASE_REQUIREMENT);
  });

  it('never lowers when any rubric level or measurement rises', () => {
    const base = executionRequirement(EASY, QUIET);
    for (const criterion of RUBRIC_CRITERIA) {
      for (let level = 2; level <= 5; level += 1) {
        const lower = executionRequirement({ ...EASY, [criterion]: level - 1 }, QUIET);
        expect(executionRequirement({ ...EASY, [criterion]: level }, QUIET)).toBeGreaterThan(lower);
      }
    }
    const raised: Array<Partial<MeasuredFeatures>> = [
      { files: 3 }, { directories: 3 }, { existingLines: 2_000 }, { fixCommits: 3 },
    ];
    for (const over of raised) expect(executionRequirement(EASY, { ...QUIET, ...over })).toBeGreaterThan(base);
  });

  it('counts a failed measurement as harder than a quiet one', () => {
    const unmeasured: MeasuredFeatures = { files: 1, directories: 1, steps: 2, testTargets: 0 };
    expect(executionRequirement(EASY, unmeasured)).toBeGreaterThan(executionRequirement(EASY, QUIET));
  });

  it('lets open design decisions alone keep the submitter', () => {
    expect(bandForRequirement(executionRequirement({ ...EASY, openDecisions: 5 }, QUIET))).toBe('frontier');
    expect(bandForRequirement(executionRequirement({ ...EASY, openDecisions: 4 }, QUIET))).toBe('strong');
    expect(bandForRequirement(executionRequirement({ ...EASY, openDecisions: 3 }, QUIET))).toBe('standard');
  });

  it('stays within [base, 1]', () => {
    const worst = executionRequirement(HARD, { ...QUIET, files: 12, directories: 12, existingLines: 1e6, fixCommits: 50 });
    expect(worst).toBe(1);
  });

  it('ignores logged-only measurements', () => {
    expect(executionRequirement(EASY, { ...QUIET, commits: 40, testTargets: 2, steps: 12 }))
      .toBe(executionRequirement(EASY, QUIET));
  });
});

describe('rubric parsing', () => {
  it('keeps integer levels 1–5 and counts anything else as the hardest level', () => {
    expect(parseRubric({ openDecisions: 2, spread: 1, verification: 3, knowledge: 4, coupling: 5 }))
      .toEqual({ openDecisions: 2, spread: 1, verification: 3, knowledge: 4, coupling: 5 });
    expect(parseRubric({ openDecisions: 0, spread: 2.5, verification: '1', knowledge: 6 })).toEqual(HARD);
    expect(parseRubric(undefined)).toEqual(HARD);
  });
});

describe('requirement bands', () => {
  it('maps a requirement to the lowest band whose executor minimum covers it', () => {
    expect(bandForRequirement(0.30)).toBe('economy');
    expect(bandForRequirement(0.449)).toBe('economy');
    expect(bandForRequirement(0.45)).toBe('standard');
    expect(bandForRequirement(0.70)).toBe('strong');
    expect(bandForRequirement(0.85)).toBe('frontier');
  });
});

describe('test paths', () => {
  it.each([
    ['src/a.test.ts', true],
    ['src/a.spec.js', true],
    ['pkg/a_test.go', true],
    ['tests/helpers.py', true],
    ['src/__tests__/a.ts', true],
    ['src/latest.ts', false],
    ['src/contest/a.ts', false],
  ])('%s → %s', (path, expected) => {
    expect(isTestPath(path)).toBe(expected);
  });
});
