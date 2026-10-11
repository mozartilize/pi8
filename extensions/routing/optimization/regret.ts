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
import { LP_RESIDUAL_TOLERANCE } from './weights.js';

export interface SelectableAction {
  features: ActionFeatureVector;
  /** Central predicted USD of the next invocation, when the price is known. */
  centralUsd?: number;
}

export interface RegretResult {
  chosen: string;
  /** Max regret of every action, by key. */
  maxRegret: ReadonlyMap<string, number>;
  /** Competitor that sets each action's max regret; absent when regret is zero. */
  worstCompetitor: ReadonlyMap<string, string>;
  /** Actions in tie order: best first. */
  ranking: readonly string[];
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

/** Ordered pairs (a,b), a != b, in canonical key order. */
export function orderedPairs<T extends SelectableAction>(actions: readonly T[]): Array<[T, T]> {
  const pairs: Array<[T, T]> = [];
  for (const a of actions) for (const b of actions) if (a !== b) pairs.push([a, b]);
  return pairs;
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

/** Exact minimax regret with one verified LP per ordered pair. */
export async function solveMinimaxRegret(
  input: readonly SelectableAction[],
  domain: WeightDomain,
  lp: LPAdapter,
  controls?: LpRunControls,
): Promise<RegretResult> {
  const actions = sortByKey(input);
  if (actions.length === 0) throw new Error('no actions');
  const numCols = domain.polytope.numCols;
  const pairs = orderedPairs(actions);
  const objectives = pairs.map(([a, b]) => pairObjective(a.features, b.features, numCols));
  const results = pairs.length > 0 ? await lp.solve({ polytope: domain.polytope, objectives, sense: 'max' }, controls) : [];
  const maxRegret = new Map<string, number>(actions.map((action) => [action.features.key, 0]));
  const worstCompetitor = new Map<string, string>();
  pairs.forEach(([a, b], index) => {
    const result = results[index];
    const problem = result ? lpAnswerProblem(domain.polytope, objectives[index]!, result) : 'missing result';
    if (problem) throw new LpVerificationError(`pair ${a.features.key} vs ${b.features.key}: ${problem}`);
    const regret = Math.max(0, result!.objective!);
    if (regret > maxRegret.get(a.features.key)! + LP_RESIDUAL_TOLERANCE) {
      maxRegret.set(a.features.key, regret);
      worstCompetitor.set(a.features.key, b.features.key);
    }
  });
  const ranking = rankByRegret(actions, maxRegret);
  return { chosen: ranking[0]!, maxRegret, worstCompetitor, ranking };
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
