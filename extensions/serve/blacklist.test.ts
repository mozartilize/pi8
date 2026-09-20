import { describe, expect, it, beforeEach } from 'vitest';
import { BlacklistState } from './blacklist.js';

describe('BlacklistState', () => {
  let blacklist: BlacklistState;

  beforeEach(() => {
    blacklist = new BlacklistState();
  });

  it('manages model exclusions with exact set membership', () => {
    expect(blacklist.getBlacklistedModels().size).toBe(0);
    blacklist.blacklistModel('anthropic/claude-opus-4-6-20260115');
    expect(blacklist.getBlacklistedModels().has('anthropic/claude-opus-4-6-20260115')).toBe(true);
    expect(blacklist.removeBlacklistedModel('anthropic/claude-opus-4-6-20260115')).toBe(true);
    expect(blacklist.getBlacklistedModels().size).toBe(0);
  });

  it('manages provider exclusions', () => {
    expect(blacklist.getBlacklistedProviders().size).toBe(0);
    blacklist.blacklistProvider('opencode-go');
    expect(blacklist.getBlacklistedProviders().has('opencode-go')).toBe(true);
    expect(blacklist.removeBlacklistedProvider('opencode-go')).toBe(true);
    expect(blacklist.getBlacklistedProviders().size).toBe(0);
  });

  it('adds, dedupes case-insensitively, and trims patterns while preserving original case and order', () => {
    const added1 = blacklist.addSessionBlacklistPatterns(['  github-copilot/*  ', 'deepseek/*']);
    expect(added1).toEqual(['github-copilot/*', 'deepseek/*']);
    expect(blacklist.getSessionBlacklistPatterns()).toEqual(['github-copilot/*', 'deepseek/*']);

    // Case-insensitive duplicate is skipped
    const added2 = blacklist.addSessionBlacklistPatterns(['GITHUB-COPILOT/*', 'openai/*']);
    expect(added2).toEqual(['openai/*']);
    expect(blacklist.getSessionBlacklistPatterns()).toEqual([
      'github-copilot/*',
      'deepseek/*',
      'openai/*',
    ]);
  });

  it('removes patterns case-insensitively', () => {
    blacklist.addSessionBlacklistPatterns(['github-copilot/*', 'deepseek/*']);
    const removed = blacklist.removeSessionBlacklistPatterns(['GITHUB-COPILOT/*']);
    expect(removed).toEqual(['github-copilot/*']);
    expect(blacklist.getSessionBlacklistPatterns()).toEqual(['deepseek/*']);
  });

  it('clears all session-scoped models, providers, and patterns', () => {
    blacklist.blacklistModel('model-1');
    blacklist.blacklistProvider('provider-1');
    blacklist.addSessionBlacklistPatterns(['pattern-1']);

    blacklist.clearSessionBlacklist();

    expect(blacklist.getBlacklistedModels().size).toBe(0);
    expect(blacklist.getBlacklistedProviders().size).toBe(0);
    expect(blacklist.getSessionBlacklistPatterns()).toEqual([]);
  });

  it('provides independent isolation between instances', () => {
    const second = new BlacklistState();
    blacklist.blacklistModel('model-a');
    blacklist.blacklistProvider('provider-a');
    blacklist.addSessionBlacklistPatterns(['pattern-a']);

    expect(second.getBlacklistedModels().size).toBe(0);
    expect(second.getBlacklistedProviders().size).toBe(0);
    expect(second.getSessionBlacklistPatterns()).toEqual([]);
  });
});
