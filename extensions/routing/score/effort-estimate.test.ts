import { describe, it, expect } from 'vitest';
import {
  completeMeasuredRow,
  effortDropsPerStep,
  estimateRow,
} from './effort-estimate.js';
import type { BenchModel } from '../../types.js';
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';

const row = (
  registryId: string,
  effort: ModelThinkingLevel,
  quality: BenchModel['quality'],
  extra: Partial<BenchModel> = {},
): BenchModel & { effort: ModelThinkingLevel } => ({
  registryId,
  benchSlug: registryId.split('/')[1]!,
  active: true,
  quality,
  effort,
  source: 'test',
  ...extra,
});

/** Ten models each dropping a fixed amount per step, plus one steep outlier. */
const corpus = (): BenchModel[] => {
  const rows: BenchModel[] = [];
  for (let m = 0; m < 10; m++) {
    rows.push(row(`test/m${m}`, 'low', { intelligence: 40 }));
    rows.push(row(`test/m${m}`, 'medium', { intelligence: 42 }));
    rows.push(row(`test/m${m}`, 'high', { intelligence: 44 }));
  }
  rows.push(row('test/steep', 'low', { intelligence: 10 }));
  rows.push(row('test/steep', 'high', { intelligence: 40 }));
  return rows;
};

describe('effortDropsPerStep', () => {
  it('derives a per-step drop from observed adjacent-level pairs', () => {
    const drops = effortDropsPerStep(corpus());
    // 20 pairs at 2.0/step plus one 15.0/step outlier: a percentile resists
    // the outlier where a mean would be dragged up by it.
    expect(drops.intelligence).toBeCloseTo(2, 5);
  });

  it('picks a drop above the middle of a spread so estimates under-shoot', () => {
    // Ten models spanning 1..10 per step. The estimator must sit near the top
    // of the observed spread, not the middle: at the median an estimate lands
    // above the true value about half the time.
    const spread: BenchModel[] = [];
    for (let m = 1; m <= 10; m++) {
      spread.push(row(`test/s${m}`, 'low', { intelligence: 40 }));
      spread.push(row(`test/s${m}`, 'medium', { intelligence: 40 + m }));
    }
    const drops = effortDropsPerStep(spread);
    expect(drops.intelligence).toBeGreaterThan(5.5);
    expect(drops.intelligence).toBeLessThanOrEqual(10);
  });

  it('declines an axis with too few observations rather than guessing', () => {
    const thin = [
      row('test/a', 'low', { intelligence: 40, coding: 50 }),
      row('test/a', 'high', { intelligence: 44, coding: 60 }),
    ];
    const drops = effortDropsPerStep(thin);
    expect(drops.intelligence).toBeUndefined();
    expect(drops.coding).toBeUndefined();
  });

  it('derives an axis drop across an intermediate row missing that axis', () => {
    const rows: BenchModel[] = [];
    for (let i = 0; i < 8; i++) {
      rows.push(row(`test/gap-${i}`, 'low', { intelligence: 20 }));
      rows.push(row(`test/gap-${i}`, 'medium', {}));
      rows.push(row(`test/gap-${i}`, 'high', { intelligence: 40 }));
    }

    // low→high is two effort steps, so the observed drop is 10 per step.
    expect(effortDropsPerStep(rows).intelligence).toBeCloseTo(10, 5);
  });

  it('ignores rows with no effort label', () => {
    const unlabelled: BenchModel[] = [
      { registryId: 'test/a', benchSlug: 'a', active: true, quality: { intelligence: 50 }, source: 'test' },
    ];
    expect(effortDropsPerStep(unlabelled)).toEqual({});
  });

  it('never returns a negative drop', () => {
    // A non-monotone source (higher effort scoring lower) must not produce an
    // estimator that raises quality as effort falls.
    const inverted: BenchModel[] = [];
    for (let m = 0; m < 10; m++) {
      inverted.push(row(`test/m${m}`, 'low', { intelligence: 60 }));
      inverted.push(row(`test/m${m}`, 'high', { intelligence: 40 }));
    }
    const drops = effortDropsPerStep(inverted);
    expect(drops.intelligence).toBeGreaterThanOrEqual(0);
  });
});

describe('estimateRow', () => {
  const measured = [
    row('test/a', 'high', { intelligence: 42.6, coding: 66.4, agenticCoding: 34.2 }, {
      priceInputPer1M: 2,
      priceOutputPer1M: 10,
      costPerTask: 0.4169,
      outputSpeedTps: 80,
    }),
    row('test/a', 'max', { intelligence: 55.3, coding: 71.5, agenticCoding: 49.7 }, {
      priceInputPer1M: 2,
      priceOutputPer1M: 10,
      costPerTask: 1.7173,
    }),
  ];
  const drops = { intelligence: 6, coding: 7, agenticCoding: 8 };

  it('steps down from the nearest measured level above the target', () => {
    // medium is one step below the measured `high` row, not two below `max`.
    const est = estimateRow('medium', measured, drops);
    expect(est?.quality.intelligence).toBeCloseTo(36.6, 5);
    expect(est?.quality.coding).toBeCloseTo(59.4, 5);
    expect(est?.quality.agenticCoding).toBeCloseTo(26.2, 5);
    expect(est?.effort).toBe('medium');
    expect(est?.qualityEstimated).toBe(true);
  });

  it('scales the drop by the number of steps', () => {
    const est = estimateRow('low', measured, drops);
    expect(est?.quality.intelligence).toBeCloseTo(30.6, 5);
  });

  it('never extrapolates above the highest measured row', () => {
    // `max` is the top of the ladder and already measured; nothing sits above
    // an unmeasured level beyond it, so no capability is invented.
    const belowMaxOnly = [measured[1]!];
    expect(estimateRow('max', belowMaxOnly, drops)).toBeUndefined();
    expect(estimateRow('xhigh', [measured[0]!], drops)).toBeUndefined();
  });

  it('carries price and context across but never per-run measurements', () => {
    const est = estimateRow('medium', measured, drops);
    expect(est?.priceInputPer1M).toBe(2);
    expect(est?.priceOutputPer1M).toBe(10);
    // costPerTask and speed are measurements of one effort level; stepping
    // down a quality ladder cannot produce them.
    expect(est?.costPerTask).toBeUndefined();
    expect(est?.outputSpeedTps).toBeUndefined();
  });

  it('declines when no axis has a usable drop', () => {
    expect(estimateRow('medium', measured, {})).toBeUndefined();
  });

  it('fills missing axes independently and preserves target-level metadata', () => {
    const off = row('test/a', 'off', { intelligence: 29.3 }, {
      latencyMsTtft: 1680,
      outputSpeedTps: 100,
    });
    const completed = completeMeasuredRow(off, [off, ...measured], drops);

    // The direct measurement wins even though stepping down intelligence from
    // high would yield a different value.
    expect(completed?.quality.intelligence).toBe(29.3);
    expect(completed?.quality.coding).toBeCloseTo(38.4, 5);
    expect(completed?.quality.agenticCoding).toBeCloseTo(2.2, 5);
    expect(completed?.latencyMsTtft).toBe(1680);
    expect(completed?.outputSpeedTps).toBe(100);
    expect(completed?.qualityEstimated).toBe(true);
  });

  it('uses the nearest measured anchor separately for each missing axis', () => {
    const partialHigh = row('test/a', 'high', { intelligence: 42 });
    const fullMax = row('test/a', 'max', { intelligence: 55, coding: 71, agenticCoding: 49 });
    const completed = completeMeasuredRow(
      row('test/a', 'medium', { intelligence: 35 }),
      [partialHigh, fullMax],
      drops,
    );

    expect(completed?.quality.intelligence).toBe(35);
    // high has no coding/agentic measurements, so those axes anchor at max.
    expect(completed?.quality.coding).toBeCloseTo(50, 5);
    expect(completed?.quality.agenticCoding).toBeCloseTo(25, 5);
  });

  it('clamps at zero rather than producing negative quality', () => {
    const weak = [row('test/w', 'max', { intelligence: 5 })];
    const est = estimateRow('off', weak, { intelligence: 6 });
    expect(est?.quality.intelligence).toBe(0);
  });
});
