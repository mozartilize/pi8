/**
 * Offline evaluation of work-context resolution against a hand-labelled
 * corpus (`fixtures/routing-context-corpus.json` shape).
 *
 * Scoring is separate from replay: a replay produces one prediction per
 * labelled entry, and `scoreReplay` turns predictions into the correctness
 * metrics the release gates are stated in. Predicted ids are generated, so
 * they are mapped onto the corpus aliases by the entry that created them: an
 * item created for an entry whose label names a new alias takes that alias;
 * any other created item gets an alias of its own and can never match. Every
 * created item also keeps the labelled work of the entry that created it, so
 * continuing an item split off the same work is inexact but not a false
 * continuation.
 */
import type { Dimension } from '../types.js';
import type { ContextReason } from '../routing/context/types.js';

export type CorpusRelation = 'continue' | 'resume' | 'switch' | 'new';

export interface CorpusLabel {
  topic: string;
  /** `same`: the entry stays in the active topic; `switch`: another known topic; `new`: a topic not seen before. */
  topicRelation: 'same' | 'switch' | 'new';
  /** Alias of the expected work item, or `NONE` for an entry that belongs to none. */
  workItem: string;
  relation: CorpusRelation;
  /** The expected work item existed before this entry. */
  existing: boolean;
  deliverable: Dimension;
  /** What the request owes before its deliverable; `identity-unresolved` when only the user can say which work it is. */
  context: ContextReason[];
  contextSatisfied: boolean;
}

/** Titles a handoff gives the entry's work when it starts new work. */
export interface CorpusTitles {
  topic: string;
  work: string;
}

export type CorpusAction =
  | { read: string; offset?: number; limit?: number }
  | { write: string; content: string }
  | { externalEdit: string; content: string }
  | { handoff: 'investigation' };

export interface CorpusEntry {
  id: string;
  prompt: string;
  titles?: CorpusTitles;
  /** Router-observable events after the entry is routed, in order. */
  after?: CorpusAction[];
  label: CorpusLabel;
}

export interface CorpusSession {
  id: string;
  scenario: string;
  apiFamily?: string;
  files?: Record<string, string>;
  legacyHistory?: Array<{ role: 'user' | 'assistant'; text: string }>;
  entries: CorpusEntry[];
}

export interface Corpus {
  version: 1;
  description: string;
  sessions: CorpusSession[];
}

/** What the router resolved for one labelled entry. */
export interface EntryPrediction {
  entryId: string;
  sessionId: string;
  apiFamily: string;
  /** Index of the entry in its session; later entries are those after the first. */
  ordinal: number;
  topicId: string | 'UNKNOWN';
  workItemId: string | 'NONE' | 'UNKNOWN';
  createdTopic: boolean;
  createdWorkItem: boolean;
  relation: CorpusRelation | 'unknown';
  deliverable: Dimension;
  context: ContextReason[];
  contextSatisfied: boolean;
  resolver: string;
}

export interface Rate {
  numerator: number;
  denominator: number;
  /** Undefined when the denominator is zero. */
  value?: number;
}

export interface ReplayMetrics {
  entries: number;
  laterEntries: number;
  topicAccuracy: Rate;
  workItemAccuracy: Rate;
  newTopicPrecision: Rate;
  newTopicRecall: Rate;
  newWorkItemPrecision: Rate;
  newWorkItemRecall: Rate;
  relationMacroF1?: number;
  deliverableAccuracy: Rate;
  contextAccuracy: Rate;
  contextSatisfiedAccuracy: Rate;
  unknownRate: Rate;
  criticalFalseContinuation: Rate;
}

const rate = (numerator: number, denominator: number): Rate => ({
  numerator,
  denominator,
  ...(denominator > 0 ? { value: numerator / denominator } : {}),
});

const RELATIONS: readonly CorpusRelation[] = ['continue', 'resume', 'switch', 'new'];

/** Reasons compare as sets: their order carries no meaning. */
export function sameReasons(a: readonly ContextReason[], b: readonly ContextReason[]): boolean {
  return a.length === b.length && a.every((reason) => b.includes(reason));
}

function macroF1(pairs: ReadonlyArray<{ expected: CorpusRelation; predicted: string }>): number | undefined {
  const scores: number[] = [];
  for (const relation of RELATIONS) {
    const tp = pairs.filter((p) => p.expected === relation && p.predicted === relation).length;
    const fp = pairs.filter((p) => p.expected !== relation && p.predicted === relation).length;
    const fn = pairs.filter((p) => p.expected === relation && p.predicted !== relation).length;
    if (tp + fp + fn === 0) continue;
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    scores.push(precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall));
  }
  return scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : undefined;
}

/**
 * Score predictions against labels. `labels` maps entry id to its label;
 * predictions must be in replay order so created ids map to the right alias.
 */
export function scoreReplay(
  predictions: readonly EntryPrediction[],
  labels: ReadonlyMap<string, CorpusLabel>,
): ReplayMetrics {
  const workAlias = new Map<string, string>();
  const topicAlias = new Map<string, string>();
  const seenWork = new Set<string>();
  /** Predicted item id → the labelled work of the entry that created it. */
  const workOrigin = new Map<string, string>();
  const seenTopics = new Set<string>();

  let topicHits = 0; let topicTotal = 0;
  let workHits = 0; let workTotal = 0;
  let newTopicTp = 0; let newTopicPredicted = 0; let newTopicExpected = 0;
  let newWorkTp = 0; let newWorkPredicted = 0; let newWorkExpected = 0;
  let deliverableHits = 0; let contextHits = 0; let satisfiedHits = 0;
  let unknown = 0; let later = 0;
  let falseContinuation = 0;
  const relationPairs: Array<{ expected: CorpusRelation; predicted: string }> = [];

  for (const prediction of predictions) {
    const label = labels.get(prediction.entryId);
    if (!label) continue;
    const isLater = prediction.ordinal > 0;
    if (isLater) later += 1;

    const workAliasOf = (id: string): string => {
      if (id === 'NONE' || id === 'UNKNOWN') return id;
      const known = workAlias.get(id);
      if (known) return known;
      const alias = prediction.createdWorkItem && label.workItem !== 'NONE' && !label.existing
        && !seenWork.has(label.workItem)
        ? label.workItem
        : `pred:${id}`;
      workAlias.set(id, alias);
      seenWork.add(alias);
      return alias;
    };
    const topicAliasOf = (id: string): string => {
      if (id === 'UNKNOWN') return id;
      const known = topicAlias.get(id);
      if (known) return known;
      const alias = prediction.createdTopic && label.topicRelation === 'new' && !seenTopics.has(label.topic)
        ? label.topic
        : `pred:${id}`;
      topicAlias.set(id, alias);
      seenTopics.add(alias);
      return alias;
    };

    const predictedWork = workAliasOf(prediction.workItemId);
    if (prediction.createdWorkItem && !workOrigin.has(prediction.workItemId)) workOrigin.set(prediction.workItemId, label.workItem);
    const unknownPrediction = prediction.workItemId === 'UNKNOWN' || prediction.relation === 'unknown';
    if (unknownPrediction) unknown += 1;

    if (!unknownPrediction) {
      workTotal += 1;
      if (predictedWork === label.workItem) workHits += 1;
      if (label.workItem !== 'NONE' && prediction.topicId !== 'UNKNOWN') {
        topicTotal += 1;
        if (topicAliasOf(prediction.topicId) === label.topic) topicHits += 1;
      }
    }

    const expectNewWork = label.workItem !== 'NONE' && !label.existing;
    if (expectNewWork) newWorkExpected += 1;
    if (prediction.createdWorkItem) newWorkPredicted += 1;
    if (expectNewWork && prediction.createdWorkItem && predictedWork === label.workItem) newWorkTp += 1;

    if (label.workItem !== 'NONE') {
      const expectNewTopic = label.topicRelation === 'new';
      if (expectNewTopic) newTopicExpected += 1;
      if (prediction.createdTopic) newTopicPredicted += 1;
      if (expectNewTopic && prediction.createdTopic) newTopicTp += 1;
    }

    relationPairs.push({ expected: label.relation, predicted: prediction.relation });
    if (prediction.deliverable === label.deliverable) deliverableHits += 1;
    if (sameReasons(prediction.context, label.context)) contextHits += 1;
    if (prediction.contextSatisfied === label.contextSatisfied) satisfiedHits += 1;

    // Reusing an existing item created for other work is the one error that
    // carries old state (grounding, collected context) into unrelated
    // work. An item split off the labelled work carries that work's state.
    const reused = !prediction.createdWorkItem
      && prediction.workItemId !== 'NONE'
      && prediction.workItemId !== 'UNKNOWN';
    const falseReuse = reused && predictedWork !== label.workItem
      && (workOrigin.get(prediction.workItemId) ?? predictedWork) !== label.workItem;
    if (falseReuse) falseContinuation += 1;
  }

  const total = predictions.filter((p) => labels.has(p.entryId)).length;
  return {
    entries: total,
    laterEntries: later,
    topicAccuracy: rate(topicHits, topicTotal),
    workItemAccuracy: rate(workHits, workTotal),
    newTopicPrecision: rate(newTopicTp, newTopicPredicted),
    newTopicRecall: rate(newTopicTp, newTopicExpected),
    newWorkItemPrecision: rate(newWorkTp, newWorkPredicted),
    newWorkItemRecall: rate(newWorkTp, newWorkExpected),
    relationMacroF1: macroF1(relationPairs),
    deliverableAccuracy: rate(deliverableHits, total),
    contextAccuracy: rate(contextHits, total),
    contextSatisfiedAccuracy: rate(satisfiedHits, total),
    unknownRate: rate(unknown, total),
    criticalFalseContinuation: rate(falseContinuation, total),
  };
}

/** Metrics per API family, plus `all`. */
export function scoreByApiFamily(
  predictions: readonly EntryPrediction[],
  labels: ReadonlyMap<string, CorpusLabel>,
): Map<string, ReplayMetrics> {
  const families = new Map<string, EntryPrediction[]>();
  for (const prediction of predictions) {
    const list = families.get(prediction.apiFamily) ?? [];
    list.push(prediction);
    families.set(prediction.apiFamily, list);
  }
  const out = new Map<string, ReplayMetrics>([['all', scoreReplay(predictions, labels)]]);
  for (const [family, list] of families) out.set(family, scoreReplay(list, labels));
  return out;
}

export type GateStatus = 'pass' | 'fail' | 'insufficient-evidence';

export interface GateResult {
  gate: string;
  status: GateStatus;
  detail: string;
}

/**
 * Entries needed to show a rate at or below `bound` at 95% confidence when no
 * failure was observed (rule of three).
 */
export function entriesForZeroFailureBound(bound: number): number {
  return Math.ceil(3 / bound);
}

/** P(X ≤ k) for X ~ Binomial(n, p), summed in log space. */
function binomialCdf(k: number, n: number, p: number): number {
  if (p <= 0) return 1;
  if (p >= 1) return k >= n ? 1 : 0;
  let logTerm = n * Math.log1p(-p); // P(X = 0)
  let sum = Math.exp(logTerm);
  for (let i = 1; i <= k; i += 1) {
    logTerm += Math.log((n - i + 1) / i) + Math.log(p) - Math.log1p(-p);
    sum += Math.exp(logTerm);
  }
  return Math.min(sum, 1);
}

/**
 * One-sided 95% upper confidence bound on a rate with `failures` observed in
 * `trials` (Clopper-Pearson): the largest rate under which seeing at most that
 * many failures still has probability ≥ 5%. With no failures it is the rule of
 * three, about 3 / trials.
 */
export function rateUpperBound95(failures: number, trials: number): number {
  if (trials <= 0) return 1;
  if (failures >= trials) return 1;
  let low = failures / trials;
  let high = 1;
  for (let i = 0; i < 60; i += 1) {
    const mid = (low + high) / 2;
    if (binomialCdf(failures, trials, mid) > 0.05) low = mid;
    else high = mid;
  }
  return high;
}

/**
 * The correctness gates a corpus can decide. Economic gates (net routing
 * value, latency, model switches, cache-read ratio) need baseline spend on
 * the same transcripts and are not decided here.
 */
export function correctnessGates(metrics: ReplayMetrics): GateResult[] {
  const results: GateResult[] = [];
  // The gate passes only when the 95% upper bound is within 0.5%; an observed
  // rate under 0.5% whose bound is not shows too little, not a pass.
  const fc = metrics.criticalFalseContinuation;
  const gate = 'critical false continuation ≤ 0.5%';
  const upper = rateUpperBound95(fc.numerator, fc.denominator);
  const detail = `${fc.numerator}/${fc.denominator}; 95% upper bound ${(upper * 100).toFixed(2)}%`;
  if ((fc.value ?? 0) > 0.005) {
    results.push({ gate, status: 'fail', detail });
  } else if (upper > 0.005) {
    const needed = fc.numerator === 0 ? `; ${entriesForZeroFailureBound(0.005)} error-free entries are needed` : '';
    results.push({ gate, status: 'insufficient-evidence', detail: `${detail}${needed}` });
  } else {
    results.push({ gate, status: 'pass', detail });
  }
  const wa = metrics.workItemAccuracy;
  results.push({
    gate: 'work item exact accuracy ≥ 97% on non-UNKNOWN entries',
    status: wa.value == null ? 'insufficient-evidence' : wa.value >= 0.97 ? 'pass' : 'fail',
    detail: `${wa.numerator}/${wa.denominator}`,
  });
  return results;
}
