/**
 * Classifier metrics harness — PURE module (no I/O, no registry/session).
 *
 * Given a labeled corpus ({prompt, lang, goldDimension}) and a predict fn,
 * computes the metrics that decide whether the embedding classifier is good
 * enough to ship: confusion matrix, per-language macro-F1, cost-weighted
 * error, and per-language agreement with a gold labeler (the LLM assessor).
 *
 * The under-route/over-route asymmetry is encoded in the cost weights:
 * routing CHEAPER than the gold dimension is costlier than routing more
 * expensive (uncertainty routes up, R3). A predictor that abstains
 * (returns undefined) is scored as the worst under-route — it sent the
 * turn to nothing, i.e. the cheapest outcome.
 *
 * This module only MEASURES. It never fetches data, never runs the Phase-4
 * accept gate, and never changes routing.
 */
import type { Dimension } from './types.js';
import { DIMENSION_STRENGTH } from './classifier-keywords.js';

// ─── Tunable costs ────────────────────────────────────────────────────

/** Cost per strength step when the prediction routes cheaper than gold. */
export const UNDER_ROUTE_WEIGHT = 2;
/** Cost per strength step when the prediction routes more expensive than gold. */
export const OVER_ROUTE_WEIGHT = 1;

export const DIMENSIONS: Dimension[] = ['lightweight', 'gather', 'plan', 'implement', 'review'];

// ─── Types ────────────────────────────────────────────────────────────

export interface LabeledPrompt {
  prompt: string;
  lang: string;
  goldDimension: Dimension;
}

/** Returns a dimension, or undefined when the predictor abstains. */
export type PredictFn = (prompt: string) => Dimension | undefined;

/** `matrix[gold][predicted]` counts. Undefined predictions are not counted here. */
export type ConfusionMatrix = Record<Dimension, Record<Dimension, number>>;

export interface DimensionStats {
  precision: number;
  recall: number;
  f1: number;
}

export interface LanguageReport {
  lang: string;
  /** Per-dimension one-vs-rest precision/recall/F1. */
  perDimension: Record<Dimension, DimensionStats>;
  /** Mean of per-dimension F1 within this language. */
  macroF1: number;
  /** Fraction of rows where the prediction equals the gold label. */
  agreement: number;
  /** Mean cost-weighted error over this language's rows. */
  costWeightedError: number;
}

export interface PredictorReport {
  /** Mean per-language macro-F1 across all languages in the corpus. */
  macroF1: number;
  /** Overall fraction of rows where the prediction equals the gold label. */
  agreement: number;
  /** Mean cost-weighted error over the whole corpus. */
  costWeightedError: number;
  perLanguage: Record<string, LanguageReport>;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function zeroMatrix(): ConfusionMatrix {
  const m = {} as ConfusionMatrix;
  for (const gold of DIMENSIONS) {
    m[gold] = {} as Record<Dimension, number>;
    for (const pred of DIMENSIONS) m[gold][pred] = 0;
  }
  return m;
}

/** Cost of one row's prediction; undefined (abstain) = worst under-route. */
function rowCost(prediction: Dimension | undefined, gold: Dimension): number {
  if (prediction === undefined) {
    // Routed to nothing = routed to the cheapest option. Worst under-route.
    return DIMENSION_STRENGTH[gold] * UNDER_ROUTE_WEIGHT;
  }
  const delta = DIMENSION_STRENGTH[prediction] - DIMENSION_STRENGTH[gold];
  if (delta === 0) return 0;
  return delta < 0 ? -delta * UNDER_ROUTE_WEIGHT : delta * OVER_ROUTE_WEIGHT;
}

function f1(precision: number, recall: number): number {
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

// ─── Public API ───────────────────────────────────────────────────────

/** Confusion matrix over the whole corpus (gold rows → predicted columns). */
export function confusionMatrix(
  corpus: readonly LabeledPrompt[],
  predict: PredictFn,
): ConfusionMatrix {
  const matrix = zeroMatrix();
  for (const row of corpus) {
    const prediction = predict(row.prompt);
    if (prediction !== undefined) matrix[row.goldDimension][prediction] += 1;
  }
  return matrix;
}

/** One-vs-rest precision/recall/F1 for a single dimension over one language. */
function dimensionStats(
  rows: readonly LabeledPrompt[],
  dim: Dimension,
  predict: PredictFn,
): DimensionStats {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const row of rows) {
    const prediction = predict(row.prompt);
    if (row.goldDimension === dim) {
      if (prediction === dim) tp += 1;
      else fn += 1; // includes abstentions
    } else if (prediction === dim) {
      fp += 1;
    }
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  return { precision, recall, f1: f1(precision, recall) };
}

/**
 * Per-language report: per-dimension stats, macro-F1, agreement with gold,
 * and cost-weighted error.
 */
export function evaluateLanguage(
  rows: readonly LabeledPrompt[],
  lang: string,
  predict: PredictFn,
): LanguageReport {
  const languageRows = rows.filter((row) => row.lang === lang);
  const perDimension = {} as Record<Dimension, DimensionStats>;
  let macroSum = 0;
  for (const dim of DIMENSIONS) {
    const stats = dimensionStats(languageRows, dim, predict);
    perDimension[dim] = stats;
    macroSum += stats.f1;
  }
  let correct = 0;
  let costSum = 0;
  for (const row of languageRows) {
    const prediction = predict(row.prompt);
    if (prediction === row.goldDimension) correct += 1;
    costSum += rowCost(prediction, row.goldDimension);
  }
  const n = languageRows.length;
  return {
    lang,
    perDimension,
    macroF1: n > 0 ? macroSum / DIMENSIONS.length : 0,
    agreement: n > 0 ? correct / n : 0,
    costWeightedError: n > 0 ? costSum / n : 0,
  };
}

/** Mean per-language macro-F1 across every language present in the corpus. */
export function macroF1(corpus: readonly LabeledPrompt[], predict: PredictFn): number {
  const langs = [...new Set(corpus.map((row) => row.lang))];
  if (langs.length === 0) return 0;
  let sum = 0;
  for (const lang of langs) sum += evaluateLanguage(corpus, lang, predict).macroF1;
  return sum / langs.length;
}

/** Mean cost-weighted error over the whole corpus (under-route costlier). */
export function costWeightedError(
  corpus: readonly LabeledPrompt[],
  predict: PredictFn,
): number {
  if (corpus.length === 0) return 0;
  let sum = 0;
  for (const row of corpus) {
    sum += rowCost(predict(row.prompt), row.goldDimension);
  }
  return sum / corpus.length;
}

/**
 * Run several predictors over the same assessor-labeled corpus so the
 * comparison is apples-to-apples (keyword vs embedding vs gold-exact).
 */
export function compareClassifiers(
  corpus: readonly LabeledPrompt[],
  predictors: Record<string, PredictFn>,
): Record<string, PredictorReport> {
  const reports = {} as Record<string, PredictorReport>;
  for (const [name, predict] of Object.entries(predictors)) {
    const langs = [...new Set(corpus.map((row) => row.lang))];
    const perLanguage: Record<string, LanguageReport> = {};
    let macroSum = 0;
    for (const lang of langs) {
      const report = evaluateLanguage(corpus, lang, predict);
      perLanguage[lang] = report;
      macroSum += report.macroF1;
    }
    reports[name] = {
      macroF1: langs.length > 0 ? macroSum / langs.length : 0,
      agreement: agreementRate(corpus, predict),
      costWeightedError: costWeightedError(corpus, predict),
      perLanguage,
    };
  }
  return reports;
}

function agreementRate(corpus: readonly LabeledPrompt[], predict: PredictFn): number {
  if (corpus.length === 0) return 0;
  let correct = 0;
  for (const row of corpus) {
    if (predict(row.prompt) === row.goldDimension) correct += 1;
  }
  return correct / corpus.length;
}
