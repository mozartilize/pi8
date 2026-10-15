/**
 * Minimax regret over a weight polytope, on numbers only:
 *
 *   PR(a,b) = max_{theta in Theta} theta . (upper(b) - lower(a)),  PR(a,a) = 0
 *   MR(a)   = max_b max(0, PR(a,b))
 *   chosen  = argmin_a MR(a)
 *
 * Independent interval bounds make this a conservative envelope, not a claim
 * that the errors of the bounds are physically independent. This module
 * knows no feature names, benchmarks, cache, work items or preferences: the
 * decision compiler supplies a validated `DecisionProblem`.
 */
import { lpAnswerProblem, LpVerificationError, type LPAdapter, type LpRunControls, type Polytope } from './lp.js';

export interface NumericAction {
  /** Canonical identifier; the last tie key. */
  readonly id: string;
  readonly center: readonly number[];
  readonly lower: readonly number[];
  readonly upper: readonly number[];
  /** One value per tie key of the problem. An absent value orders after every present value. */
  readonly ties: readonly (number | undefined)[];
}

export interface TieKey {
  readonly direction: 'ascending' | 'descending';
  /** Values closer than this compare equal. */
  readonly tolerance: number;
}

/**
 * A validated numerical problem. Actions are sorted by id with unique ids;
 * every vector has `dimension` finite entries in [0, 1] with
 * `lower <= center <= upper`. Base bounds are feasible with `sum(theta) = 1`
 * and nonnegative lower bounds.
 */
export interface DecisionProblem {
  readonly dimension: number;
  readonly actions: readonly NumericAction[];
  readonly baseBounds: readonly (readonly [number, number])[];
  readonly tieKeys: readonly TieKey[];
  /** Residual tolerance of regret and utility comparisons and of LP verification. */
  readonly tolerance: number;
}

/**
 * Admissible weights. Theta columns come first, slack columns after them.
 * `base` means exactly the base bounds and the simplex row, with no slack
 * columns; it is solved in closed form.
 */
export interface NumericDomain {
  readonly mode: string;
  readonly polytope: Polytope;
}

/** Tie order after the primary score: each tie key in order, then id. */
function compareTies(problem: DecisionProblem, a: NumericAction, b: NumericAction): number {
  for (let i = 0; i < problem.tieKeys.length; i++) {
    const { direction, tolerance } = problem.tieKeys[i]!;
    const av = a.ties[i];
    const bv = b.ties[i];
    if (av !== undefined && bv !== undefined) {
      const diff = direction === 'ascending' ? av - bv : bv - av;
      if (Math.abs(diff) > tolerance) return diff;
    } else if (av !== undefined) {
      return -1;
    } else if (bv !== undefined) {
      return 1;
    }
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Objective of PR(a,b) over the domain columns: theta part only, zero on slacks. */
function pairObjective(a: Pick<NumericAction, 'lower'>, b: Pick<NumericAction, 'upper'>, numCols: number): number[] {
  const objective = new Array<number>(numCols).fill(0);
  for (let j = 0; j < a.lower.length; j++) objective[j] = b.upper[j]! - a.lower[j]!;
  return objective;
}

function rankByRegret(problem: DecisionProblem, maxRegret: ReadonlyMap<string, number>): string[] {
  return [...problem.actions]
    .sort((a, b) => {
      const regret = maxRegret.get(a.id)! - maxRegret.get(b.id)!;
      if (Math.abs(regret) > problem.tolerance) return regret;
      return compareTies(problem, a, b);
    })
    .map((action) => action.id);
}

const LP_CHUNK = 16;

/**
 * Exact maximum of `c . x` over the base bounds and `sum x = 1`: fill the
 * weights in descending order of `c`. Every admissible domain lies inside the
 * base bounds, so this bounds its maximum from above.
 */
function baseDomainMax(c: readonly number[], bounds: readonly (readonly [number, number])[]): number {
  let remaining = 1 - bounds.reduce((sum, [lower]) => sum + lower, 0);
  let value = bounds.reduce((sum, [lower], j) => sum + lower * c[j]!, 0);
  const order = c.map((coefficient, j) => [coefficient, j] as const).sort((a, b) => b[0] - a[0]);
  for (const [coefficient, j] of order) {
    const room = Math.min(remaining, bounds[j]![1] - bounds[j]![0]);
    value += coefficient * room;
    remaining -= room;
  }
  return value;
}

const upperDominates = (c: NumericAction, b: NumericAction): boolean => {
  let strict = false;
  for (let j = 0; j < c.upper.length; j++) {
    if (c.upper[j]! < b.upper[j]!) return false;
    if (c.upper[j]! > b.upper[j]!) strict = true;
  }
  // Equal upper vectors: only the smaller id removes the other.
  return strict || c.id < b.id;
};

/**
 * Competitors that can matter. Because theta >= 0, PR(a,b) <= PR(a,c) when
 * upper(c) >= upper(b), so b is skipped for `a` if some other action `c != a`
 * dominates it. The skipped action stays in the pool and the ranking.
 */
function dominators(actions: readonly NumericAction[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const b of actions) {
    const found: string[] = [];
    for (const c of actions) {
      if (c === b || !upperDominates(c, b)) continue;
      found.push(c.id);
      if (found.length === 2) break;
    }
    result.set(b.id, found);
  }
  return result;
}

const skippable = (dominatedBy: ReadonlyMap<string, string[]>, a: string, b: string): boolean =>
  (dominatedBy.get(b) ?? []).some((c) => c !== a);

export interface RegretResult {
  chosen: string;
  /** Exact max regret of every action, by id. */
  maxRegret: ReadonlyMap<string, number>;
  /** Competitor that sets each action's max regret; absent when regret is zero. */
  worstCompetitor: ReadonlyMap<string, string>;
  /** Every action in tie order: best first. */
  ranking: readonly string[];
  /** Number of LP solves; zero in the base domain. */
  lpSolves: number;
}

/**
 * Exact minimax regret of every action, so the whole ranking is in regret order.
 *
 * - Base domain: closed form, no LP.
 * - Constrained domain: the closed-form base value bounds each pair from
 *   above, so competitors are solved in descending bound order and an action
 *   stops once the next bound cannot raise its maximum.
 */
export async function solveMinimaxRegret(
  problem: DecisionProblem,
  domain: NumericDomain,
  lp: LPAdapter,
  controls?: LpRunControls,
): Promise<RegretResult> {
  const { actions, baseBounds, dimension, tolerance } = problem;
  if (actions.length === 0) throw new Error('no actions');
  const numCols = domain.polytope.numCols;
  const dominatedBy = dominators(actions);
  const maxRegret = new Map<string, number>();
  const worstCompetitor = new Map<string, string>();
  let lpSolves = 0;

  // A verified LP point may break each bound and row by the tolerance, so its
  // objective may exceed the true maximum by up to the tolerance times the
  // objective's coefficient mass.
  const boundTolerance = (objective: readonly number[]): number =>
    tolerance * (1 + objective.reduce((sum, value) => sum + Math.abs(value), 0));

  // Base bound of every competitor of every action, descending.
  const bounded = actions.map((a) => {
    const competitors = actions
      .filter((b) => b !== a && !skippable(dominatedBy, a.id, b.id))
      .map((b) => ({ b, bound: Math.max(0, baseDomainMax(pairObjective(a, b, dimension), baseBounds)) }))
      .sort((x, y) => y.bound - x.bound);
    return { a, competitors };
  });

  const finish = (id: string, value: number, competitor: string | undefined) => {
    maxRegret.set(id, value);
    if (competitor !== undefined && value > 0) worstCompetitor.set(id, competitor);
  };

  if (domain.mode === 'base') {
    for (const { a, competitors } of bounded) {
      const top = competitors[0];
      finish(a.id, top?.bound ?? 0, top?.b.id);
    }
  } else {
    for (const { a, competitors } of bounded) {
      let running = 0;
      let worst: string | undefined;
      let index = 0;
      while (index < competitors.length) {
        if (competitors[index]!.bound <= running + tolerance) break;
        const chunk = competitors.slice(index, index + LP_CHUNK);
        const objectives = chunk.map(({ b }) => pairObjective(a, b, numCols));
        const results = await lp.solve({ polytope: domain.polytope, objectives, sense: 'max' }, controls);
        lpSolves += chunk.length;
        chunk.forEach(({ b, bound }, i) => {
          const result = results[i];
          const problemText = result ? lpAnswerProblem(domain.polytope, objectives[i]!, result, tolerance) : 'missing result';
          if (problemText) throw new LpVerificationError(`pair ${a.id} vs ${b.id}: ${problemText}`);
          const regret = Math.max(0, result!.objective!);
          // The domain lies inside the base bounds, so its maximum cannot exceed the closed form.
          if (regret > bound + boundTolerance(objectives[i]!)) throw new LpVerificationError(`pair ${a.id} vs ${b.id}: LP above the base-domain bound`);
          if (regret > running + tolerance) { running = regret; worst = b.id; }
        });
        index += chunk.length;
      }
      finish(a.id, running, worst);
    }
  }
  const ranking = rankByRegret(problem, maxRegret);
  return { chosen: ranking[0]!, maxRegret, worstCompetitor, ranking, lpSolves };
}

/**
 * Central fallback: the action with the highest `theta . center` under one
 * weight vector, same tie order. This is never minimax regret.
 */
export function centralChoice(problem: DecisionProblem, theta: readonly number[]): { chosen: string; ranking: string[]; utility: Map<string, number> } {
  if (theta.length !== problem.dimension) throw new Error(`theta has ${theta.length} weights, the problem has ${problem.dimension} features`);
  const utility = new Map(problem.actions.map((action) => [
    action.id,
    action.center.reduce((sum, value, j) => sum + value * theta[j]!, 0),
  ]));
  const ranking = [...problem.actions]
    .sort((a, b) => {
      const diff = utility.get(b.id)! - utility.get(a.id)!;
      if (Math.abs(diff) > problem.tolerance) return diff;
      return compareTies(problem, a, b);
    })
    .map((action) => action.id);
  return { chosen: ranking[0]!, ranking, utility };
}
