/**
 * Minimax regret over the admissible weight domain:
 *
 *   PR(a,b) = max_{theta in Theta} theta . (upper(b) - lower(a)),  PR(a,a) = 0
 *   MR(a)   = max_b max(0, PR(a,b))
 *   chosen  = argmin_a MR(a)
 *
 * Independent feature intervals make this a conservative envelope, not a
 * claim that feature errors are physically independent. Ties: smaller
 * regret, then higher nonfinancial continuity, then lower known USD, then
 * canonical key. Pool order never changes the result.
 */
import { FEATURE_COUNT, FEATURE_INDEX, type ActionFeatureVector } from '../features/schema.js';
import { lpAnswerProblem, LpVerificationError, type LPAdapter, type LpRunControls } from './lp.js';
import type { WeightDomain } from './domain.js';
import { LP_RESIDUAL_TOLERANCE, THETA_BOUNDS } from './weights.js';

export interface SelectableAction {
  features: ActionFeatureVector;
  /** Central predicted USD of the next invocation, when the price is known. */
  centralUsd?: number;
}


const continuityOf = (action: SelectableAction): number => action.features.values[FEATURE_INDEX.continuity]!;

/** Tie order after the primary score: continuity, known USD, key. */
function compareTies(a: SelectableAction, b: SelectableAction): number {
  const continuity = continuityOf(b) - continuityOf(a);
  if (Math.abs(continuity) > LP_RESIDUAL_TOLERANCE) return continuity;
  const aUsd = a.centralUsd;
  const bUsd = b.centralUsd;
  if (aUsd !== undefined && bUsd !== undefined && Math.abs(aUsd - bUsd) > 1e-12) return aUsd - bUsd;
  if (aUsd !== undefined && bUsd === undefined) return -1;
  if (aUsd === undefined && bUsd !== undefined) return 1;
  return a.features.key < b.features.key ? -1 : a.features.key > b.features.key ? 1 : 0;
}

export const sortByKey = <T extends SelectableAction>(actions: readonly T[]): T[] =>
  [...actions].sort((a, b) => (a.features.key < b.features.key ? -1 : a.features.key > b.features.key ? 1 : 0));

/** Objective of PR(a,b) over the domain columns: theta part only, zero on slacks. */
export function pairObjective(a: ActionFeatureVector, b: ActionFeatureVector, numCols: number): number[] {
  const objective = new Array<number>(numCols).fill(0);
  for (let j = 0; j < FEATURE_COUNT; j++) objective[j] = b.upper[j]! - a.lower[j]!;
  return objective;
}

export function rankByRegret(actions: readonly SelectableAction[], maxRegret: ReadonlyMap<string, number>): string[] {
  return [...actions]
    .sort((a, b) => {
      const regret = maxRegret.get(a.features.key)! - maxRegret.get(b.features.key)!;
      if (Math.abs(regret) > LP_RESIDUAL_TOLERANCE) return regret;
      return compareTies(a, b);
    })
    .map((action) => action.features.key);
}

const LP_CHUNK = 16;

/**
 * Exact maximum of `c . x` over `THETA_BOUNDS` and `sum x = 1`: fill the
 * weights in descending order of `c`. This is the maximum over ThetaBase, so
 * it bounds the maximum over any admissible domain from above.
 */
export function baseDomainMax(c: readonly number[]): number {
  let remaining = 1 - THETA_BOUNDS.reduce((sum, [lower]) => sum + lower, 0);
  let value = THETA_BOUNDS.reduce((sum, [lower], j) => sum + lower * c[j]!, 0);
  const order = c.map((coefficient, j) => [coefficient, j] as const).sort((a, b) => b[0] - a[0]);
  for (const [coefficient, j] of order) {
    const room = Math.min(remaining, THETA_BOUNDS[j]![1] - THETA_BOUNDS[j]![0]);
    value += coefficient * room;
    remaining -= room;
  }
  return value;
}

const upperDominates = (c: ActionFeatureVector, b: ActionFeatureVector): boolean => {
  let strict = false;
  for (let j = 0; j < FEATURE_COUNT; j++) {
    if (c.upper[j]! < b.upper[j]!) return false;
    if (c.upper[j]! > b.upper[j]!) strict = true;
  }
  // Equal upper vectors: only the smaller key removes the other.
  return strict || c.key < b.key;
};

/**
 * Competitors that can matter. Because theta >= 0, PR(a,b) <= PR(a,c) when
 * upper(c) >= upper(b), so b is skipped for `a` if some other action `c != a`
 * dominates it. The skipped action stays in the pool and the ranking.
 */
function dominators(actions: readonly SelectableAction[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const b of actions) {
    const found: string[] = [];
    for (const c of actions) {
      if (c === b || !upperDominates(c.features, b.features)) continue;
      found.push(c.features.key);
      if (found.length === 2) break;
    }
    result.set(b.features.key, found);
  }
  return result;
}

const skippable = (dominatedBy: ReadonlyMap<string, string[]>, a: string, b: string): boolean =>
  (dominatedBy.get(b) ?? []).some((c) => c !== a);

export interface RegretResult {
  chosen: string;
  /** Exact max regret of every action, by key. */
  maxRegret: ReadonlyMap<string, number>;
  /** Competitor that sets each action's max regret; absent when regret is zero. */
  worstCompetitor: ReadonlyMap<string, string>;
  /** Every action in tie order: best first. */
  ranking: readonly string[];
  /** Number of LP solves; zero when the domain is ThetaBase. */
  lpSolves: number;
}

/**
 * Allowed excess of an LP maximum over the ThetaBase closed form. A verified
 * LP point may break each bound and row by the residual tolerance, so its
 * objective may exceed the true maximum by up to that tolerance times the
 * objective's coefficient mass.
 */
const boundTolerance = (objective: readonly number[]): number =>
  LP_RESIDUAL_TOLERANCE * (1 + objective.reduce((sum, value) => sum + Math.abs(value), 0));

/**
 * Exact minimax regret of every action, so the whole ranking is in regret order.
 *
 * - ThetaBase: closed form, no LP.
 * - Constrained domain: the closed-form ThetaBase value bounds each pair from
 *   above, so competitors are solved in descending bound order and an action
 *   stops once the next bound cannot raise its maximum.
 */
export async function solveMinimaxRegret(
  input: readonly SelectableAction[],
  domain: WeightDomain,
  lp: LPAdapter,
  controls?: LpRunControls,
): Promise<RegretResult> {
  const actions = sortByKey(input);
  if (actions.length === 0) throw new Error('no actions');
  const numCols = domain.polytope.numCols;
  const dominatedBy = dominators(actions);
  const maxRegret = new Map<string, number>();
  const worstCompetitor = new Map<string, string>();
  let lpSolves = 0;

  // Base bound of every competitor of every action, descending.
  const bounded = actions.map((a) => {
    const competitors = actions
      .filter((b) => b !== a && !skippable(dominatedBy, a.features.key, b.features.key))
      .map((b) => ({ b, bound: Math.max(0, baseDomainMax(pairObjective(a.features, b.features, FEATURE_COUNT))) }))
      .sort((x, y) => y.bound - x.bound);
    return { a, competitors, upper: competitors[0]?.bound ?? 0 };
  });

  const finish = (key: string, value: number, competitor: string | undefined) => {
    maxRegret.set(key, value);
    if (competitor !== undefined && value > 0) worstCompetitor.set(key, competitor);
  };

  if (domain.mode === 'base') {
    for (const { a, competitors } of bounded) {
      const top = competitors[0];
      finish(a.features.key, top?.bound ?? 0, top?.b.features.key);
    }
  } else {
    for (const { a, competitors } of bounded) {
      let running = 0;
      let worst: string | undefined;
      let index = 0;
      while (index < competitors.length) {
        if (competitors[index]!.bound <= running + LP_RESIDUAL_TOLERANCE) break;
        const chunk = competitors.slice(index, index + LP_CHUNK);
        const objectives = chunk.map(({ b }) => pairObjective(a.features, b.features, numCols));
        const results = await lp.solve({ polytope: domain.polytope, objectives, sense: 'max' }, controls);
        lpSolves += chunk.length;
        chunk.forEach(({ b, bound }, i) => {
          const result = results[i];
          const problem = result ? lpAnswerProblem(domain.polytope, objectives[i]!, result) : 'missing result';
          if (problem) throw new LpVerificationError(`pair ${a.features.key} vs ${b.features.key}: ${problem}`);
          const regret = Math.max(0, result!.objective!);
          // The domain lies inside ThetaBase, so its maximum cannot exceed the closed form.
          if (regret > bound + boundTolerance(objectives[i]!)) throw new LpVerificationError(`pair ${a.features.key} vs ${b.features.key}: LP above the ThetaBase bound`);
          if (regret > running + LP_RESIDUAL_TOLERANCE) { running = regret; worst = b.features.key; }
        });
        index += chunk.length;
      }
      finish(a.features.key, running, worst);
    }
  }
  const ranking = rankByRegret(actions, maxRegret);
  return { chosen: ranking[0]!, maxRegret, worstCompetitor, ranking, lpSolves };
}

/**
 * Central fallback: the action with the highest `theta . values` under one
 * weight vector, same tie order. This is never minimax regret.
 */
export function centralChoice(input: readonly SelectableAction[], theta: readonly number[]): { chosen: string; ranking: string[]; utility: Map<string, number> } {
  const actions = sortByKey(input);
  const utility = new Map(actions.map((action) => [
    action.features.key,
    action.features.values.reduce((sum, value, j) => sum + value * theta[j]!, 0),
  ]));
  const ranking = [...actions]
    .sort((a, b) => {
      const diff = utility.get(b.features.key)! - utility.get(a.features.key)!;
      if (Math.abs(diff) > LP_RESIDUAL_TOLERANCE) return diff;
      return compareTies(a, b);
    })
    .map((action) => action.features.key);
  return { chosen: ranking[0]!, ranking, utility };
}
