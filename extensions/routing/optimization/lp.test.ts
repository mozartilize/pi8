/**
 * The worker LP adapter agrees with independent oracles, rejects answers that
 * fail verification, and enforces a hard deadline by terminating the worker.
 */
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';

import { greedyBoxSimplexMax, oracleSolve } from '../../test-support/lp-oracle.js';
import { thetaBasePolytope } from './domain.js';
import { LpCancelledError, LpTimeoutError, WorkerLpAdapter, lpAnswerProblem, type Polytope } from './lp.js';
import { THETA_BOUNDS } from './weights.js';

const lp = new WorkerLpAdapter();
afterAll(() => lp.close());

// Thousandths keep every input far from the 1e-7 feasibility tolerance that
// both solvers apply; near that tolerance they may disagree legitimately.
const thousandths = (min: number, max: number) => fc.integer({ min: min * 1000, max: max * 1000 }).map((v) => v / 1000);
const objective = fc.array(thousandths(-1, 1), { minLength: 10, maxLength: 10 });

describe('WorkerLpAdapter', () => {
  it('matches the greedy box-simplex maximum on ThetaBase', async () => {
    await fc.assert(fc.asyncProperty(fc.array(objective, { minLength: 1, maxLength: 20 }), async (objectives) => {
      const polytope = thetaBasePolytope();
      const results = await lp.solve({ polytope, objectives, sense: 'max' });
      results.forEach((result, i) => {
        expect(lpAnswerProblem(polytope, objectives[i]!, result)).toBeUndefined();
        expect(result.objective!).toBeCloseTo(greedyBoxSimplexMax(objectives[i]!, THETA_BOUNDS), 7);
      });
    }), { numRuns: 25 });
  });

  it('matches the tableau simplex oracle with extra rows, and agrees on infeasibility', async () => {
    const row = fc.record({
      coeffs: fc.array(thousandths(-1, 1), { minLength: 10, maxLength: 10 }),
      lower: thousandths(-0.2, 0.2),
    });
    await fc.assert(fc.asyncProperty(fc.array(row, { minLength: 1, maxLength: 3 }), objective, async (rows, c) => {
      const base = thetaBasePolytope();
      const polytope: Polytope = { ...base, rows: [...base.rows, ...rows] };
      const [result] = await lp.solve({ polytope, objectives: [c], sense: 'max' });
      const oracle = oracleSolve(polytope, c);
      if (oracle.status === 'infeasible') {
        expect(result!.status).not.toBe('optimal');
      } else {
        expect(lpAnswerProblem(polytope, c, result!)).toBeUndefined();
        expect(result!.objective!).toBeCloseTo(oracle.value!, 6);
      }
    }), { numRuns: 40 });
  });

  it('flags an answer that is outside the polytope or whose objective does not match', () => {
    const polytope = thetaBasePolytope();
    const c = new Array(10).fill(0).map((_, j) => (j === 0 ? 1 : 0));
    const x = [0.45, 0.2, 0.05, 0, 0.3, 0, 0, 0, 0, 0];
    expect(lpAnswerProblem(polytope, c, { status: 'optimal', x, objective: 0.45 })).toBeUndefined();
    expect(lpAnswerProblem(polytope, c, { status: 'optimal', x, objective: 0.46 })).toMatch(/objective/);
    expect(lpAnswerProblem(polytope, c, { status: 'optimal', x: [0.5, ...x.slice(1)], objective: 0.5 })).toMatch(/column 0|row 0/);
    expect(lpAnswerProblem(polytope, c, { status: 'optimal', x: [...x.slice(0, 9), Number.NaN], objective: 0.45 })).toMatch(/finite/);
  });

  it('terminates the worker at the deadline, rejects with a timeout, and serves the next request', async () => {
    const adapter = new WorkerLpAdapter();
    try {
      const polytope = thetaBasePolytope();
      const many = Array.from({ length: 200_000 }, (_, i) => new Array(10).fill(0).map((_, j) => Math.sin(i + j)));
      const started = performance.now();
      await expect(adapter.solve({ polytope, objectives: many, sense: 'max' }, { deadlineAt: started + 150 }))
        .rejects.toBeInstanceOf(LpTimeoutError);
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(adapter.hasWorker).toBe(false);
      const [after] = await adapter.solve({ polytope, objectives: [new Array(10).fill(1)], sense: 'max' });
      expect(after!.objective).toBeCloseTo(1, 9);
    } finally {
      await adapter.close();
    }
  });

  it('terminates on cancellation and rejects with a cancellation error', async () => {
    const adapter = new WorkerLpAdapter();
    try {
      const controller = new AbortController();
      const many = Array.from({ length: 200_000 }, () => new Array(10).fill(0.1));
      const pending = adapter.solve({ polytope: thetaBasePolytope(), objectives: many, sense: 'max' }, { signal: controller.signal });
      setTimeout(() => controller.abort(), 50);
      await expect(pending).rejects.toBeInstanceOf(LpCancelledError);
      expect(adapter.hasWorker).toBe(false);
    } finally {
      await adapter.close();
    }
  });
});
