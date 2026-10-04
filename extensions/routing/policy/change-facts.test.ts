import { describe, expect, it } from 'vitest';
import { defaultRequirement, FRONTIER_REQUIREMENT } from '../score/scorer.js';
import {
  checkedAnswers,
  factCodes,
  factsLog,
  factsRequirement,
  MAX_FACT_ITEMS,
  parseDeclaredFacts,
  type DeclaredFacts,
} from './change-facts.js';

const DECLARED = {
  check: { commands: ['npm test'], state: 'fails' },
  changes: { modify: ['src/queue.ts'], create: ['src/index.ts'] },
  precedent: 'src/sleep.ts',
  decisions: ['retry policy'],
  unknowns: [],
  external: ['node:timers'],
  irreversible: [],
  answers: {
    defect: 'N', rewrites: 'Y', mapping: 'N', ordering: 'Y', specMissing: 'N', reproMissing: 'N',
    visual: 'N', performance: 'N', security: 'U', dataIntegrity: 'N',
  },
  domains: ['backend', 'tooling'],
};

describe('parseDeclaredFacts', () => {
  it('keeps every valid field and keeps an empty list as a fact', () => {
    expect(parseDeclaredFacts(DECLARED)).toEqual({
      checkCommands: ['npm test'], checkState: 'fails', modify: ['src/queue.ts'], create: ['src/index.ts'],
      precedent: 'src/sleep.ts', decisions: ['retry policy'], unknowns: [], external: ['node:timers'], irreversible: [],
      answers: DECLARED.answers, domains: ['backend', 'tooling'],
    });
  });

  it('drops values that do not parse instead of guessing them', () => {
    expect(parseDeclaredFacts({
      check: { commands: 'npm test', state: 'green' },
      decisions: [' ', 3, 'a', 'a'],
      answers: { rewrites: 1, mapping: 'yes', ordering: 'y', specMissing: 'NA', visual: 'U' },
      domains: ['frontend', 'mobile'],
    })).toEqual({ decisions: ['a'], answers: { visual: 'U' }, domains: ['frontend'] });
    expect(parseDeclaredFacts(undefined)).toBeUndefined();
    expect(parseDeclaredFacts({ answers: { rewrites: 0.9 } })).toBeUndefined();
  });

  it('bounds the size of a declaration', () => {
    const long = 'x'.repeat(1000);
    const facts = parseDeclaredFacts({ unknowns: Array.from({ length: 50 }, (_, i) => `${i}${long}`) })!;
    expect(facts.unknowns).toHaveLength(MAX_FACT_ITEMS);
    expect(Math.max(...facts.unknowns!.map((item) => item.length))).toBeLessThanOrEqual(300);
  });
});

describe('factCodes', () => {
  it('logs counts and codes, never the model-written text', () => {
    const codes = factCodes(parseDeclaredFacts(DECLARED));
    const json = JSON.stringify(codes);
    for (const written of ['npm test', 'src/queue.ts', 'src/index.ts', 'src/sleep.ts', 'retry policy', 'node:timers']) {
      expect(json).not.toContain(written);
    }
    expect(codes).toMatchObject({ checkCommands: 1, checkState: 'fails', modify: 1, create: 1, precedent: true, decisions: 1, unknowns: 0 });
  });
});

describe('factsRequirement', () => {
  it('keeps the task type default when no fact is known', () => {
    for (const dimension of ['implement', 'plan', 'review'] as const) {
      expect(factsRequirement(dimension, undefined, {})).toBeCloseTo(defaultRequirement(dimension), 3);
    }
  });

  it('stays between the economy minimum and the frontier requirement', () => {
    const hardest: DeclaredFacts = {
      decisions: ['a', 'b', 'c'], unknowns: ['a', 'b', 'c'], external: ['x'],
      answers: { rewrites: 'Y', mapping: 'N', ordering: 'Y', specMissing: 'Y' },
    };
    const hard = factsRequirement('plan', hardest, { files: 9, directories: 6, existingLines: 9000, fixCommits: 9, fanIn: 40, scoutFiles: 20 });
    expect(hard).toBe(FRONTIER_REQUIREMENT);
    const easiest: DeclaredFacts = { decisions: [], precedent: 'p', answers: { rewrites: 'N', mapping: 'Y', ordering: 'N' } };
    expect(factsRequirement('implement', easiest, { files: 1, precedentExists: true })).toBeGreaterThanOrEqual(0.30);
  });

  it('puts a mechanical change below the default band and a design-heavy one above it', () => {
    const mechanical = factsLog('implement', { decisions: [], precedent: 'p', answers: { rewrites: 'N', mapping: 'Y' } }, { files: 1, precedentExists: true });
    const design = factsLog('implement', { decisions: ['a', 'b', 'c'], answers: { rewrites: 'Y', ordering: 'Y' } }, { files: 7, directories: 4 });
    expect(mechanical.shadow.band).toBe('economy');
    expect(['strong', 'frontier']).toContain(design.shadow.band);
    expect(mechanical.shadow.used).toBeCloseTo(defaultRequirement('implement'), 6);
  });

  it('never lowers the requirement when a fact gets harder', () => {
    const at = (facts: DeclaredFacts) => factsRequirement('implement', facts, {});
    expect(at({ decisions: ['a', 'b'] })).toBeGreaterThanOrEqual(at({ decisions: ['a'] }));
    expect(at({ unknowns: ['a', 'b'] })).toBeGreaterThanOrEqual(at({ unknowns: ['a'] }));
    for (const question of ['rewrites', 'ordering'] as const) {
      expect(at({ answers: { [question]: 'Y' } })).toBeGreaterThan(at({ answers: { [question]: 'U' } }));
      expect(at({ answers: { [question]: 'U' } })).toBeGreaterThan(at({ answers: { [question]: 'N' } }));
    }
    expect(at({ answers: { mapping: 'N' } })).toBeGreaterThan(at({ answers: { mapping: 'Y' } }));
    expect(at({ external: ['vendor'], answers: { specMissing: 'Y' } })).toBeGreaterThan(at({ external: ['vendor'], answers: { specMissing: 'N' } }));
  });

  it('counts U as no answer: unknown does not lower the requirement', () => {
    const at = (facts: DeclaredFacts) => factsRequirement('implement', facts, {});
    expect(at({ answers: { rewrites: 'U', mapping: 'U', ordering: 'U' } })).toBe(at({}));
    // Outside behavior with an unknown description counts as undescribed.
    expect(at({ external: ['vendor'], answers: { specMissing: 'U' } })).toBe(at({ external: ['vendor'], answers: { specMissing: 'Y' } }));
    expect(at({ external: ['vendor'] })).toBe(at({ external: ['vendor'], answers: { specMissing: 'Y' } }));
  });

  it('gives no credit for a precedent the router could not find', () => {
    const facts: DeclaredFacts = { precedent: 'src/missing.ts' };
    expect(factsRequirement('implement', facts, { precedentExists: false })).toBe(factsRequirement('implement', undefined, {}));
    expect(factsRequirement('implement', facts, { precedentExists: true })).toBeLessThan(factsRequirement('implement', undefined, {}));
  });

  it('leaves the requirement unchanged by check, look, speed, reproduction, and irreversible answers', () => {
    const base = factsRequirement('implement', undefined, {});
    const assurance: DeclaredFacts = {
      checkCommands: [], checkState: 'none', irreversible: ['migration'],
      answers: { visual: 'Y', performance: 'Y', reproMissing: 'Y', defect: 'Y' },
    };
    expect(factsRequirement('implement', assurance, { coveringTests: 0, typeChecker: false, visualTool: false })).toBe(base);
  });
});

describe('checkedAnswers', () => {
  it('ignores a rewrite that the declared changes contradict: no file that exists changes', () => {
    const facts: DeclaredFacts = { modify: [], create: ['src/queue.ts'], answers: { rewrites: 'Y', ordering: 'Y' } };
    expect(checkedAnswers(facts)).toEqual({ answers: { ordering: 'Y' }, ignored: ['rewrites'] });
    expect(factsRequirement('implement', facts, {})).toBe(factsRequirement('implement', { answers: { ordering: 'Y' } }, {}));
    // N agrees with an empty list, and an unknown list contradicts nothing.
    expect(checkedAnswers({ modify: [], answers: { rewrites: 'N' } }).ignored).toEqual([]);
    expect(checkedAnswers({ answers: { rewrites: 'Y' } }).ignored).toEqual([]);
  });

  it('ignores answers that do not apply', () => {
    expect(checkedAnswers({ external: [], answers: { specMissing: 'Y' } }).ignored).toEqual(['specMissing']);
    expect(checkedAnswers({ external: [], answers: { specMissing: 'N' } }).ignored).toEqual([]);
    expect(checkedAnswers({ answers: { defect: 'N', reproMissing: 'Y' } }).ignored).toEqual(['reproMissing']);
    expect(checkedAnswers({ answers: { defect: 'Y', reproMissing: 'Y' } }).ignored).toEqual([]);
  });

  it('logs which answers it ignored, next to the answers as given', () => {
    const codes = factCodes({ modify: [], external: [], answers: { rewrites: 'Y', specMissing: 'Y' } });
    expect(codes.answers).toEqual({ rewrites: 'Y', specMissing: 'Y' });
    expect(codes.ignored).toEqual(['rewrites', 'specMissing']);
  });

  it('leaves the requirement unchanged by security and stored-data answers', () => {
    expect(factsRequirement('implement', { answers: { security: 'Y', dataIntegrity: 'Y', defect: 'Y' } }, {}))
      .toBe(factsRequirement('implement', undefined, {}));
  });
});
