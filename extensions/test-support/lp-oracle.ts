/**
 * Independent LP oracles for tests. They share no code with the production
 * solver (HiGHS in a worker):
 *
 * - `oracleSolve`: dense two-phase tableau simplex with Bland's rule.
 * - `greedyBoxSimplexMax`: exact maximum of `c . x` over a box intersected
 *   with `sum x = 1`. Valid only for that domain, with no other rows.
 */
import type { Polytope } from '../routing/optimization/lp.js';

const EPS = 1e-10;

type Sense = '<=' | '>=' | '=';

export interface OracleResult {
  status: 'optimal' | 'infeasible' | 'unbounded';
  x?: number[];
  value?: number;
}

/** Maximize (or minimize) `c . x` over a polytope whose columns all have finite lower bounds. */
export function oracleSolve(polytope: Polytope, c: readonly number[], sense: 'max' | 'min' = 'max'): OracleResult {
  const n = polytope.numCols;
  const lo = polytope.colLower.map((value) => {
    if (value === undefined) throw new Error('oracle needs finite column lower bounds');
    return value;
  });
  // Shift x = y + lo, y >= 0, and list every constraint on y.
  const rows: Array<{ a: number[]; sense: Sense; b: number }> = [];
  polytope.colUpper.forEach((upper, j) => {
    if (upper === undefined) return;
    const a = new Array<number>(n).fill(0);
    a[j] = 1;
    rows.push({ a, sense: '<=', b: upper - lo[j]! });
  });
  for (const row of polytope.rows) {
    const shift = row.coeffs.reduce((sum, value, j) => sum + value * lo[j]!, 0);
    const a = [...row.coeffs];
    if (row.lower !== undefined && row.upper !== undefined && row.lower === row.upper) {
      rows.push({ a, sense: '=', b: row.lower - shift });
      continue;
    }
    if (row.lower !== undefined) rows.push({ a, sense: '>=', b: row.lower - shift });
    if (row.upper !== undefined) rows.push({ a: [...a], sense: '<=', b: row.upper - shift });
  }
  // Nonnegative right-hand sides.
  for (const row of rows) {
    if (row.b < 0) {
      row.a = row.a.map((value) => -value);
      row.b = -row.b;
      row.sense = row.sense === '<=' ? '>=' : row.sense === '>=' ? '<=' : '=';
    }
  }
  const m = rows.length;
  const slackCount = rows.filter((row) => row.sense !== '=').length;
  const artificialCount = rows.filter((row) => row.sense !== '<=').length;
  const cols = n + slackCount + artificialCount;
  const tableau: number[][] = [];
  const basis: number[] = [];
  const artificial = new Set<number>();
  let slackIndex = n;
  let artificialIndex = n + slackCount;
  for (const row of rows) {
    const line = new Array<number>(cols + 1).fill(0);
    row.a.forEach((value, j) => { line[j] = value; });
    line[cols] = row.b;
    if (row.sense === '<=') {
      line[slackIndex] = 1;
      basis.push(slackIndex++);
    } else {
      if (row.sense === '>=') line[slackIndex++] = -1;
      line[artificialIndex] = 1;
      artificial.add(artificialIndex);
      basis.push(artificialIndex++);
    }
    tableau.push(line);
  }

  const pivot = (r: number, k: number) => {
    const factor = tableau[r]![k]!;
    tableau[r] = tableau[r]!.map((value) => value / factor);
    for (let i = 0; i < m; i++) {
      if (i === r) continue;
      const ratio = tableau[i]![k]!;
      if (Math.abs(ratio) < EPS) continue;
      tableau[i] = tableau[i]!.map((value, j) => value - ratio * tableau[r]![j]!);
    }
    basis[r] = k;
  };

  // Maximize cost . vars over columns allowed to enter. Bland's rule prevents cycling.
  const run = (cost: number[], allowed: (j: number) => boolean): 'optimal' | 'unbounded' => {
    for (let iteration = 0; iteration < 100_000; iteration++) {
      let entering = -1;
      for (let j = 0; j < cols; j++) {
        if (!allowed(j) || basis.includes(j)) continue;
        let reduced = -cost[j]!;
        for (let i = 0; i < m; i++) reduced += cost[basis[i]!]! * tableau[i]![j]!;
        if (reduced < -1e-9) { entering = j; break; }
      }
      if (entering < 0) return 'optimal';
      let leaving = -1;
      let best = Infinity;
      for (let i = 0; i < m; i++) {
        const coefficient = tableau[i]![entering]!;
        if (coefficient <= 1e-9) continue;
        const ratio = tableau[i]![cols]! / coefficient;
        if (ratio < best - 1e-12 || (Math.abs(ratio - best) <= 1e-12 && basis[i]! < basis[leaving]!)) {
          best = ratio;
          leaving = i;
        }
      }
      if (leaving < 0) return 'unbounded';
      pivot(leaving, entering);
    }
    throw new Error('oracle simplex did not converge');
  };

  if (artificial.size > 0) {
    const phaseOne = new Array<number>(cols).fill(0);
    for (const j of artificial) phaseOne[j] = -1;
    run(phaseOne, () => true);
    const infeasibility = basis.reduce((sum, j, i) => sum + (artificial.has(j) ? tableau[i]![cols]! : 0), 0);
    if (infeasibility > 1e-7) return { status: 'infeasible' };
    for (let i = 0; i < m; i++) {
      if (!artificial.has(basis[i]!)) continue;
      const k = tableau[i]!.findIndex((value, j) => j < cols && !artificial.has(j) && Math.abs(value) > 1e-9);
      if (k >= 0) pivot(i, k);
    }
  }
  const objective = new Array<number>(cols).fill(0);
  c.forEach((value, j) => { objective[j] = sense === 'max' ? value : -value; });
  if (run(objective, (j) => !artificial.has(j)) === 'unbounded') return { status: 'unbounded' };
  const y = new Array<number>(cols).fill(0);
  basis.forEach((j, i) => { y[j] = tableau[i]![cols]!; });
  const x = lo.map((lower, j) => lower + y[j]!);
  return { status: 'optimal', x, value: c.reduce((sum, value, j) => sum + value * x[j]!, 0) };
}

/** Exact maximum of `c . x` with `lo <= x <= hi` and `sum x = 1`. */
export function greedyBoxSimplexMax(c: readonly number[], bounds: readonly (readonly [number, number])[]): number {
  const x = bounds.map(([lower]) => lower);
  let remaining = 1 - x.reduce((sum, value) => sum + value, 0);
  const order = c.map((value, j) => [value, j] as const).sort((a, b) => b[0] - a[0]);
  for (const [, j] of order) {
    const room = Math.min(remaining, bounds[j]![1] - bounds[j]![0]);
    x[j] = x[j]! + room;
    remaining -= room;
  }
  if (remaining > 1e-12) throw new Error('bounds cannot reach the simplex');
  return c.reduce((sum, value, j) => sum + value * x[j]!, 0);
}
