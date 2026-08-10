import { describe, it, expect } from 'vitest';
import { resolveSlugAll, resolveRows } from './matcher.js';
import type { BenchModel } from './types.js';

const registry = [
  { provider: 'anthropic', id: 'claude-opus-4-6-20260115' },
  { provider: 'anthropic', id: 'claude-sonnet-4-20260201' },
  { provider: 'openai', id: 'gpt-4o' },
  { provider: 'openai', id: 'gpt-4o-mini' },
  { provider: 'deepseek', id: 'deepseek-chat-v3' },
  { provider: 'deepseek', id: 'deepseek-chat-v3.1' },
];

describe('resolveSlugAll — canonical single targets', () => {
  // The single-target resolution entry point no longer exists; these pin the
  // shipped resolveSlugAll behavior for the same inputs. "Prefers the shorter
  // id" tie-breaking was a property of the deleted wrapper — identity-key
  // equality already keeps longer siblings out (asserted in the collapse
  // tests), so the shipped function has no tie to break for these inputs.
  it('matches exact provider/id', () => {
    expect(resolveSlugAll('anthropic/claude-opus-4-6-20260115', registry)).toEqual([
      'anthropic/claude-opus-4-6-20260115',
    ]);
  });

  it('matches exact bare id', () => {
    expect(resolveSlugAll('gpt-4o', registry)).toEqual(['openai/gpt-4o']);
  });

  it('matches fuzzy slug to registry id', () => {
    expect(resolveSlugAll('claude-opus-4-6', registry)).toEqual([
      'anthropic/claude-opus-4-6-20260115',
    ]);
  });

  it('does not collapse opus and sonnet', () => {
    const sonnetMatch = resolveSlugAll('claude-sonnet-4', registry);
    expect(sonnetMatch).toEqual(['anthropic/claude-sonnet-4-20260201']);
    const opusMatch = resolveSlugAll('claude-opus-4-6', registry);
    expect(opusMatch[0]?.toLowerCase()).toContain('opus');
    expect(sonnetMatch[0]?.toLowerCase()).toContain('sonnet');
  });

  it('does not collapse gpt-4o and gpt-4o-mini', () => {
    // gpt-4o-mini's identity key contains gpt-4o as a prefix but differs as a
    // token sequence, so the bare slug binds only its exact row.
    expect(resolveSlugAll('gpt-4o', registry)).toEqual(['openai/gpt-4o']);
    expect(resolveSlugAll('gpt-4o-mini', registry)).toEqual(['openai/gpt-4o-mini']);
  });

  it('respects version suffixes', () => {
    expect(resolveSlugAll('deepseek-v3', registry)).toEqual(['deepseek/deepseek-chat-v3']);
  });

  it('uses alias map over fuzzy matching', () => {
    const aliases = { 'weird-slug': 'openai/gpt-4o' };
    expect(resolveSlugAll('weird-slug', registry, aliases)).toEqual(['openai/gpt-4o']);
  });

  it('returns an empty list when uncertain', () => {
    expect(resolveSlugAll('totally-unknown-model', registry)).toEqual([]);
  });
});

describe('resolveRows', () => {
  it('marks rows active/inactive based on resolution', () => {
    const rows: Omit<BenchModel, 'registryId' | 'active'>[] = [
      { benchSlug: 'gpt-4o', quality: {}, source: 'aa' },
      { benchSlug: 'unknown-model', quality: {}, source: 'aa' },
    ];
    const resolved = resolveRows(rows, registry);
    expect(resolved[0].active).toBe(true);
    expect(resolved[1].active).toBe(false);
  });
});

// ─── Regressions from live Artificial Analysis data ──────────────────

const multiProvider = [
  { provider: 'opencode', id: 'claude-opus-4-6' },
  { provider: 'github-copilot', id: 'claude-opus-4.6' },
  { provider: 'amazon-bedrock', id: 'anthropic.claude-opus-4-6-20260115' },
  { provider: 'github-copilot', id: 'gpt-4.1' },
  { provider: 'github-copilot', id: 'gpt-5-mini' },
  { provider: 'github-copilot', id: 'claude-sonnet-4' },
  { provider: 'github-copilot', id: 'gpt-5.4' },
  { provider: 'opencode-go', id: 'qwen3.7-max' },
  { provider: 'opencode-go', id: 'hy3' },
];

describe('resolveSlugAll — one benchmark row, many providers', () => {
  it('binds a slug to every provider serving that model', () => {
    const all = resolveSlugAll('claude-opus-4-6', multiProvider);
    expect(all).toContain('opencode/claude-opus-4-6');
    expect(all).toContain('github-copilot/claude-opus-4.6');
  });

  it('treats dotted and dashed versions as the same model', () => {
    expect(resolveSlugAll('claude-opus-4-6', multiProvider)).toContain(
      'github-copilot/claude-opus-4.6',
    );
  });

  it('strips effort suffixes that describe a run, not a model', () => {
    expect(resolveSlugAll('claude-opus-4-6-thinking', multiProvider)).toContain(
      'github-copilot/claude-opus-4.6',
    );
    expect(resolveSlugAll('claude-opus-4-6-adaptive', multiProvider)).toContain(
      'github-copilot/claude-opus-4.6',
    );
    expect(resolveSlugAll('hy3-preview', multiProvider)).toContain('opencode-go/hy3');
  });

  // Effort levels beyond the original set (high/medium/off) became strippable
  // when benchmark identity became (model, effort): the level is carried on the
  // row, so the slug suffix is run metadata, not identity. `max` stays
  // identity (qwen3.7-max pin below) because it is a real tier token.
  it('strips high/medium effort suffixes that describe a run, not a model', () => {
    const reg = [{ provider: 'github-copilot', id: 'claude-opus-5' }];
    expect(resolveSlugAll('claude-opus-5-high', reg)).toEqual(['github-copilot/claude-opus-5']);
    expect(resolveSlugAll('claude-opus-5-medium', reg)).toEqual(['github-copilot/claude-opus-5']);
    expect(resolveSlugAll('claude-opus-5-off', reg)).toEqual(['github-copilot/claude-opus-5']);
  });

  it('normalizes only source-backed benchmark run variants', () => {
    const variants = [
      { provider: 'github-copilot', id: 'gemini-3.6-flash' },
      { provider: 'deepseek', id: 'deepseek-v4-flash' },
      { provider: 'deepseek', id: 'deepseek-v4-flash-0420' },
      { provider: 'deepseek', id: 'deepseek-v4-pro' },
    ];
    expect(resolveSlugAll('gemini-3-6-flash', variants)).toContain('github-copilot/gemini-3.6-flash');
    expect(resolveSlugAll('deepseek-v4-flash-0420', variants)).toEqual(['deepseek/deepseek-v4-flash']);
    expect(resolveSlugAll('deepseek-v4-pro-high', variants)).toEqual(['deepseek/deepseek-v4-pro']);
  });

  it('does not discard ambiguous four-digit identity suffixes', () => {
    expect(resolveSlugAll('qwen3-235b-a22b-2507', [{ provider: 'p', id: 'qwen3-235b-a22b' }])).toEqual([]);
  });
});

describe('resolveSlugAll — identity is preserved', () => {
  // Each of these was a real mis-binding: benchmark scores from one model
  // silently attached to a different one.
  it('does not attach a size variant to the base model', () => {
    expect(resolveSlugAll('gpt-4-1-nano', multiProvider)).not.toContain('github-copilot/gpt-4.1');
    expect(resolveSlugAll('gpt-5-minimal', multiProvider)).not.toContain(
      'github-copilot/gpt-5-mini',
    );
    expect(resolveSlugAll('gpt-5-4-pro', multiProvider)).not.toContain('github-copilot/gpt-5.4');
  });

  it('does not attach a newer point release to an older model', () => {
    expect(resolveSlugAll('claude-sonnet-4-6-non-reasoning-low-effort', multiProvider)).not.toContain(
      'github-copilot/claude-sonnet-4',
    );
  });

  it('keeps tier tokens that are part of the model name', () => {
    // "max" here is identity, not an effort level.
    expect(resolveSlugAll('qwen3-7-max', multiProvider)).toContain('opencode-go/qwen3.7-max');
    expect(resolveSlugAll('qwen3-7', multiProvider)).toHaveLength(0);
  });

  it('strips the free pricing-tier suffix so free and paid variants share benchmark data', () => {
    const freeReg = [
      { provider: 'opencode-go', id: 'deepseek-v4-flash' },
      { provider: 'opencode', id: 'deepseek-v4-flash-free' },
      { provider: 'opencode', id: 'deepseek-v4-pro' },
    ];
    // The free variant binds the same benchmark slug as the paid variant.
    const all = resolveSlugAll('deepseek-v4-flash-non-reasoning', freeReg);
    expect(all).toContain('opencode-go/deepseek-v4-flash');
    expect(all).toContain('opencode/deepseek-v4-flash-free');
    // Pro is a different model — must not bind.
    expect(all).not.toContain('opencode/deepseek-v4-pro');
  });

  it('does not collapse a model with "free" embedded in its name (not a suffix)', () => {
    // e.g. a hypothetical "freedom-v1" is not the same as "v1"
    const reg = [
      { provider: 'p', id: 'freedom-v1' },
      { provider: 'p', id: 'v1' },
    ];
    // Benchmark slug 'v1' should NOT bind to 'freedom-v1' because 'free'
    // is embedded in the word, not a standalone token.
    const all = resolveSlugAll('v1', reg);
    expect(all).not.toContain('p/freedom-v1');
  });

  it('falls back to identity matching when an alias target is absent', () => {
    const reg = [{ provider: 'p', id: 'model-x' }];
    expect(resolveSlugAll('model-x', reg, { 'model-x': 'missing/model' })).toEqual(['p/model-x']);
  });

  it('adds an alias target without unbinding providers that already match by identity', () => {
    const reg = [
      { provider: 'a', id: 'gpt-5.3-codex' },
      { provider: 'b', id: 'gpt-5.3-codex' },
      { provider: 'c', id: 'gpt-5.3-codex-spark' },
    ];
    const all = resolveSlugAll('gpt-5-3-codex', reg, { 'gpt-5-3-codex': 'c/gpt-5.3-codex-spark' });
    expect(all).toEqual(['a/gpt-5.3-codex', 'b/gpt-5.3-codex', 'c/gpt-5.3-codex-spark']);
  });

  it('expands an alias across every provider copy of the target identity', () => {
    const reg = [
      { provider: 'claude-bridge', id: 'claude-fable-5' },
      { provider: 'github-copilot', id: 'claude-fable-5' },
      { provider: 'opencode', id: 'claude-fable-5' },
    ];
    // benchlm names Claude Fable 5 with the version digit dropped; the alias
    // target is arbitrary because the expansion binds all provider copies.
    const all = resolveSlugAll('claude-fable', reg, {
      'claude-fable': 'opencode/claude-fable-5',
    });
    expect(all).toEqual([
      'claude-bridge/claude-fable-5',
      'github-copilot/claude-fable-5',
      'opencode/claude-fable-5',
    ]);
  });

  it('leaves a supplementary alias provider-specific when identity already bound the model', () => {
    const reg = [
      { provider: 'opencode-go', id: 'mimo-v2.5-pro' },
      { provider: 'opencode-go', id: 'mimo-v2.5' },
      { provider: 'opencode', id: 'mimo-v2.5-free' },
    ];
    const all = resolveSlugAll('mimo-v2-5-pro', reg, {
      'mimo-v2-5-pro': 'opencode-go/mimo-v2.5',
    });
    // Identity matching already bound the .pro copy, so the alias stays a
    // single provider pin and does not drag the .free copy in with the .pro
    // score.
    expect(all).toEqual(['opencode-go/mimo-v2.5', 'opencode-go/mimo-v2.5-pro']);
  });

  it('matches max-effort run variants to the base model across providers', () => {
    const reg = [
      { provider: 'deepseek', id: 'deepseek-v4-pro' },
      { provider: 'opencode', id: 'deepseek-v4-pro' },
      { provider: 'opencode', id: 'deepseek-v4-pro-lite' },
    ];
    expect(resolveSlugAll('deepseek-v4-pro-max', reg)).toEqual([
      'deepseek/deepseek-v4-pro',
      'opencode/deepseek-v4-pro',
    ]);
  });

  it('strips :free suffix from openrouter-style model ids', () => {
    const reg = [
      { provider: 'openrouter', id: 'deepseek/deepseek-r1:free' },
      { provider: 'openrouter', id: 'deepseek/deepseek-r1' },
    ];
    // Both variants share the same identity and bind the same benchmark slug.
    const all = resolveSlugAll('deepseek-r1', reg);
    expect(all).toContain('openrouter/deepseek/deepseek-r1:free');
    expect(all).toContain('openrouter/deepseek/deepseek-r1');
  });
});

describe('resolveRows — effort variants', () => {
  it('emits one active row per matching provider', () => {
    const rows = resolveRows(
      [{ benchSlug: 'claude-opus-4-6', quality: { intelligence: 90 }, source: 'aa' }],
      multiProvider,
    );
    const active = rows.filter((r) => r.active);
    expect(active.length).toBeGreaterThanOrEqual(2);
    expect(new Set(active.map((r) => r.registryId)).size).toBe(active.length);
    expect(active.every((r) => r.quality.intelligence === 90)).toBe(true);
  });

  it('resolves each effort row to the same model, carrying its parsed effort', () => {
    const rows = resolveRows(
      [
        { benchSlug: 'claude-opus-5-xhigh', effort: 'xhigh', quality: { intelligence: 60.1 }, source: 'aa' },
        { benchSlug: 'claude-opus-5-medium', effort: 'medium', quality: { intelligence: 55.2 }, source: 'aa' },
      ],
      [{ provider: 'github-copilot', id: 'claude-opus-5' }],
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.registryId === 'github-copilot/claude-opus-5' && r.active)).toBe(true);
    expect(rows.map((r) => r.effort).sort()).toEqual(['medium', 'xhigh']);
    expect(rows.find((r) => r.effort === 'xhigh')?.quality.intelligence).toBe(60.1);
  });

  it('still records a single inactive row for an unmatched slug', () => {
    const rows = resolveRows([{ benchSlug: 'no-such-model', quality: {}, source: 'aa' }], multiProvider);
    expect(rows).toHaveLength(1);
    expect(rows[0].active).toBe(false);
  });
});
