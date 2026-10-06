/**
 * Statistics for the paired comparison. Two rules matter most.
 *
 * 1. A bootstrap is not the bound for a rare event. When every observed event
 *    indicator is zero, a bootstrap gives an upper bound of zero. Rare events
 *    use the exact one-sided Clopper-Pearson bound, which is above zero for
 *    every sample size.
 * 2. A bootstrap of paired differences that are all zero gives an interval
 *    [0, 0]. That interval does not show that the population difference is
 *    zero. The result has `degenerate: true` and the caller must not use it.
 */
import { createHash } from 'node:crypto';

// ── Beta distribution ────────────────────────────────────────────────────

function logGamma(x: number): number {
  const coefficients = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let series = 1.000000000190015;
  for (const coefficient of coefficients) series += coefficient / ++y;
  return -tmp + Math.log((2.5066282746310005 * series) / x);
}

function betaContinuedFraction(a: number, b: number, x: number): number {
  const tiny = 1e-30;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-14) break;
  }
  return h;
}

/** The regularized incomplete beta function: the CDF of Beta(a, b) at x. */
export function betaCdf(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(a, b, x)) / a
    : 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

function betaQuantile(p: number, a: number, b: number): number {
  let low = 0;
  let high = 1;
  for (let step = 0; step < 200; step++) {
    const middle = (low + high) / 2;
    if (betaCdf(middle, a, b) < p) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

/** One-sided upper confidence bound of a rate, from `events` out of `n` independent units. */
export function clopperPearsonUpper(events: number, n: number, confidence: number): number {
  if (n <= 0) throw new RangeError('n must be above zero');
  return events >= n ? 1 : betaQuantile(confidence, events + 1, n - events);
}

/** One-sided lower confidence bound of a rate, from `events` out of `n` independent units. */
export function clopperPearsonLower(events: number, n: number, confidence: number): number {
  if (n <= 0) throw new RangeError('n must be above zero');
  return events <= 0 ? 0 : betaQuantile(1 - confidence, events, n - events + 1);
}

// ── Bootstrap ────────────────────────────────────────────────────────────

/** A deterministic random generator, so the same data and seed give the same bounds. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const seedFromText = (text: string): number => createHash('sha256').update(text).digest().readUInt32BE(0);

export interface BootstrapUnit<T> {
  /** The repository. Units of one cluster resample together when the method uses clusters. */
  cluster: string;
  value: T;
}

export interface BootstrapOptions {
  confidence: number;
  resamples?: number;
  seed: number;
  /** Resample whole clusters instead of single units. */
  clustered: boolean;
}

export interface BootstrapResult {
  estimate: number;
  /** One-sided lower bound at the confidence level. */
  lower: number;
  /** One-sided upper bound at the confidence level. */
  upper: number;
}

function quantile(sorted: readonly number[], probability: number): number {
  const position = Math.min(Math.max(probability, 0), 1) * (sorted.length - 1);
  const below = Math.floor(position);
  const above = Math.ceil(position);
  return (sorted[below] ?? 0) + ((sorted[above] ?? 0) - (sorted[below] ?? 0)) * (position - below);
}

export function bootstrap<T>(units: readonly BootstrapUnit<T>[], statistic: (sample: readonly T[]) => number, options: BootstrapOptions): BootstrapResult {
  if (units.length === 0) throw new RangeError('a bootstrap needs at least one unit');
  const random = seededRandom(options.seed);
  const resamples = options.resamples ?? 2000;
  const clusters = new Map<string, T[]>();
  for (const unit of units) clusters.set(unit.cluster, [...(clusters.get(unit.cluster) ?? []), unit.value]);
  const groups = [...clusters.values()];
  const draws: number[] = [];
  for (let index = 0; index < resamples; index++) {
    const sample: T[] = [];
    if (options.clustered) {
      for (let pick = 0; pick < groups.length; pick++) sample.push(...groups[Math.floor(random() * groups.length)]!);
    } else {
      for (let pick = 0; pick < units.length; pick++) sample.push(units[Math.floor(random() * units.length)]!.value);
    }
    draws.push(statistic(sample));
  }
  draws.sort((a, b) => a - b);
  return {
    estimate: statistic(units.map((unit) => unit.value)),
    lower: quantile(draws, 1 - options.confidence),
    upper: quantile(draws, options.confidence),
  };
}

/**
 * True when every paired difference is zero. The empirical variance is then
 * zero and a bootstrap interval of [0, 0] shows nothing about the population.
 */
export function isDegenerate(differences: readonly number[]): boolean {
  return differences.length === 0 || differences.every((value) => value === differences[0]) && differences[0] === 0;
}

export function percentile(values: readonly number[], probability: number): number | undefined {
  if (values.length === 0) return undefined;
  return quantile([...values].sort((a, b) => a - b), probability);
}
