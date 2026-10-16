/**
 * Time feature of one action: the benchmark-output time proxy, the AA output
 * tokens per task at the model's measured output speed. This is an
 * output-streaming resource proxy at the benchmark-task horizon. It is not the
 * wall time of an AA task and not the latency of the next invocation. A
 * missing output-token count gives the common feature interval. A row without
 * a speed takes the range of the speeds measured at the other efforts of the
 * same model. This range is an estimate, not a guaranteed bound for the missing
 * observation. With no such speed, the common feature interval applies.
 */
import type { BenchModel } from '../../types.js';
import { clamp01, usable } from './mapping.js';
import type { Interval } from './schema.js';
import { outputEvidenceDetail, type BenchmarkOutputEvidence } from './benchmark-output.js';
import { FEATURE_MAPPING_VERSION, type FeatureEvidence } from './schema.js';

export function timeFeature(
  row: BenchModel | undefined,
  output: BenchmarkOutputEvidence,
  rows: readonly BenchModel[],
): { interval: Interval; evidence: FeatureEvidence } {
  const tps = row?.outputSpeedTps;
  if (!usable(tps) || tps === 0) {
    const speeds = rows
      .filter((other) => row && other.registryId === row.registryId && other.effort !== row.effort && other.active)
      .map((other) => other.outputSpeedTps)
      .filter((speed): speed is number => usable(speed) && speed > 0);
    if (speeds.length > 0 && output.kind !== 'missing') {
      const at = (speed: number) => timeDesirability(benchmarkOutputSeconds(output.tokensPerTask, speed));
      // The slowest measured speed gives the lower desirability bound.
      const lower = at(Math.min(...speeds));
      const upper = at(Math.max(...speeds));
      return {
        interval: { center: (lower + upper) / 2, lower, upper },
        evidence: { feature: 'timeDesirability', code: 'speed-other-effort', mapping: FEATURE_MAPPING_VERSION, details: [outputEvidenceDetail(output)] },
      };
    }
    return {
      interval: { center: SPEED_UNKNOWN_VALUE, lower: 0, upper: 1 },
      evidence: { feature: 'timeDesirability', code: 'speed-unknown', mapping: FEATURE_MAPPING_VERSION },
    };
  }
  if (output.kind === 'missing') {
    // No finite upper output duration is justified: the worst case is
    // desirability 0 and the best case (no output) is desirability 1.
    return {
      interval: { center: SPEED_UNKNOWN_VALUE, lower: 0, upper: 1 },
      evidence: { feature: 'timeDesirability', code: 'missing', mapping: FEATURE_MAPPING_VERSION, details: [outputEvidenceDetail(output), 'speed:known'] },
    };
  }
  const value = timeDesirability(benchmarkOutputSeconds(output.tokensPerTask, tps));
  return {
    interval: { center: value, lower: value, upper: value },
    evidence: { feature: 'timeDesirability', code: 'speed-known', mapping: FEATURE_MAPPING_VERSION, details: [outputEvidenceDetail(output)] },
  };
}

// Fixed clock units at the benchmark-task horizon: 1 minute shapes the curve,
// and a proxy of 1 hour or more has desirability 0.
export const TIME_SHAPE_SECONDS = 60;
export const TIME_SATURATION_SECONDS = 3600;

/** Desirability of the benchmark-output time proxy, in seconds. */
export function timeDesirability(seconds: number): number {
  return clamp01(1 - Math.log(1 + seconds / TIME_SHAPE_SECONDS) / Math.log(1 + TIME_SATURATION_SECONDS / TIME_SHAPE_SECONDS));
}

export const benchmarkOutputSeconds = (tokensPerTask: number, outputSpeedTps: number): number =>
  tokensPerTask / outputSpeedTps;

/** Common time value when the output speed or the output-token count is unknown. */
export const SPEED_UNKNOWN_VALUE = 0.5;
