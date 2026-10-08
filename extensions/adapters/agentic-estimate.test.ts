import { describe, expect, it } from 'vitest';
import { agenticCodingScores, MIN_FIT_ROWS, type AgenticEvidence } from './agentic-estimate.js';

/** Rows where Terminal-Bench follows the older indexes with a known residual. */
function measuredRows(count: number): AgenticEvidence[] {
  return Array.from({ length: count }, (_, i) => {
    const agenticIndex = 10 + i * 2;
    const codingIndex = 30 + (i % 7) * 5;
    const intelligenceIndex = 15 + i * 1.5 + (i % 3) * 2;
    const noise = i % 2 === 0 ? 3 : -3;
    return { agenticIndex, codingIndex, intelligenceIndex, terminalBench: (agenticIndex * 0.8 - 5 + noise) / 100 };
  });
}

describe('agentic coding score', () => {
  it('reads Terminal-Bench 4.0 in percent when the row has a result', () => {
    expect(agenticCodingScores([{ terminalBench: 0.5, agenticIndex: 10 }])).toEqual([{ value: 50, estimated: false }]);
  });

  it('leaves quality unknown without enough rows for a fit', () => {
    const rows = [...measuredRows(MIN_FIT_ROWS - 1), { agenticIndex: 40, codingIndex: 50, intelligenceIndex: 40 }];
    expect(agenticCodingScores(rows).at(-1)).toBeUndefined();
  });

  it('estimates below the fitted value, so an estimate never makes a model stronger than the fit', () => {
    const rows = [...measuredRows(30), { agenticIndex: 40, codingIndex: 50, intelligenceIndex: 40 }];
    const estimate = agenticCodingScores(rows).at(-1)!;
    expect(estimate.estimated).toBe(true);
    // The fit recovers 0.8 * 40 - 5 = 27. The estimate subtracts the leave-one-out error of about 3.
    expect(estimate.value).toBeLessThan(27);
    expect(estimate.value).toBeGreaterThan(20);
  });

  it('uses the agentic index alone when the row has no coding index, and needs the agentic index', () => {
    const rows = [...measuredRows(30), { agenticIndex: 40 }, { codingIndex: 50, intelligenceIndex: 40 }];
    const scores = agenticCodingScores(rows);
    expect(scores.at(-2)?.estimated).toBe(true);
    expect(scores.at(-1)).toBeUndefined();
  });

  it('keeps an estimate in [0, 100]', () => {
    const rows = [...measuredRows(30), { agenticIndex: 1, codingIndex: 30, intelligenceIndex: 15 }, { agenticIndex: 400, codingIndex: 30, intelligenceIndex: 15 }];
    const scores = agenticCodingScores(rows);
    expect(scores.at(-2)?.value).toBe(0);
    expect(scores.at(-1)?.value).toBe(100);
  });
});
