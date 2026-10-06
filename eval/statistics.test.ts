import { describe, expect, it } from 'vitest';
import { betaCdf, bootstrap, clopperPearsonLower, clopperPearsonUpper, isDegenerate, seedFromText } from './statistics.ts';

describe('exact rare-event bounds', () => {
  it('gives a bound above zero when no event was seen', () => {
    // 1 - 0.05 ** (1 / 20), about 13.9 percent.
    expect(clopperPearsonUpper(0, 20, 0.95)).toBeCloseTo(1 - 0.05 ** (1 / 20), 6);
    expect(clopperPearsonUpper(0, 20, 0.95)).toBeCloseTo(0.139, 3);
    expect(clopperPearsonLower(0, 20, 0.95)).toBe(0);
  });

  it('matches known values of the beta distribution and brackets the observed rate', () => {
    expect(betaCdf(0.5, 2, 2)).toBeCloseTo(0.5, 9);
    expect(betaCdf(0.25, 1, 3)).toBeCloseTo(1 - 0.75 ** 3, 9);
    const upper = clopperPearsonUpper(3, 20, 0.95);
    const lower = clopperPearsonLower(3, 20, 0.95);
    expect(lower).toBeLessThan(0.15);
    expect(upper).toBeGreaterThan(0.15);
    // At the upper bound, seeing 3 or fewer events out of 20 has a probability of 5 percent.
    const binomialCdf = (k: number, n: number, p: number) => Array.from({ length: k + 1 }, (_, i) => {
      let choose = 1;
      for (let j = 1; j <= i; j++) choose = (choose * (n - j + 1)) / j;
      return choose * p ** i * (1 - p) ** (n - i);
    }).reduce((a, b) => a + b, 0);
    expect(binomialCdf(3, 20, upper)).toBeCloseTo(0.05, 6);
    // At the lower bound, seeing 3 or more events has a probability of 5 percent.
    expect(1 - binomialCdf(2, 20, lower)).toBeCloseTo(0.05, 6);
  });
});

describe('paired bootstrap', () => {
  it('gives the same bounds for the same seed and shows when every difference is zero', () => {
    const units = Array.from({ length: 12 }, (_, index) => ({ cluster: `r${index % 4}`, value: index % 3 === 0 ? 1 : 0 }));
    const mean = (sample: readonly number[]) => sample.reduce((a, b) => a + b, 0) / sample.length;
    const options = { confidence: 0.95, seed: seedFromText('campaign'), clustered: true };
    expect(bootstrap(units, mean, options)).toEqual(bootstrap(units, mean, options));
    const zeros = units.map((unit) => ({ ...unit, value: 0 }));
    expect(bootstrap(zeros, mean, options)).toEqual({ estimate: 0, lower: 0, upper: 0 });
    expect(isDegenerate(zeros.map((unit) => unit.value))).toBe(true);
    expect(isDegenerate([0, 0.5])).toBe(false);
  });
});
