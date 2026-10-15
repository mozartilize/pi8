/**
 * Time feature of one next invocation: the output-token forecast at the
 * model's measured output speed. An unknown speed gives the common feature
 * interval.
 */
import type { BenchModel } from '../../types.js';
import { clamp01, usable } from './mapping.js';
import type { Interval } from './schema.js';
import { demandDetail, outputTokenForecast, UNKNOWN_DEMAND, type OutputDemandPrior, type OutputTokenForecast } from './output-demand.js';
import { FEATURE_MAPPING_VERSION, type FeatureEvidence } from './schema.js';

export function timeFeature(
  row: BenchModel | undefined,
  demand: OutputDemandPrior = UNKNOWN_DEMAND,
  output: OutputTokenForecast = outputTokenForecast(demand),
): { interval: Interval; evidence: FeatureEvidence } {
  const tps = row?.outputSpeedTps;
  if (!usable(tps) || tps === 0) {
    return {
      interval: { center: SPEED_UNKNOWN_VALUE, lower: 0, upper: 1 },
      evidence: { feature: 'timeDesirability', code: 'speed-unknown', mapping: FEATURE_MAPPING_VERSION },
    };
  }
  return {
    interval: {
      center: timeDesirability(latencyProxySeconds(output.center, tps)),
      lower: timeDesirability(latencyProxySeconds(output.high, tps)),
      upper: timeDesirability(latencyProxySeconds(output.low, tps)),
    },
    evidence: { feature: 'timeDesirability', code: 'speed-known', mapping: FEATURE_MAPPING_VERSION, details: [demandDetail(demand)] },
  };
}

/** Fixed per-invocation overhead of the latency proxy, seconds. */
export const LATENCY_OVERHEAD_SECONDS = 2;
export const TIME_SHAPE_SECONDS = 5;
export const TIME_SATURATION_SECONDS = 300;

/**
 * Desirability of the output-dominant latency proxy `t = 2 + O / tps`.
 * This is not observed task wall time.
 */
export function timeDesirability(seconds: number): number {
  return clamp01(1 - Math.log(1 + seconds / TIME_SHAPE_SECONDS) / Math.log(1 + TIME_SATURATION_SECONDS / TIME_SHAPE_SECONDS));
}

export const latencyProxySeconds = (outputTokens: number, outputSpeedTps: number): number =>
  LATENCY_OVERHEAD_SECONDS + outputTokens / outputSpeedTps;

/** Common time value when the output speed is unknown. */
export const SPEED_UNKNOWN_VALUE = 0.5;
