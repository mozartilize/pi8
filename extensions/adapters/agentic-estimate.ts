/**
 * Agentic coding score of a benchmark row: the Terminal-Bench 4.0 pass rate
 * in percent.
 *
 * Artificial Analysis measures Terminal-Bench 4.0 for current models only. A
 * row without a result gets an estimate from the older indexes of the same
 * row (agentic, coding, intelligence). The estimate is a least-squares fit on
 * the rows that have both, made again at each sync. The fit error is large
 * (several points), so the estimate is the prediction minus the
 * leave-one-out error of the fit: uncertainty must not make a model look
 * stronger than the evidence shows.
 */

export interface AgenticEvidence {
  /** Terminal-Bench 4.0 pass rate in [0, 1]. */
  terminalBench?: number;
  agenticIndex?: number;
  codingIndex?: number;
  intelligenceIndex?: number;
}

export interface AgenticScore {
  /** Pass rate in percent, [0, 100]. */
  value: number;
  estimated: boolean;
}

type Feature = 'agenticIndex' | 'codingIndex' | 'intelligenceIndex';

/** Feature sets in order of preference. Every set includes the agentic index. */
const FEATURE_SETS: readonly (readonly Feature[])[] = [
  ['agenticIndex', 'codingIndex', 'intelligenceIndex'],
  ['agenticIndex'],
];

/** Fewer rows with both values give a fit that is not reliable. */
export const MIN_FIT_ROWS = 20;

interface Fit {
  features: readonly Feature[];
  coefficients: number[];
  /** Leave-one-out root mean square error, in percent. */
  error: number;
}

const finite = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value);

/** Least squares by the normal equations. Undefined when the system is singular. */
function leastSquares(inputs: readonly number[][], targets: readonly number[]): number[] | undefined {
  const size = inputs[0]!.length;
  const matrix = Array.from({ length: size }, (_, i) => [
    ...Array.from({ length: size }, (_, j) => inputs.reduce((sum, row) => sum + row[i]! * row[j]!, 0)),
    inputs.reduce((sum, row, k) => sum + row[i]! * targets[k]!, 0),
  ]);
  for (let column = 0; column < size; column++) {
    let pivot = column;
    for (let row = column + 1; row < size; row++) if (Math.abs(matrix[row]![column]!) > Math.abs(matrix[pivot]![column]!)) pivot = row;
    if (Math.abs(matrix[pivot]![column]!) < 1e-9) return undefined;
    [matrix[column], matrix[pivot]] = [matrix[pivot]!, matrix[column]!];
    for (let row = 0; row < size; row++) {
      if (row === column) continue;
      const factor = matrix[row]![column]! / matrix[column]![column]!;
      matrix[row] = matrix[row]!.map((value, j) => value - factor * matrix[column]![j]!);
    }
  }
  return matrix.map((row, i) => row[size]! / row[i]!);
}

const predict = (coefficients: readonly number[], input: readonly number[]): number =>
  coefficients.reduce((sum, coefficient, i) => sum + coefficient * input[i]!, 0);

function fitFor(rows: readonly AgenticEvidence[], features: readonly Feature[]): Fit | undefined {
  const usable = rows.filter((row) => finite(row.terminalBench) && features.every((feature) => finite(row[feature])));
  if (usable.length < MIN_FIT_ROWS) return undefined;
  const inputs = usable.map((row) => [1, ...features.map((feature) => row[feature]!)]);
  const targets = usable.map((row) => row.terminalBench! * 100);
  const coefficients = leastSquares(inputs, targets);
  if (!coefficients) return undefined;
  let squared = 0;
  for (let i = 0; i < usable.length; i++) {
    const rest = leastSquares(inputs.filter((_, j) => j !== i), targets.filter((_, j) => j !== i));
    if (!rest) return undefined;
    squared += (targets[i]! - predict(rest, inputs[i]!)) ** 2;
  }
  return { features, coefficients, error: Math.sqrt(squared / usable.length) };
}

/**
 * The agentic coding score of each row, in the same order. A row without a
 * Terminal-Bench 4.0 result and without the older indexes of a usable fit
 * gets undefined: its quality stays unknown.
 */
export function agenticCodingScores(rows: readonly AgenticEvidence[]): Array<AgenticScore | undefined> {
  const fits = FEATURE_SETS.map((features) => fitFor(rows, features)).filter((fit): fit is Fit => fit !== undefined);
  return rows.map((row) => {
    if (finite(row.terminalBench)) return { value: row.terminalBench * 100, estimated: false };
    const fit = fits.find((candidate) => candidate.features.every((feature) => finite(row[feature])));
    if (!fit) return undefined;
    const value = predict(fit.coefficients, [1, ...fit.features.map((feature) => row[feature]!)]) - fit.error;
    return { value: Math.min(100, Math.max(0, value)), estimated: true };
  });
}
