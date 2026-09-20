/**
 * Effort-axis quality estimation.
 *
 * A benchmark source publishes rows only for the effort levels it actually
 * measured, so a model can ship `high` and `max` rows while `medium` — a level
 * the model fully supports and Pi will happily serve — has no row at all.
 * Treating such a level as unknown quality costs a usable candidate and makes
 * the fallback chain claim less than the evidence supports, so it is estimated
 * instead.
 *
 * Quality on the effort axis is monotone: more reasoning effort never scores
 * below less on the same model. So a missing level can be estimated from the
 * nearest MEASURED level ABOVE it, minus a per-step drop. Anchoring upward is
 * what keeps the estimate honest — extrapolating above the highest measured
 * row would invent capability that was never observed, while stepping down
 * from an observed row only ever claims less than something already proven.
 *
 * The per-step drop is derived from the store itself (p90 of observed
 * adjacent-level drops, per quality axis) rather than fixed, so it re-tunes on
 * every benchmark sync. p90 rather than the median is deliberate: at the
 * median the estimate lands above the true value about half the time, while at
 * p90 it under-shoots ~90% of the time. An estimate that competes for the pick
 * must be a conservative lower bound on capability, never a flattering guess.
 */
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { BenchModel } from '../../types.js';

const LEVELS: readonly ModelThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

type QualityAxis = 'intelligence' | 'coding' | 'agenticCoding';
const AXES: readonly QualityAxis[] = ['intelligence', 'coding', 'agenticCoding'];

/** Percentile of observed drops used as the per-step estimate. */
const DROP_PERCENTILE = 0.9;

/**
 * Minimum observed adjacent-level pairs before a measured drop is trusted.
 * Below this the sample is too thin to characterize the axis, and the
 * estimator declines rather than extrapolating from noise.
 */
const MIN_SAMPLE = 8;

export type EffortDrops = Partial<Record<QualityAxis, number>>;

interface EstimatedQuality {
  quality: BenchModel['quality'];
  estimated: boolean;
  anchor?: BenchModel;
}

function percentile(sorted: readonly number[], p: number): number {
  const k = (sorted.length - 1) * p;
  const floor = Math.floor(k);
  const ceil = Math.min(floor + 1, sorted.length - 1);
  return sorted[floor]! + (sorted[ceil]! - sorted[floor]!) * (k - floor);
}

/**
 * Per-axis quality drop for one step down the effort ladder, measured across
 * every model in the store that published two or more effort-labelled rows.
 * An axis with too few observations is omitted, which disables estimation for
 * that axis rather than guessing at it.
 */
export function effortDropsPerStep(rows: readonly BenchModel[]): EffortDrops {
  const byModel = new Map<string, Map<ModelThinkingLevel, BenchModel>>();
  for (const row of rows) {
    if (row.effort == null || !LEVELS.includes(row.effort)) continue;
    const perModel = byModel.get(row.registryId) ?? new Map();
    perModel.set(row.effort, row);
    byModel.set(row.registryId, perModel);
  }

  const drops: Record<QualityAxis, number[]> = {
    intelligence: [],
    coding: [],
    agenticCoding: [],
  };
  for (const perModel of byModel.values()) {
    const ordered = [...perModel.entries()].sort(
      (a, b) => LEVELS.indexOf(a[0]) - LEVELS.indexOf(b[0]),
    );
    for (const axis of AXES) {
      // Adjacency is axis-specific: a pricing stub or partial-quality row must
      // not sit between two real measurements and hide their usable drop.
      const measuredOnAxis = ordered.filter(([, row]) => row.quality[axis] != null);
      for (let i = 0; i < measuredOnAxis.length - 1; i++) {
        const [lowerLevel, lower] = measuredOnAxis[i]!;
        const [upperLevel, upper] = measuredOnAxis[i + 1]!;
        const steps = LEVELS.indexOf(upperLevel) - LEVELS.indexOf(lowerLevel);
        drops[axis].push((upper.quality[axis]! - lower.quality[axis]!) / steps);
      }
    }
  }

  const result: EffortDrops = {};
  for (const axis of AXES) {
    const sample = drops[axis];
    if (sample.length < MIN_SAMPLE) continue;
    result[axis] = Math.max(0, percentile([...sample].sort((a, b) => a - b), DROP_PERCENTILE));
  }
  return result;
}

function estimateQuality(
  level: ModelThinkingLevel,
  measured: readonly BenchModel[],
  drops: EffortDrops,
  existing: BenchModel['quality'] = {},
): EstimatedQuality {
  const target = LEVELS.indexOf(level);
  const quality: BenchModel['quality'] = { ...existing };
  if (target < 0) return { quality, estimated: false };

  const above = measured
    .filter((r) => r.effort != null && LEVELS.indexOf(r.effort) > target)
    .sort((a, b) => LEVELS.indexOf(a.effort!) - LEVELS.indexOf(b.effort!));

  let estimated = false;
  let nearestUsedAnchor: BenchModel | undefined;
  for (const axis of AXES) {
    if (quality[axis] != null || drops[axis] == null) continue;
    // Axis coverage can differ between effort rows. Find the nearest row above
    // that actually measured this axis rather than letting a partial row hide
    // usable evidence farther up the ladder.
    const anchor = above.find((r) => r.quality[axis] != null);
    if (!anchor) continue;
    const steps = LEVELS.indexOf(anchor.effort!) - target;
    quality[axis] = Math.max(0, anchor.quality[axis]! - drops[axis]! * steps);
    estimated = true;
    if (
      nearestUsedAnchor == null ||
      LEVELS.indexOf(anchor.effort!) < LEVELS.indexOf(nearestUsedAnchor.effort!)
    ) {
      nearestUsedAnchor = anchor;
    }
  }

  return { quality, estimated, anchor: nearestUsedAnchor };
}

/**
 * Fill missing quality axes on a row measured at `row.effort`. Measured axes
 * and all target-level metadata remain authoritative; only absent axes are
 * conservatively stepped down from the nearest measured row above.
 */
export function completeMeasuredRow(
  row: BenchModel & { effort: ModelThinkingLevel },
  measured: readonly BenchModel[],
  drops: EffortDrops,
): BenchModel | undefined {
  const result = estimateQuality(row.effort, measured, drops, row.quality);
  // Knowledge is measured on its own signed scale and is never estimated, but
  // an effort-labelled knowledge-only row still represents real evidence at
  // that exact level and must remain a distinct routable candidate.
  if (!AXES.some((axis) => result.quality[axis] != null) && result.quality.knowledge == null) {
    return undefined;
  }
  if (!result.estimated) return row;
  return { ...row, quality: result.quality, qualityEstimated: true };
}

/**
 * Estimate the row for `level` from this model's own measured rows. Returns
 * undefined when no measured row sits above the level (nothing to step down
 * from) or when no axis could be estimated.
 */
export function estimateRow(
  level: ModelThinkingLevel,
  measured: readonly BenchModel[],
  drops: EffortDrops,
): BenchModel | undefined {
  const result = estimateQuality(level, measured, drops);
  const anchor = result.anchor;
  if (!result.estimated || !anchor) return undefined;

  return {
    registryId: anchor.registryId,
    benchSlug: anchor.benchSlug,
    active: anchor.active,
    quality: result.quality,
    effort: level,
    qualityEstimated: true,
    // Price is a registry fact and carries across effort levels untouched.
    ...(anchor.priceInputPer1M == null ? {} : { priceInputPer1M: anchor.priceInputPer1M }),
    ...(anchor.priceOutputPer1M == null ? {} : { priceOutputPer1M: anchor.priceOutputPer1M }),
    ...(anchor.contextWindow == null ? {} : { contextWindow: anchor.contextWindow }),
    // Deliberately no costPerTask, outputSpeedTps or latency: those are
    // per-run measurements of a specific effort level, not derivable by
    // stepping down a quality ladder. Absent task cost also keeps an estimated
    // row from silently switching a whole candidate set onto the task-cost
    // basis it has no data for.
    source: anchor.source,
  };
}
