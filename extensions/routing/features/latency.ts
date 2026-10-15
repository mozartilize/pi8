/**
 * Time feature of one next invocation: the output-token forecast at the
 * model's measured output speed. An unknown speed gives the common feature
 * interval.
 */
import type { BenchModel } from '../../types.js';
import { SPEED_UNKNOWN_VALUE, latencyProxySeconds, timeDesirability } from './mapping.js';
import type { Interval } from './model.js';
import { demandDetail, outputTokenForecast, UNKNOWN_DEMAND, usable, type OutputDemandPrior, type OutputTokenForecast } from './output-demand.js';
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
