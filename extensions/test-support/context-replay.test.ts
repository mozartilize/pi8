import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  correctnessGates,
  entriesForZeroFailureBound,
  rateUpperBound95,
  scoreByApiFamily,
  scoreReplay,
  type Corpus,
  type CorpusLabel,
  type EntryPrediction,
} from './context-replay.js';

const corpus = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'fixtures', 'routing-context-corpus.json'), 'utf8'),
) as Corpus;

const DIMENSIONS = new Set(['lightweight', 'gather', 'plan', 'implement', 'review']);
const REQUEST_CONTEXT = new Set(['referenced-artifact', 'identity-unresolved']);
const RELATIONS = new Set(['continue', 'resume', 'switch', 'new']);

describe('routing-context corpus fixture', () => {
  it('labels every entry with the correctness fields', () => {
    const ids = new Set<string>();
    for (const session of corpus.sessions) {
      for (const entry of session.entries) {
        expect(ids.has(entry.id)).toBe(false);
        ids.add(entry.id);
        expect(DIMENSIONS.has(entry.label.deliverable)).toBe(true);
        expect(entry.label.context.every((reason) => REQUEST_CONTEXT.has(reason))).toBe(true);
        expect(RELATIONS.has(entry.label.relation)).toBe(true);
        expect(['same', 'switch', 'new']).toContain(entry.label.topicRelation);
      }
    }
  });

  it('names an existing work item only after an earlier entry of the same session introduced it', () => {
    for (const session of corpus.sessions) {
      const introduced = new Set<string>();
      for (const entry of session.entries) {
        const { workItem, existing } = entry.label;
        if (workItem === 'NONE') continue;
        expect(introduced.has(workItem)).toBe(existing);
        introduced.add(workItem);
      }
    }
  });

});

const label = (over: Partial<CorpusLabel> = {}): CorpusLabel => ({
  topic: 't:a',
  topicRelation: 'new',
  workItem: 'w:a',
  relation: 'new',
  existing: false,
  deliverable: 'implement',
  context: [],
  contextSatisfied: true,
  ...over,
});

const prediction = (over: Partial<EntryPrediction> & Pick<EntryPrediction, 'entryId'>): EntryPrediction => ({
  sessionId: 's',
  apiFamily: 'anthropic-messages',
  ordinal: 0,
  topicId: 't_1',
  workItemId: 'w_1',
  createdTopic: true,
  createdWorkItem: true,
  relation: 'new',
  deliverable: 'implement',
  context: [],
  contextSatisfied: true,
  resolver: 'context-handoff',
  ...over,
});

describe('scoreReplay', () => {
  it('maps created ids onto the labelled aliases and scores a correct continuation', () => {
    const labels = new Map([
      ['1', label()],
      ['2', label({ topicRelation: 'same', relation: 'continue', existing: true })],
    ]);
    const metrics = scoreReplay([
      prediction({ entryId: '1' }),
      prediction({
        entryId: '2', ordinal: 1, createdTopic: false, createdWorkItem: false, relation: 'continue', resolver: 'deterministic',
      }),
    ], labels);
    expect(metrics.workItemAccuracy).toMatchObject({ numerator: 2, denominator: 2, value: 1 });
    expect(metrics.topicAccuracy.value).toBe(1);
    expect(metrics.criticalFalseContinuation.numerator).toBe(0);
    expect(metrics.relationMacroF1).toBe(1);
  });

  it('counts reuse of an item the label does not name as a critical false continuation', () => {
    const labels = new Map([
      ['1', label()],
      ['2', label({ workItem: 'w:b', topicRelation: 'same' })],
    ]);
    const metrics = scoreReplay([
      prediction({ entryId: '1' }),
      prediction({
        entryId: '2', ordinal: 1, createdTopic: false, createdWorkItem: false, relation: 'continue', resolver: 'deterministic',
      }),
    ], labels);
    expect(metrics.criticalFalseContinuation).toMatchObject({ numerator: 1, denominator: 2 });
    expect(metrics.newWorkItemRecall).toMatchObject({ numerator: 1, denominator: 2 });
  });

  it('never matches an item created for an entry that should have continued', () => {
    const labels = new Map([
      ['1', label()],
      ['2', label({ topicRelation: 'same', relation: 'continue', existing: true })],
    ]);
    const metrics = scoreReplay([
      prediction({ entryId: '1' }),
      prediction({ entryId: '2', ordinal: 1, workItemId: 'w_2', createdTopic: false, relation: 'new' }),
    ], labels);
    expect(metrics.workItemAccuracy).toMatchObject({ numerator: 1, denominator: 2 });
    // A new item carries no old state: wrong, but not a false continuation.
    expect(metrics.criticalFalseContinuation.numerator).toBe(0);
  });

  it('does not count continuing an item split off the labelled work as a false continuation', () => {
    const labels = new Map([
      ['1', label()],
      ['2', label({ topicRelation: 'same', relation: 'continue', existing: true })],
      ['3', label({ topicRelation: 'same', relation: 'continue', existing: true })],
      ['4', label({ workItem: 'w:b', topicRelation: 'same' })],
      ['5', label({ topicRelation: 'same', relation: 'resume', existing: true })],
    ]);
    const metrics = scoreReplay([
      prediction({ entryId: '1' }),
      prediction({ entryId: '2', ordinal: 1, workItemId: 'w_2', createdTopic: false, relation: 'new' }),
      prediction({ entryId: '3', ordinal: 2, workItemId: 'w_2', createdTopic: false, createdWorkItem: false, relation: 'continue', resolver: 'deterministic' }),
      prediction({ entryId: '4', ordinal: 3, workItemId: 'w_3', createdTopic: false }),
      prediction({ entryId: '5', ordinal: 4, workItemId: 'w_3', createdTopic: false, createdWorkItem: false, relation: 'continue', resolver: 'deterministic' }),
    ], labels);
    expect(metrics.workItemAccuracy).toMatchObject({ numerator: 2, denominator: 5 });
    // Entry 3 continues w_2, split off w:a: inexact, same work. Entry 5
    // continues w_3, created for w:b, into w:a: a false continuation.
    expect(metrics.criticalFalseContinuation.numerator).toBe(1);
  });

  it('keeps UNKNOWN out of accuracy', () => {
    const labels = new Map([['1', label()], ['2', label({ workItem: 'w:b', topicRelation: 'same' })]]);
    const metrics = scoreReplay([
      prediction({ entryId: '1' }),
      prediction({
        entryId: '2', ordinal: 1, workItemId: 'UNKNOWN', topicId: 'UNKNOWN', relation: 'unknown',
        createdTopic: false, createdWorkItem: false, resolver: 'fallback',
      }),
    ], labels);
    expect(metrics.workItemAccuracy.denominator).toBe(1);
    expect(metrics.unknownRate).toMatchObject({ numerator: 1, denominator: 2 });
  });

  it('scores each API family on its own entries, beside all of them', () => {
    const labels = new Map([['1', label()], ['2', label({ workItem: 'w:b' })]]);
    const byFamily = scoreByApiFamily([
      prediction({ entryId: '1', apiFamily: 'openai-responses' }),
      prediction({ entryId: '2', createdTopic: false, createdWorkItem: false, relation: 'continue', apiFamily: 'anthropic-messages' }),
    ], labels);
    expect(byFamily.get('all')!.entries).toBe(2);
    expect(byFamily.get('openai-responses')!.workItemAccuracy.value).toBe(1);
    expect(byFamily.get('anthropic-messages')!.workItemAccuracy.value).toBe(0);
  });
});

describe('correctnessGates', () => {
  it('needs 600 error-free entries to show a false-continuation rate of at most 0.5%', () => {
    expect(entriesForZeroFailureBound(0.005)).toBe(600);
    const labels = new Map([['1', label()]]);
    const gates = correctnessGates(scoreReplay([prediction({ entryId: '1' })], labels));
    expect(gates.find((g) => g.gate.startsWith('critical'))?.status).toBe('insufficient-evidence');
  });

  it('bounds a rate by Clopper-Pearson: the rule of three with no failures, wider with some', () => {
    expect(rateUpperBound95(0, 600)).toBeCloseTo(0.00498, 4);
    expect(rateUpperBound95(12, 2690)).toBeCloseTo(0.00722, 4);
    expect(rateUpperBound95(7, 2690)).toBeGreaterThan(7 / 2690);
    expect(rateUpperBound95(0, 0)).toBe(1);
  });

  it('passes the false-continuation gate only when the upper bound, not the observed rate, is within 0.5%', () => {
    const metrics = (failures: number, entries: number) => ({
      criticalFalseContinuation: { numerator: failures, denominator: entries, value: failures / entries },
      workItemAccuracy: { numerator: entries, denominator: entries, value: 1 },
    }) as never;
    const status = (failures: number, entries: number) =>
      correctnessGates(metrics(failures, entries)).find((g) => g.gate.startsWith('critical'))?.status;
    expect(status(12, 2690)).toBe('insufficient-evidence');
    expect(status(3, 2690)).toBe('pass');
    expect(status(0, 600)).toBe('pass');
    expect(status(13, 2690)).toBe('insufficient-evidence');
    expect(status(14, 2690)).toBe('fail');
  });

  it('fails the false-continuation gate on any observed failure in a small corpus', () => {
    const labels = new Map([['1', label()], ['2', label({ workItem: 'w:b', topicRelation: 'same' })]]);
    const gates = correctnessGates(scoreReplay([
      prediction({ entryId: '1' }),
      prediction({ entryId: '2', ordinal: 1, createdTopic: false, createdWorkItem: false, relation: 'continue' }),
    ], labels));
    expect(gates.find((g) => g.gate.startsWith('critical'))?.status).toBe('fail');
  });
});
