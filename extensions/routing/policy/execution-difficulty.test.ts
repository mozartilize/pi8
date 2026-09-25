import { describe, expect, it } from 'vitest';
import type { ExecutionRubric, MeasuredFeatures, ReasoningEvidence, ReasoningRubric } from '../../types.js';
import {
  BASE_REQUIREMENT,
  REASONING_BASE_REQUIREMENT,
  REASONING_CRITERIA,
  RUBRIC_CRITERIA,
  bandForRequirement,
  executionRequirement,
  isTestPath,
  parseReasoningRubric,
  parseRubric,
  reasoningMinimum,
  reasoningRequirement,
} from './execution-difficulty.js';
import { FRONTIER_QUALITY_RATIO, pickBest } from '../score/scorer.js';
import { benchRow, candidate } from '../../test-support/router-fixtures.js';

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

  it('never routes a failed measurement cheaper than any successful one', () => {
    const unmeasured: MeasuredFeatures = { files: 1, directories: 1, steps: 2, testTargets: 0 };
    const worstMeasured = { ...QUIET, existingLines: 1e6, fixCommits: 50 };
    for (const rubric of [EASY, { ...EASY, openDecisions: 2 }]) {
      expect(executionRequirement(rubric, unmeasured)).toBeGreaterThanOrEqual(executionRequirement(rubric, worstMeasured));
    }
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

const R_EASY: ReasoningRubric = { alternatives: 1, stakes: 1, spread: 1, knowledge: 1, uncertainty: 1 };
const R_QUIET: ReasoningEvidence = { applicable: true, files: 1, directories: 1, existingLines: 100, commits: 0, fixCommits: 0 };
const CONVERSATION: ReasoningEvidence = { applicable: false, files: 0, directories: 0 };

describe('reasoning requirement', () => {
  it('starts at the reasoning base for an obvious, local, quiet decision', () => {
    expect(reasoningRequirement(R_EASY, R_QUIET)).toBe(REASONING_BASE_REQUIREMENT);
    expect(reasoningRequirement(R_EASY, CONVERSATION)).toBe(REASONING_BASE_REQUIREMENT);
  });

  it('never lowers when any rubric level or measurement rises', () => {
    for (const criterion of REASONING_CRITERIA) {
      for (let level = 2; level <= 5; level += 1) {
        const lower = reasoningRequirement({ ...R_EASY, [criterion]: level - 1 }, R_QUIET);
        expect(reasoningRequirement({ ...R_EASY, [criterion]: level }, R_QUIET)).toBeGreaterThan(lower);
      }
    }
    const base = reasoningRequirement(R_EASY, R_QUIET);
    const raised: Array<Partial<ReasoningEvidence>> = [
      { files: 3 }, { directories: 3 }, { existingLines: 2_000 }, { fixCommits: 3 },
    ];
    for (const over of raised) expect(reasoningRequirement(R_EASY, { ...R_QUIET, ...over })).toBeGreaterThan(base);
  });

  it('never values a failed measurement below any successful one', () => {
    const failed: ReasoningEvidence = { applicable: true, files: 1, directories: 1 };
    const worst = { ...R_QUIET, existingLines: 1e6, fixCommits: 50 };
    expect(reasoningRequirement(R_EASY, failed)).toBeGreaterThanOrEqual(reasoningRequirement(R_EASY, worst));
  });

  it('adds nothing for evidence that is not applicable, whatever its counts', () => {
    const stale: ReasoningEvidence = { applicable: false, files: 9, directories: 9 };
    expect(reasoningRequirement(R_EASY, stale)).toBe(REASONING_BASE_REQUIREMENT);
  });

  it('stays within [base, 1] and caps its minimum at the frontier ratio', () => {
    const hardest = parseReasoningRubric({});
    const requirement = reasoningRequirement(hardest, { applicable: true, files: 20, directories: 20 });
    expect(requirement).toBeLessThanOrEqual(1);
    expect(requirement).toBeGreaterThan(FRONTIER_QUALITY_RATIO);
    expect(reasoningMinimum(requirement)).toBe(FRONTIER_QUALITY_RATIO);
    expect(reasoningMinimum(0.5)).toBe(0.5);
  });

  it('counts missing or invalid levels as the hardest level', () => {
    expect(parseReasoningRubric({ alternatives: 2, stakes: 0, spread: 2.5, knowledge: '3' }))
      .toEqual({ alternatives: 2, stakes: 5, spread: 5, knowledge: 5, uncertainty: 5 });
  });
});

// Snapshot of the hand-set weights against a pool shaped like the allowed
// pool: dense on the plan axis, with price steps of up to 40x. Rewrite this
// table together with the weights when the real pool changes shape.
describe('reasoning minimum against a dense priced pool', () => {
  const model = (id: string, intelligence: number, blendedPrice: number) => candidate(`pool/${id}`, {
    bench: benchRow(`pool/${id}`, { quality: { intelligence, coding: intelligence, agenticCoding: intelligence } }),
    cost: { input: blendedPrice, output: blendedPrice, cacheRead: 0, cacheWrite: 0 },
  });
  const pool = [
    model('luna', 64.8, 0.38),
    model('sonnet', 66.3, 7.6),
    model('flash', 71.0, 2.85),
    model('grok', 80.6, 4.8),
    model('sol', 82.5, 7.6),
    model('astra', 91.5, 38),
    model('opus', 100, 15.2),
  ];
  const winner = (rubric: Partial<ReasoningRubric>) => {
    const minimum = reasoningMinimum(reasoningRequirement({ ...R_EASY, ...rubric }, R_QUIET));
    return pickBest(pool, 'plan', undefined, { estimatedContextTokens: 1_000, handoffMinimum: minimum }).chosen;
  };

  it.each([
    ['all 1', {}, 'pool/luna'],
    ['all 2', { alternatives: 2, stakes: 2, spread: 2, knowledge: 2, uncertainty: 2 }, 'pool/luna'],
    ['alternatives 3', { alternatives: 3 }, 'pool/luna'],
    ['alternatives 3, stakes 4, others 2', { alternatives: 3, stakes: 4, spread: 2, knowledge: 2, uncertainty: 2 }, 'pool/flash'],
    ['all 3', { alternatives: 3, stakes: 3, spread: 3, knowledge: 3, uncertainty: 3 }, 'pool/grok'],
    ['alternatives 4', { alternatives: 4 }, 'pool/grok'],
    ['alternatives 5', { alternatives: 5 }, 'pool/opus'],
  ] as const)('%s → %s', (_label, rubric, expected) => {
    expect(winner(rubric)).toBe(expected);
  });
});
