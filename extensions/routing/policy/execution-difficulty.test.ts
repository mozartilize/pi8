import { describe, expect, it } from 'vitest';
import type { ExecutionRubric } from '../../types.js';
import {
  declaredRubric,
  isTestPath,
  parseReasoningRubric,
  parseRubric,
} from './execution-difficulty.js';

const EASY: ExecutionRubric = { openDecisions: 1, spread: 1, verification: 1, knowledge: 1, coupling: 1 };
const HARD: ExecutionRubric = { openDecisions: 5, spread: 5, verification: 5, knowledge: 5, coupling: 5 };

describe('rubric parsing', () => {
  it('keeps integer levels 1–5 and counts an unscored criterion as the highest level the requester gave', () => {
    expect(parseRubric({ openDecisions: 2, spread: 1, verification: 3, knowledge: 4, coupling: 5 }))
      .toEqual({ openDecisions: 2, spread: 1, verification: 3, knowledge: 4, coupling: 5 });
    expect(parseRubric({ openDecisions: 0, spread: 2, verification: '1', knowledge: 3 }))
      .toEqual({ openDecisions: 3, spread: 2, verification: 3, knowledge: 3, coupling: 3 });
    // Without a scored criterion there is no rubric.
    expect(parseRubric({ openDecisions: 0, spread: 2.5, verification: '1', knowledge: 6 })).toBeUndefined();
    expect(parseRubric(undefined)).toBeUndefined();
  });

  it('reads the rubric of the declared task type', () => {
    expect(declaredRubric('implement', { remainingWork: EASY, difficulty: { alternatives: 5 } })).toEqual(EASY);
    const reasoning = { alternatives: 1, stakes: 1, spread: 1, knowledge: 1, uncertainty: 1 };
    expect(declaredRubric('plan', { remainingWork: HARD, difficulty: { alternatives: 1 } })).toEqual(reasoning);
    expect(declaredRubric('gather', { remainingWork: HARD, difficulty: { alternatives: 1 } })).toEqual(reasoning);
    expect(declaredRubric('implement', { difficulty: { alternatives: 5 } })).toBeUndefined();
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

describe('reasoning rubric parsing', () => {
  it('counts a missing or invalid level as the highest level the requester gave', () => {
    expect(parseReasoningRubric({ alternatives: 2, stakes: 0, spread: 2.5, knowledge: '3', uncertainty: 3 }))
      .toEqual({ alternatives: 2, stakes: 3, spread: 3, knowledge: 3, uncertainty: 3 });
  });

  it('gives no rubric when no level is valid', () => {
    expect(parseReasoningRubric(undefined)).toBeUndefined();
    expect(parseReasoningRubric({ stakes: 0, spread: 2.5, knowledge: '3' })).toBeUndefined();
  });
});
