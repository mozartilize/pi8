/**
 * Output demand of one action and the output-token forecast of the next
 * invocation.
 *
 * Output demand depends on the model and its effort. AA measures the output
 * tokens (answer and reasoning) of one Intelligence Index task at each effort
 * of a model. This is a benchmark observation, not a forecast of the next
 * invocation, so it moves the forecast only by a bounded amount. Without it a
 * higher effort, or a model that writes more, would gain quality at no cost or
 * time. Spend and latency both read the one forecast.
 */
import type { BenchModel } from '../../types.js';
import { usable } from './mapping.js';
import { isCompatibleIndexVersion } from './benchmark.js';


/**
 * Source of the output-demand prior: `aa-exact` from an AA observation at the
 * action's own effort, `neutral` when no usable observation exists.
 */
export type DemandScaleCode = 'aa-exact' | 'neutral';

/** Why an action has no usable AA output-token observation. */
export type NeutralDemandReason =
  | 'no-row'
  | 'absent'
  | 'invalid'
  | 'conflict'
  | 'unknown-effort'
  | 'source-estimated'
  | 'version-unknown'
  | 'version-incompatible';

/**
 * Dimensionless output-demand multiplier of one action: a central value and
 * the bounds of its envelope, with `low <= center <= high`.
 */
export interface OutputDemandPrior {
  center: number;
  low: number;
  high: number;
  code: DemandScaleCode;
  reason?: NeutralDemandReason;
}

/**
 * Output tokens of the next invocation. Spend and latency both consume this
 * one object, so they always use the same demand.
 */
export interface OutputTokenForecast {
  low: number;
  center: number;
  high: number;
}

export const outputTokenForecast = (prior: OutputDemandPrior): OutputTokenForecast => ({
  low: OUTPUT_TOKENS_MIN * prior.low,
  center: OUTPUT_TOKENS_CENTRAL * prior.center,
  high: OUTPUT_TOKENS_MAX * prior.high,
});

// Output-demand policy. Authored values, not fitted prediction parameters.
// The reference is a fixed rounded anchor near the median AA observation; a
// benchmark refresh does not recompute it. The center keeps the full measured
// ratio between actions: a compressed ratio makes the highest effort of every
// model look almost as cheap as its lower efforts, so it wins most tasks. The
// limits span the observed range (about 0.06 to 6.6) with margin. The
// envelope is the center divided and multiplied by one factor: a benchmark
// task is not the next invocation, and the uncertainty is a ratio with no
// direction. An envelope that always reaches the reference removes the
// worst-case advantage of a terse action only.
const REFERENCE_TOKENS_PER_TASK = 30_000;
const DEMAND_SCALE_MIN = 0.05;
const DEMAND_SCALE_MAX = 12;
const DEMAND_TRANSFER_FACTOR = 2;

/**
 * Prior of an action with no usable observation: a neutral center and an
 * envelope that contains every measured prior, so missing evidence widens the
 * cost and time intervals and gives no advantage.
 */
export const UNKNOWN_DEMAND: OutputDemandPrior = {
  center: 1,
  low: DEMAND_SCALE_MIN / DEMAND_TRANSFER_FACTOR,
  high: DEMAND_SCALE_MAX * DEMAND_TRANSFER_FACTOR,
  code: 'neutral',
};

const neutral = (reason: NeutralDemandReason): OutputDemandPrior => ({ ...UNKNOWN_DEMAND, reason });

/**
 * Output-demand prior of one action from the benchmark row at its served
 * effort (`rowAtServedEffort`). Only an exact-effort AA observation of a row
 * whose Intelligence Index AA did not estimate counts, and only when the page
 * and API index versions are compatible. Another effort or another model
 * never supplies the observation. The envelope of a measured prior is the
 * uncertainty of transferring benchmark-task behavior to the next invocation,
 * not an AA confidence interval.
 */
export function outputDemandPrior(row: BenchModel | undefined, apiIndexVersion: string | undefined): OutputDemandPrior {
  if (!row) return neutral('no-row');
  const provenance = row.outputTokensProvenance;
  if (!provenance) return neutral('absent');
  if (provenance.status !== 'measured') return neutral(provenance.status);
  const tokens = row.outputTokensPerTask;
  if (!usable(tokens)) return neutral('invalid');
  if (provenance.indexVersion === undefined || apiIndexVersion === undefined) return neutral('version-unknown');
  if (!isCompatibleIndexVersion(provenance.indexVersion) || !isCompatibleIndexVersion(apiIndexVersion)) {
    return neutral('version-incompatible');
  }
  const center = Math.min(DEMAND_SCALE_MAX, Math.max(DEMAND_SCALE_MIN, tokens / REFERENCE_TOKENS_PER_TASK));
  return { center, low: center / DEMAND_TRANSFER_FACTOR, high: center * DEMAND_TRANSFER_FACTOR, code: 'aa-exact' };
}

/** Evidence detail of the demand prior that a cost or time feature used. */
export const demandDetail = (demand: OutputDemandPrior): string =>
  demand.reason ? `demand:${demand.code}:${demand.reason}` : `demand:${demand.code}`;

/**
 * Output tokens of one invocation at demand scale 1. Each value is
 * multiplied by the matching bound of the action's output-demand prior
 * (`outputDemandPrior`), so a higher effort, or a model that writes more,
 * costs more and takes longer when AA measured that it does.
 */
export const OUTPUT_TOKENS_CENTRAL = 1024;
export const OUTPUT_TOKENS_MIN = 512;
export const OUTPUT_TOKENS_MAX = 4096;
