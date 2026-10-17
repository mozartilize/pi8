import { describe, it, expect } from 'vitest';
import {
  buildCandidate,
  buildRouterThinkingLevelMap,
  chooseThinkingLevel,
  levelFrom,
  resolveThinkingLevel,
  findSourceCandidate,
  servedEffort,
  type RegistryModelInfo,
  servesThinkingOff,
} from './scorer.js';
import { benchRow, candidate, registryModel } from '../../test-support/router-fixtures.js';

describe('scorer', () => {
  describe('candidates and thinking levels', () => {
    it('buildCandidate merges registry metadata', () => {
      const model = registryModel('openai/gpt-4o', {
        contextWindow: 128000,
        input: ['text', 'image'],
        cost: { input: 2.5, output: 10, cacheRead: 0.25, cacheWrite: 3.75 },
      });
      const c = buildCandidate(model);
      expect(c.registryId).toBe('openai/gpt-4o');
      expect(c.vision).toBe(true);
      expect(c.contextWindow).toBe(128000);
      expect(c.cost?.input).toBe(2.5);
    });

    it('marks effort as sharing the cache only for per-message effort on anthropic-messages', () => {
      const perMessage = { supportsMidConvoEffort: true };
      expect(buildCandidate(registryModel('a/claude', { api: 'anthropic-messages', compat: perMessage })).effortSharesCache)
        .toBe(true);
      expect(buildCandidate(registryModel('a/claude', { api: 'anthropic-messages' })).effortSharesCache).toBeUndefined();
      expect(buildCandidate(registryModel('o/gpt', { api: 'openai-responses', compat: perMessage })).effortSharesCache)
        .toBeUndefined();
    });

    it('preserves an explicit reasoning level when the model supports it', () => {
      const model = candidate('test/model-1', {
        reasoning: true,
        thinkingLevelMap: { off: 'off', low: 'low', high: 'high', xhigh: null, max: null },
      });
      expect(resolveThinkingLevel(model, 'low')).toBe('low');
    });

    it('clamps an unsupported explicit reasoning request to the nearest supported level', () => {
      const model = candidate('test/model-1', {
        reasoning: true,
        thinkingLevelMap: { off: 'off', low: null, medium: null, high: 'high', xhigh: null, max: null },
      });
      expect(resolveThinkingLevel(model, 'max')).toBe('high');
    });

    // ── The scored effort is served; each effort has its own score ──

    it('serves the scored effort for every task type, below any former per-task level too', () => {
      const model = candidate('test/model-1', {
        reasoning: true,
        effort: 'low',
        thinkingLevelMap: { off: 'off', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
      });
      expect(chooseThinkingLevel(model)).toBe('low');
      expect(resolveThinkingLevel(model, undefined)).toBe('low');
      expect(servedEffort(model)).toBe('low');
    });

    it('serves an off measurement as off', () => {
      const model = candidate('test/model-1', {
        reasoning: true,
        effort: 'off',
        thinkingLevelMap: { off: 'off', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
      });
      expect(chooseThinkingLevel(model)).toBe('off');
    });

    it('makes no router effort choice for a candidate with no effort label, so Pi\'s session level applies', () => {
      const model = candidate('test/model-1', {
        reasoning: true,
        thinkingLevelMap: { off: 'off', low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null },
      });
      expect(chooseThinkingLevel(model)).toBeUndefined();
      expect(resolveThinkingLevel(model, 'high')).toBe('high');
      // Pi's level is fitted to the nearest level the model supports.
      expect(resolveThinkingLevel(model, 'max')).toBe('high');
    });

    it('lets an explicit user reasoning level suppress the router effort choice', () => {
      const model = candidate('test/model-1', {
        reasoning: true,
        effort: 'low',
        thinkingLevelMap: { off: 'off', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
      });
      // The router would serve the scored low, but the user asked for high.
      expect(resolveThinkingLevel(model, 'high')).toBe('high');
    });

    it('drops an effort the model cannot serve instead of sending it', () => {
      const model = candidate('test/model-1', {
        reasoning: true,
        effort: 'low',
        thinkingLevelMap: { off: 'off', low: null, medium: null, high: null, xhigh: null, max: null },
      });
      // Nothing at or above the measured low is supported: no reasoning is
      // sent rather than an unsupported level.
      expect(chooseThinkingLevel(model)).toBeUndefined();
    });

    // A router-chosen effort walks up only: a gap in the support map never
    // serves below the scored effort, even where the nearest-first walk that
    // honours a user request would pick a lower level.
    it('levelFrom walks up-only from the scored effort', () => {
      // A provider whose map lacks high/xhigh but supports max (e.g. a model
      // with {off, low, medium, max} and no high/xhigh entries).
      const model = candidate('test/model-1', {
        reasoning: true,
        effort: 'high',
        thinkingLevelMap: { off: 'off', low: 'low', medium: 'medium', high: null, xhigh: null, max: 'max' },
      });
      // levelFrom from high: walks up → xhigh (unsupported) → max (supported) = 'max'
      expect(levelFrom('high', model)).toBe('max');
      expect(chooseThinkingLevel(model)).toBe('max');
      // Nearest-first (resolveThinkingLevel) would return 'medium' — prove the divergence:
      expect(resolveThinkingLevel(model, 'high')).toBe('medium');
    });

    it('builds a router thinking-level map from the union of registry capabilities', () => {
      const models: RegistryModelInfo[] = [
        registryModel('test/a', { reasoning: true, thinkingLevelMap: { off: 'off', low: 'low', high: 'high', xhigh: null, max: null } }),
        registryModel('test/b', { reasoning: true, thinkingLevelMap: { off: 'off', high: 'high', xhigh: null, max: 'max' } }),
      ];
      const map = buildRouterThinkingLevelMap(models);
      expect(map.low).toBe('low');
      expect(map.high).toBe('high');
      expect(map.max).toBe('max');
      expect(map.medium).toBe('medium');
    });
  });
});

describe('findSourceCandidate', () => {
  it('resolves an unsuffixed row against an effective served effort', () => {
    const weak = candidate('test/weak', {
      bench: benchRow('test/weak', { quality: { intelligence: 60, coding: 60, agenticCoding: 60 } }),
    });
    const strong = candidate('test/strong', {
      bench: benchRow('test/strong', { quality: { intelligence: 90, coding: 90, agenticCoding: 90 } }),
    });
    const source = findSourceCandidate([weak, strong], 'test/weak:medium');
    expect(source?.registryId).toBe('test/weak');
  });

  it('does not use a different effort variant as the source measurement', () => {
    const low = candidate('test/model', {
      effort: 'low',
      bench: benchRow('test/model', { effort: 'low', quality: { intelligence: 40 } }),
    });
    const high = candidate('test/model', {
      effort: 'high',
      bench: benchRow('test/model', { effort: 'high', quality: { intelligence: 90 } }),
    });
    expect(findSourceCandidate([low, high], 'test/model:medium')).toBeUndefined();
  });
});

describe('thinking off', () => {
  it('follows Pi: a null off entry is unsupported, so the up-only walk skips it', () => {
    const model = { reasoning: true, thinkingLevelMap: { off: null, low: 'low', medium: 'medium' } };
    expect(levelFrom('off', model)).toBe('minimal');
    expect(levelFrom('off', { reasoning: true, thinkingLevelMap: { off: 'none' } })).toBe('off');
    expect(levelFrom('off', { reasoning: true })).toBe('off');
  });

  it('serves off for a model without reasoning, and for a reasoning model only where off is sent', () => {
    expect(servesThinkingOff(registryModel('p/plain', { reasoning: false }))).toBe(true);
    expect(servesThinkingOff(registryModel('p/model', { reasoning: true, thinkingLevelMap: { off: 'off' } }))).toBe(true);
    expect(servesThinkingOff(registryModel('p/model', { reasoning: true, thinkingLevelMap: { off: null } }))).toBe(false);
    expect(servesThinkingOff(registryModel('claude-bridge/model', { reasoning: true }))).toBe(false);
  });
});

describe('nearest thinking level for a user request', () => {
  it('walks up first, then down, to the nearest supported level', () => {
    const upToHigh = { reasoning: true, thinkingLevelMap: { off: 'off', minimal: null, low: 'low', medium: 'medium', high: 'high' } };
    expect(resolveThinkingLevel(upToHigh, 'max')).toBe('high');
    expect(resolveThinkingLevel(upToHigh, 'minimal')).toBe('low');
    expect(resolveThinkingLevel(upToHigh, 'medium')).toBe('medium');
    expect(resolveThinkingLevel({ reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null } }, 'low')).toBeUndefined();
  });
});
