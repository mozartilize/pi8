import { afterAll, describe, expect, it } from 'vitest';

import { FEATURE_COUNT } from '../features/schema.js';
import { checkDomain, compileDecisionProblem, DecisionProblemError, partitionDecisionProblem, type SelectableAction } from './compile.js';
import { thetaBaseDomain } from './domain.js';
import { WorkerLpAdapter, type Polytope } from './lp.js';
import { centralChoice, solveMinimaxRegret, type DecisionProblem, type NumericAction, type NumericDomain } from './minimax.js';

const lp = new WorkerLpAdapter();
afterAll(() => lp.close());

const point = (id: string, values: number[], ties: (number | undefined)[] = []): NumericAction =>
  ({ id, center: values, lower: values, upper: values, ties });

const problem = (actions: NumericAction[], dimension: number, tieKeys: DecisionProblem['tieKeys'] = []): DecisionProblem => ({
  dimension,
  actions: [...actions].sort((a, b) => (a.id < b.id ? -1 : 1)),
  baseBounds: new Array(dimension).fill([0, 1]),
  tieKeys,
  tolerance: 1e-7,
});

const simplex = (dimension: number, numCols: number) =>
  ({ coeffs: Array.from({ length: numCols }, (_, j) => (j < dimension ? 1 : 0)), lower: 1, upper: 1 });

const baseDomain = (dimension: number): NumericDomain => ({
  mode: 'base',
  polytope: { numCols: dimension, colLower: new Array(dimension).fill(0), colUpper: new Array(dimension).fill(1), rows: [simplex(dimension, dimension)] },
});

describe('generic minimax regret, two features', () => {
  // A = (1, 0), B = (0, 1), C = (0.5, 0.5), all exact.
  const actions = [point('A', [1, 0]), point('B', [0, 1]), point('C', [0.5, 0.5])];

  it('base domain: MR(C) = 0.5, MR(A) = MR(B) = 1; ties by id', async () => {
    const result = await solveMinimaxRegret(problem(actions, 2), baseDomain(2), lp);
    expect(result.ranking).toEqual(['C', 'A', 'B']);
    expect(result.maxRegret.get('C')).toBeCloseTo(0.5, 12);
    expect(result.maxRegret.get('A')).toBeCloseTo(1, 12);
    expect(result.maxRegret.get('B')).toBeCloseTo(1, 12);
    expect(result.lpSolves).toBe(0);
  });

  it('constrained domain with a slack column: theta0 - theta1 + s >= 0.5, s <= 0 gives theta0 >= 0.75', async () => {
    const polytope: Polytope = {
      numCols: 3,
      colLower: [0, 0, 0],
      colUpper: [1, 1, 0],
      rows: [simplex(2, 3), { coeffs: [1, -1, 1], lower: 0.5 }],
    };
    const result = await solveMinimaxRegret(problem(actions, 2), { mode: 'min-slack', polytope }, lp);
    // MR(A) = 0, MR(C) = 0.5 (theta = (1, 0) against A), MR(B) = 1.
    expect(result.ranking).toEqual(['A', 'C', 'B']);
    expect(result.maxRegret.get('A')).toBeCloseTo(0, 6);
    expect(result.maxRegret.get('C')).toBeCloseTo(0.5, 6);
    expect(result.maxRegret.get('B')).toBeCloseTo(1, 6);
  });

  it('interval bounds: PR(a, b) uses upper(b) - lower(a)', async () => {
    const wide: NumericAction = { id: 'W', center: [0.5, 0.5], lower: [0.25, 0.5], upper: [0.5, 0.5], ties: [] };
    const exact = point('X', [0.5, 0.5]);
    const result = await solveMinimaxRegret(problem([wide, exact], 2), baseDomain(2), lp);
    // PR(W, X) = max theta . (0.25, 0) = 0.25; PR(X, W) = max theta . (0, 0) = 0.
    expect(result.maxRegret.get('W')).toBeCloseTo(0.25, 12);
    expect(result.maxRegret.get('X')).toBeCloseTo(0, 12);
    expect(result.chosen).toBe('X');
  });
});

describe('generic tie keys, three features', () => {
  const same = [0.2, 0.3, 0.5];
  const keys = [{ direction: 'descending', tolerance: 0.01 }, { direction: 'ascending', tolerance: 0 }] as const;

  it('orders by each key in turn, an absent value last, then id', async () => {
    const actions = [
      point('a', same, [0.5, undefined]),
      point('b', same, [0.505, 2]),   // equal to `a` on key 0 within 0.01
      point('c', same, [0.5, 1]),
      point('d', same, [0.9, 3]),
      point('e', same, [undefined, 0]),
    ];
    const result = await solveMinimaxRegret(problem(actions, 3, keys), baseDomain(3), lp);
    expect(result.ranking).toEqual(['d', 'c', 'b', 'a', 'e']);
    expect(centralChoice(problem(actions, 3, keys), [0.2, 0.3, 0.5]).ranking).toEqual(['d', 'c', 'b', 'a', 'e']);
  });

  it('central choice maximizes theta . center and rejects a theta of another dimension', () => {
    const actions = [point('x', [1, 0, 0]), point('y', [0, 0, 1])];
    expect(centralChoice(problem(actions, 3), [0.1, 0.1, 0.8]).chosen).toBe('y');
    expect(centralChoice(problem(actions, 3), [0.8, 0.1, 0.1]).chosen).toBe('x');
    expect(() => centralChoice(problem(actions, 3), [0.5, 0.5])).toThrow(/2 weights/);
  });
});

describe('decision compiler', () => {
  const vector = (value = 0.5) => new Array<number>(FEATURE_COUNT).fill(value);
  const action = (key: string, patch: Partial<Omit<SelectableAction['features'], 'evidence'>> = {}, centralUsd?: number): SelectableAction => ({
    features: { key, values: vector(), lower: vector(0.4), upper: vector(0.6), evidence: [], ...patch },
    ...(centralUsd === undefined ? {} : { centralUsd }),
  });

  it('copies, sorts and freezes the actions', () => {
    const values = vector();
    const compiled = compileDecisionProblem([action('z', { values }), action('a', {}, 0.1)]);
    values[0] = 0.55;
    expect(compiled.actions.map((a) => a.id)).toEqual(['a', 'z']);
    expect(compiled.actions[1]!.center[0]).toBe(0.5);
    expect(Object.isFrozen(compiled.actions[1]!.center)).toBe(true);
    expect(compiled.actions[0]!.ties).toEqual([0.5, 0.1]);
    expect(compiled.actions[1]!.ties).toEqual([0.5, undefined]);
  });

  it('rejects malformed actions', () => {
    const cases: [SelectableAction[], RegExp][] = [
      [[action('a'), action('a')], /duplicate action a/],
      [[action('a', { values: vector().slice(1) })], /values has 9 features/],
      [[action('a', { lower: [...vector(0.4).slice(1), Number.NaN] })], /not finite/],
      [[action('a', { lower: vector(0.55) })], /not ordered/],
      [[action('a', { upper: vector(1.01) })], /not ordered/],
      [[action('a', { lower: vector(-0.01) })], /not ordered/],
      [[action('a', {}, Number.POSITIVE_INFINITY)], /central USD/],
    ];
    for (const [actions, message] of cases) {
      expect(() => compileDecisionProblem(actions)).toThrow(DecisionProblemError);
      expect(() => compileDecisionProblem(actions)).toThrow(message);
    }
  });

  it('accepts the authored base domain and rejects domains that break base containment', () => {
    const compiled = compileDecisionProblem([action('a')]);
    const base = thetaBaseDomain();
    expect(() => checkDomain(compiled, base)).not.toThrow();
    const polytope = base.polytope;
    const widened = { ...polytope, colUpper: polytope.colUpper.map((u, j) => (j === 0 ? u! + 0.1 : u)) };
    expect(() => checkDomain(compiled, { mode: 'hard', polytope: widened })).toThrow(/upper bound is above/);
    const loosened = { ...polytope, colLower: polytope.colLower.map((l, j) => (j === 1 ? l! - 0.1 : l)) };
    expect(() => checkDomain(compiled, { mode: 'hard', polytope: loosened })).toThrow(/lower bound is below/);
    expect(() => checkDomain(compiled, { mode: 'hard', polytope: { ...polytope, rows: [] } })).toThrow(/simplex/);
    expect(() => checkDomain(compiled, { mode: 'base', polytope: { ...polytope, rows: [...polytope.rows, { coeffs: vector(1), upper: 2 }] } })).toThrow(/base domain differs/);
    const short = { numCols: 2, colLower: [0, 0], colUpper: [1, 1], rows: [] };
    expect(() => checkDomain(compiled, { mode: 'hard', polytope: short })).toThrow(/2 columns/);
  });
});

describe('partitionDecisionProblem', () => {
  const vector = (value = 0.5) => new Array<number>(FEATURE_COUNT).fill(value);
  const action = (key: string, values = vector()): SelectableAction => ({
    features: { key, values, lower: vector(0.4), upper: vector(0.6), evidence: [] },
  });

  it('moves malformed and duplicated actions to `invalid` and keeps the rest', () => {
    const { problem, invalid } = partitionDecisionProblem([
      action('ok'), action('nan', [...vector().slice(1), Number.NaN]), action('dup'), action('dup'),
    ]);
    expect(problem.actions.map((a) => a.id)).toEqual(['ok']);
    expect(invalid.map((entry) => entry.key)).toEqual(['dup', 'nan']);
    expect(invalid[1]!.reason).toMatch(/not finite/);
  });
});
