/**
 * Benchmark output evidence of one action: the AA output tokens per
 * Intelligence Index task (answer and reasoning) at the action's own effort.
 *
 * The value stays at its benchmark-task horizon. It is not a forecast of the
 * output of the next invocation, and no reference, clamp or pool statistic
 * scales it. Cost and time apply their fixed absolute transforms to it, so a
 * higher effort, or a model that writes more, costs more and takes longer
 * when AA measured that it does. Missing evidence stays missing: no other
 * effort, model or pool statistic supplies a token count.
 */
import type { BenchModel } from '../../types.js';
import { usable } from './mapping.js';
import { isCompatibleIndexVersion } from './benchmark.js';

/** Why an action has no usable AA output-token observation. */
export type MissingOutputReason =
  | 'no-row'
  | 'absent'
  | 'invalid'
  | 'conflict'
  | 'unknown-effort'
  | 'source-estimated'
  | 'version-unknown'
  | 'version-incompatible';

export type BenchmarkOutputEvidence =
  | { kind: 'measured'; tokensPerTask: number; indexVersion: string }
  | { kind: 'missing'; reason: MissingOutputReason };

const missing = (reason: MissingOutputReason): BenchmarkOutputEvidence => ({ kind: 'missing', reason });

/**
 * Output evidence of one action from the benchmark row at its served effort
 * (`rowAtServedEffort`). Only a measured observation of a row whose
 * Intelligence Index AA did not estimate counts, and only when the page and
 * API index versions are compatible.
 */
export function benchmarkOutputEvidence(row: BenchModel | undefined, apiIndexVersion: string | undefined): BenchmarkOutputEvidence {
  if (!row) return missing('no-row');
  const provenance = row.outputTokensProvenance;
  if (!provenance) return missing('absent');
  if (provenance.status !== 'measured') return missing(provenance.status);
  const tokens = row.outputTokensPerTask;
  if (!usable(tokens)) return missing('invalid');
  if (provenance.indexVersion === undefined || apiIndexVersion === undefined) return missing('version-unknown');
  if (!isCompatibleIndexVersion(provenance.indexVersion) || !isCompatibleIndexVersion(apiIndexVersion)) {
    return missing('version-incompatible');
  }
  return { kind: 'measured', tokensPerTask: tokens, indexVersion: provenance.indexVersion };
}

/** Evidence detail of the output evidence that a cost or time feature used. */
export const outputEvidenceDetail = (output: BenchmarkOutputEvidence): string =>
  output.kind === 'measured' ? 'output-tokens:measured' : `output-tokens:${output.reason}`;
