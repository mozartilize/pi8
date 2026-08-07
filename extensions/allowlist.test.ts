/**
 * Model allowlist tests.
 *
 * The allowlist is the user's blunt instrument for keeping the router inside a
 * known-good set of models, so the important properties are: absent config
 * routes everything (backwards compatible), a provider glob selects a whole
 * provider, an exact id selects exactly one model, and nothing matches by
 * accident (substring/prefix leakage).
 */
import { describe, it, expect } from 'vitest';

import { buildModelFilter, buildExcludeFilter } from './allowlist.js';

const REGISTRY_IDS = [
  'github-copilot/claude-opus-4.8',
  'github-copilot/gpt-5.4',
  'github-copilot/kimi-k2.7-code',
  'opencode-go/deepseek-v4-pro',
  'opencode-go/deepseek-v4-flash',
  'opencode-go/qwen3.7-max',
  'anthropic/claude-opus-4-6',
];

const allowed = (patterns?: string[]): string[] =>
  REGISTRY_IDS.filter(buildModelFilter(patterns));

describe('buildModelFilter — allow-all fallbacks', () => {
  it('allows everything when undefined', () => {
    expect(allowed(undefined)).toEqual(REGISTRY_IDS);
  });

  it('allows everything for an empty list', () => {
    expect(allowed([])).toEqual(REGISTRY_IDS);
  });

  it('allows everything when every entry is blank', () => {
    expect(allowed(['', '   '])).toEqual(REGISTRY_IDS);
  });
});

describe('buildModelFilter — selection', () => {
  it('selects a whole provider with a glob', () => {
    expect(allowed(['github-copilot/*'])).toEqual([
      'github-copilot/claude-opus-4.8',
      'github-copilot/gpt-5.4',
      'github-copilot/kimi-k2.7-code',
    ]);
  });

  it('treats a bare provider name as provider/*', () => {
    expect(allowed(['github-copilot'])).toEqual(allowed(['github-copilot/*']));
  });

  it('selects a single exact model', () => {
    expect(allowed(['opencode-go/deepseek-v4-pro'])).toEqual(['opencode-go/deepseek-v4-pro']);
  });

  it('combines a provider glob and an exact model (the documented example)', () => {
    expect(allowed(['github-copilot/*', 'opencode-go/deepseek-v4-pro'])).toEqual([
      'github-copilot/claude-opus-4.8',
      'github-copilot/gpt-5.4',
      'github-copilot/kimi-k2.7-code',
      'opencode-go/deepseek-v4-pro',
    ]);
  });

  it('supports a wildcard in the model id', () => {
    expect(allowed(['opencode-go/deepseek-*'])).toEqual([
      'opencode-go/deepseek-v4-pro',
      'opencode-go/deepseek-v4-flash',
    ]);
  });

  it('yields nothing when no pattern matches', () => {
    expect(allowed(['nope/nothing'])).toEqual([]);
  });
});

describe('pattern matching — no accidental matches', () => {
  // Exercised through the shipped entry point: a leaked match here is a real
  // routing bug. (Blank/whitespace-only patterns are allow-all at this entry
  // point — covered by the allow-all fallbacks describe above.)
  const matches = (registryId: string, pattern: string) =>
    buildModelFilter([pattern])(registryId);

  it('anchors the pattern (no substring or prefix leakage)', () => {
    // `deepseek-v4-pro` must not be selected by a shorter prefix.
    expect(matches('opencode-go/deepseek-v4-pro', 'opencode-go/deepseek-v4')).toBe(false);
    // A provider prefix must not select a different provider.
    expect(matches('github-copilot-x/gpt-5.4', 'github-copilot/*')).toBe(false);
  });

  it('does not let dots act as regex wildcards', () => {
    expect(matches('github-copilot/gpt-5x4', 'github-copilot/gpt-5.4')).toBe(false);
    expect(matches('github-copilot/gpt-5.4', 'github-copilot/gpt-5.4')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(matches('GitHub-Copilot/GPT-5.4', 'github-copilot/*')).toBe(true);
  });
});

describe('buildExcludeFilter — blacklist semantics', () => {
  const excluded = (patterns?: string[]): string[] =>
    REGISTRY_IDS.filter(buildExcludeFilter(patterns));

  it('excludes nothing when undefined, empty, or all-blank', () => {
    expect(excluded(undefined)).toEqual([]);
    expect(excluded([])).toEqual([]);
    expect(excluded(['', '  '])).toEqual([]);
  });

  it('excludes a whole provider with a provider glob', () => {
    expect(excluded(['github-copilot/*'])).toEqual([
      'github-copilot/claude-opus-4.8',
      'github-copilot/gpt-5.4',
      'github-copilot/kimi-k2.7-code',
    ]);
  });

  it('excludes a bare provider name as provider/*', () => {
    expect(excluded(['github-copilot'])).toEqual(excluded(['github-copilot/*']));
  });

  it('excludes matching models across providers with a leading wildcard', () => {
    // No "gemini" ids in the fixture set, so exercise the same shape with a
    // token that IS present across providers.
    expect(excluded(['*/deepseek*'])).toEqual([
      'opencode-go/deepseek-v4-pro',
      'opencode-go/deepseek-v4-flash',
    ]);
  });

  it('excludes a single exact model', () => {
    expect(excluded(['opencode-go/deepseek-v4-pro'])).toEqual(['opencode-go/deepseek-v4-pro']);
  });

  it('combines multiple patterns', () => {
    expect(excluded(['github-copilot/*', 'opencode-go/deepseek-v4-pro'])).toEqual([
      'github-copilot/claude-opus-4.8',
      'github-copilot/gpt-5.4',
      'github-copilot/kimi-k2.7-code',
      'opencode-go/deepseek-v4-pro',
    ]);
  });
});
