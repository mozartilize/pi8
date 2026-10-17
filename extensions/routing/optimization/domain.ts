/**
 * Admissible weight domain of a preference profile.
 *
 * - No substantive answer: exactly `ThetaBase` (simplex + authored bounds).
 * - Answers jointly representable with `ThetaBase`: hard constraints, no slack.
 * - Otherwise: one nonnegative slack per answer, uniform penalty, and the
 *   domain is every point whose total slack is within the minimum plus the
 *   residual tolerance. This is a limit of the linear representation, not a
 *   judgement that the user's answers contradict each other.
 *
 * The domain and its representative weight vector form one immutable
 * artifact keyed by the profile identity. A changed profile never reuses
 * either part of an older artifact.
 */
import { digestOf } from '../digest.js';
import { FEATURE_COUNT, FEATURE_SCHEMA_DIGEST } from '../features/schema.js';
import { compilePreferenceConstraints, type CompiledPreferenceConstraint } from '../preferences/fit.js';
import { CORE_SCENARIOS_V1_DIGEST } from '../preferences/scenarios.js';
import {
  canonicalPreferences,
  preferenceProfileDigest,
  type PreferenceKey,
  type UserRoutingPreferencesV1,
} from '../preferences/schema.js';
import { LP_RESIDUAL_TOLERANCE, lpAnswerProblem, pointProblem, type LPAdapter, type LinearRow, type Polytope } from './lp.js';
import {
  CHOICE_MARGIN,
  EQUIVALENT_TOLERANCE,
  THETA0,
  THETA_BASE_DIGEST,
  THETA_BOUNDS,
  UNIFORM_CONFLICT_SLACK_PENALTY,
} from './weights.js';

export type DomainMode = 'base' | 'hard' | 'min-slack';

export interface ConstraintSlackRange {
  key: PreferenceKey;
  min: number;
  max: number;
}

export interface WeightDomain {
  mode: DomainMode;
  /** Columns 0..9 are theta; later columns are answer slacks. */
  polytope: Polytope;
  constraints: readonly CompiledPreferenceConstraint[];
  /** Minimum total slack; zero unless `mode` is `min-slack`. */
  totalSlack: number;
  /** Per-answer slack range over the domain; only in `min-slack` mode. */
  slackRanges?: readonly ConstraintSlackRange[];
}

export interface DomainArtifact {
  status: 'ready';
  identity: string;
  profileDigest: string;
  domain: WeightDomain;
  /** Full domain point (theta and slacks) of the representative. */
  representativePoint: readonly number[];
  /** Theta part of `representativePoint`. */
  thetaRepresentative: readonly number[];
}

/** Identity of a compiled domain: the profile and every frozen input of the compile. */
export function domainIdentity(profile: UserRoutingPreferencesV1): string {
  return digestOf({
    profile: canonicalPreferences(profile),
    scenarios: CORE_SCENARIOS_V1_DIGEST,
    featureSchema: FEATURE_SCHEMA_DIGEST,
    base: THETA_BASE_DIGEST,
    margin: CHOICE_MARGIN,
    equivalence: EQUIVALENT_TOLERANCE,
    conflictSlackPenalty: UNIFORM_CONFLICT_SLACK_PENALTY,
  });
}

const unit = (size: number, index: number): number[] => {
  const row = new Array<number>(size).fill(0);
  row[index] = 1;
  return row;
};

const pad = (values: readonly number[], size: number): number[] =>
  [...values, ...new Array<number>(size - values.length).fill(0)];

function simplexRow(numCols: number): LinearRow {
  return { coeffs: pad(new Array<number>(FEATURE_COUNT).fill(1), numCols), lower: 1, upper: 1 };
}

export function thetaBasePolytope(): Polytope {
  return {
    numCols: FEATURE_COUNT,
    colLower: THETA_BOUNDS.map(([lower]) => lower),
    colUpper: THETA_BOUNDS.map(([, upper]) => upper),
    rows: [simplexRow(FEATURE_COUNT)],
  };
}

export const thetaBaseDomain = (): WeightDomain => ({ mode: 'base', polytope: thetaBasePolytope(), constraints: [], totalSlack: 0 });

/** Rows of the answers with zero slack. */
function hardRows(constraints: readonly CompiledPreferenceConstraint[]): LinearRow[] {
  return constraints.map((constraint) => constraint.direction === 'equivalent'
    ? { coeffs: constraint.delta, lower: -EQUIVALENT_TOLERANCE, upper: EQUIVALENT_TOLERANCE }
    : { coeffs: constraint.delta, lower: CHOICE_MARGIN });
}

/** Theta plus one slack column per answer. An `equivalent` answer shares one slack between its two sides. */
function slackPolytope(constraints: readonly CompiledPreferenceConstraint[]): Polytope {
  const numCols = FEATURE_COUNT + constraints.length;
  const rows: LinearRow[] = [simplexRow(numCols)];
  constraints.forEach((constraint, index) => {
    const theta = pad(constraint.delta, numCols);
    const plusSlack = theta.slice();
    plusSlack[FEATURE_COUNT + index] = 1;
    if (constraint.direction === 'equivalent') {
      const minusSlack = theta.slice();
      minusSlack[FEATURE_COUNT + index] = -1;
      rows.push({ coeffs: plusSlack, lower: -EQUIVALENT_TOLERANCE });
      rows.push({ coeffs: minusSlack, upper: EQUIVALENT_TOLERANCE });
    } else {
      rows.push({ coeffs: plusSlack, lower: CHOICE_MARGIN });
    }
  });
  return {
    numCols,
    colLower: [...THETA_BOUNDS.map(([lower]) => lower), ...constraints.map(() => 0)],
    colUpper: [...THETA_BOUNDS.map(([, upper]) => upper), ...constraints.map(() => undefined)],
    rows,
  };
}

async function solveOne(lp: LPAdapter, polytope: Polytope, objective: number[], sense: 'max' | 'min') {
  const [result] = await lp.solve({ polytope, objectives: [objective], sense });
  return result!;
}

async function verifiedOptimum(lp: LPAdapter, polytope: Polytope, objective: number[], sense: 'max' | 'min') {
  const result = await solveOne(lp, polytope, objective, sense);
  const problem = lpAnswerProblem(polytope, objective, result);
  if (problem) throw new Error(`domain LP failed: ${problem}`);
  return result as { objective: number; x: number[] };
}

/** Build the admissible domain of a profile. */
export async function compileWeightDomain(profile: UserRoutingPreferencesV1, lp: LPAdapter): Promise<WeightDomain> {
  const constraints = compilePreferenceConstraints(profile);
  if (constraints.length === 0) return thetaBaseDomain();

  const base = thetaBasePolytope();
  const hard: Polytope = { ...base, rows: [...base.rows, ...hardRows(constraints)] };
  const feasibility = await solveOne(lp, hard, new Array<number>(FEATURE_COUNT).fill(0), 'max');
  if (feasibility.status === 'optimal' && !lpAnswerProblem(hard, new Array<number>(FEATURE_COUNT).fill(0), feasibility)) {
    return { mode: 'hard', polytope: hard, constraints, totalSlack: 0 };
  }
  if (feasibility.status !== 'infeasible' && feasibility.status !== 'optimal') {
    throw new Error(`domain feasibility LP failed: status ${feasibility.status}`);
  }

  const soft = slackPolytope(constraints);
  const slackObjective = [...new Array<number>(FEATURE_COUNT).fill(0), ...constraints.map(() => UNIFORM_CONFLICT_SLACK_PENALTY)];
  const minimum = await verifiedOptimum(lp, soft, slackObjective, 'min');
  const totalSlackRow: LinearRow = { coeffs: slackObjective, upper: minimum.objective + LP_RESIDUAL_TOLERANCE };
  const polytope: Polytope = { ...soft, rows: [...soft.rows, totalSlackRow] };
  const slackRanges: ConstraintSlackRange[] = [];
  for (const [index, constraint] of constraints.entries()) {
    const objective = unit(polytope.numCols, FEATURE_COUNT + index);
    const low = await verifiedOptimum(lp, polytope, objective, 'min');
    const high = await verifiedOptimum(lp, polytope, objective, 'max');
    slackRanges.push({ key: constraint.key, min: Math.max(0, low.objective), max: Math.max(0, high.objective) });
  }
  return { mode: 'min-slack', polytope, constraints, totalSlack: minimum.objective, slackRanges };
}

/**
 * The domain point nearest to `THETA0` in L1 distance over theta. Ties are
 * broken lexicographically: minimize theta[0], then theta[1], and so on, each
 * fixed within the residual tolerance. The answer is deterministic.
 */
export async function representativePoint(domain: WeightDomain, lp: LPAdapter): Promise<number[]> {
  const n = domain.polytope.numCols;
  // Columns: domain columns, then one distance column u_j per theta weight.
  const numCols = n + FEATURE_COUNT;
  const rows: LinearRow[] = domain.polytope.rows.map((row) => ({ ...row, coeffs: pad(row.coeffs, numCols) }));
  for (let j = 0; j < FEATURE_COUNT; j++) {
    // u_j >= theta_j - THETA0_j and u_j >= THETA0_j - theta_j
    const above = new Array<number>(numCols).fill(0);
    above[n + j] = 1;
    above[j] = -1;
    rows.push({ coeffs: above, lower: -THETA0[j]! });
    const below = new Array<number>(numCols).fill(0);
    below[n + j] = 1;
    below[j] = 1;
    rows.push({ coeffs: below, lower: THETA0[j]! });
  }
  let polytope: Polytope = {
    numCols,
    colLower: [...domain.polytope.colLower, ...new Array<number>(FEATURE_COUNT).fill(0)],
    colUpper: [...domain.polytope.colUpper, ...new Array<undefined>(FEATURE_COUNT).fill(undefined)],
    rows,
  };
  const distance = pad([], numCols).map((_, column) => (column >= n ? 1 : 0));
  const nearest = await verifiedOptimum(lp, polytope, distance, 'min');
  polytope = { ...polytope, rows: [...polytope.rows, { coeffs: distance, upper: nearest.objective + LP_RESIDUAL_TOLERANCE / 10 }] };
  let point = nearest.x;
  for (let j = 0; j < FEATURE_COUNT; j++) {
    const objective = unit(numCols, j);
    const solved = await verifiedOptimum(lp, polytope, objective, 'min');
    point = solved.x;
    polytope = { ...polytope, rows: [...polytope.rows, { coeffs: objective, upper: solved.objective + LP_RESIDUAL_TOLERANCE / 10 }] };
  }
  return point.slice(0, n);
}

/**
 * A read-only copy of a domain. The selector, the artifact store and the LP
 * worker share one artifact, so no reader can change the domain of another.
 */
function frozenDomain(domain: WeightDomain): WeightDomain {
  const { polytope } = domain;
  return Object.freeze({
    ...domain,
    polytope: Object.freeze({
      numCols: polytope.numCols,
      colLower: Object.freeze([...polytope.colLower]),
      colUpper: Object.freeze([...polytope.colUpper]),
      rows: Object.freeze(polytope.rows.map((row) => Object.freeze({ ...row, coeffs: Object.freeze([...row.coeffs]) }))),
    }) as Polytope,
    constraints: Object.freeze([...domain.constraints]),
    ...(domain.slackRanges ? { slackRanges: Object.freeze([...domain.slackRanges]) } : {}),
  });
}

/** Compile the atomic artifact of a valid profile. */
export async function compileDomainArtifact(profile: UserRoutingPreferencesV1, lp: LPAdapter): Promise<DomainArtifact> {
  const domain = await compileWeightDomain(profile, lp);
  const point = await representativePoint(domain, lp);
  const problem = pointProblem(domain.polytope, point);
  if (problem) throw new Error(`representative weight is not in its domain: ${problem}`);
  return Object.freeze({
    status: 'ready' as const,
    identity: domainIdentity(profile),
    profileDigest: preferenceProfileDigest(profile),
    domain: frozenDomain(domain),
    representativePoint: Object.freeze([...point]),
    thetaRepresentative: Object.freeze(point.slice(0, FEATURE_COUNT)),
  });
}

/**
 * Artifact of a profile with no substantive answer: exact `ThetaBase`. Its
 * representative is `THETA0`, which lies in `ThetaBase`.
 */
export function thetaBaseArtifact(profile: UserRoutingPreferencesV1): DomainArtifact {
  const domain = thetaBaseDomain();
  if (pointProblem(domain.polytope, THETA0)) throw new Error('THETA0 is not in ThetaBase');
  return Object.freeze({
    status: 'ready' as const,
    identity: domainIdentity(profile),
    profileDigest: preferenceProfileDigest(profile),
    domain: frozenDomain(domain),
    representativePoint: Object.freeze([...THETA0]),
    thetaRepresentative: Object.freeze([...THETA0]),
  });
}

/** True when the artifact is ready, matches the profile identity and digest, and its representative is in its domain. */
/**
 * Rebuilds an artifact from parsed JSON. JSON turns an unbounded column bound
 * into `null`. The result is not trusted: `artifactMatches` checks it against
 * the live profile and the polytope before use.
 */
export function reviveDomainArtifact(raw: unknown): DomainArtifact | undefined {
  const value = raw as DomainArtifact | undefined;
  const polytope = value?.domain?.polytope;
  if (value?.status !== 'ready' || !polytope || !Array.isArray(polytope.colLower) || !Array.isArray(polytope.colUpper)) return undefined;
  const open = (bounds: readonly (number | null | undefined)[]) => bounds.map((bound) => bound ?? undefined);
  if (!Array.isArray(polytope.rows) || !Array.isArray(value.representativePoint) || !Array.isArray(value.thetaRepresentative)) return undefined;
  return Object.freeze({
    ...value,
    domain: frozenDomain({ ...value.domain, polytope: { ...polytope, colLower: open(polytope.colLower), colUpper: open(polytope.colUpper) } }),
    representativePoint: Object.freeze([...value.representativePoint]),
    thetaRepresentative: Object.freeze([...value.thetaRepresentative]),
  });
}

export function artifactMatches(artifact: DomainArtifact | undefined, profile: UserRoutingPreferencesV1, expectedProfileDigest: string): artifact is DomainArtifact {
  return artifact?.status === 'ready'
    && artifact.identity === domainIdentity(profile)
    && artifact.profileDigest === expectedProfileDigest
    && preferenceProfileDigest(profile) === expectedProfileDigest
    && pointProblem(artifact.domain.polytope, artifact.representativePoint) === undefined;
}
