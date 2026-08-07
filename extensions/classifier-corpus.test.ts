import { describe, it, expect } from 'vitest';
import { classify } from './classifier.js';
import type { Dimension } from './types.js';

/**
 * Labeled corpus of realistic coding-agent prompts.
 *
 * This exists because keyword tuning is whack-a-mole without a fixed target:
 * the original lists had no entry for "plan", "migration" or "review", so
 * "plan a migration from REST to GraphQL across our three services" scored 0
 * on every signal and fell through to `lightweight`.
 */
const CORPUS: Array<{ prompt: string; expected: Dimension | Dimension[] }> = [
  // ─── lightweight ───────────────────────────────────────────
  { prompt: 'hi there', expected: 'lightweight' },
  { prompt: 'thanks, that worked', expected: 'lightweight' },
  { prompt: 'who are you?', expected: 'lightweight' },
  { prompt: 'have to switch it manually, not a prob rn, so, who are you?', expected: 'lightweight' },
  { prompt: 'rename getFoo to getBar in utils.ts', expected: 'lightweight' },
  { prompt: 'what is a mutex?', expected: 'lightweight' },
  // "fix" is an implement-class intent verb, so this may route to either
  // lightweight (simple keywords) or implement (intent-driven).
  { prompt: 'fix typo in the README heading', expected: ['lightweight', 'implement'] },

  // ─── gather ────────────────────────────────────────────────
  { prompt: 'find where the retry logic lives in this repo', expected: 'gather' },
  { prompt: 'search the codebase for every caller of parseConfig', expected: 'gather' },
  { prompt: 'summarize what src/server.ts does', expected: ['gather', 'implement'] },
  { prompt: 'list all the environment variables this service reads', expected: 'gather' },
  { prompt: 'where is the rate limiter configured?', expected: 'gather' },

  // ─── implement ─────────────────────────────────────────────
  { prompt: 'refactor the auth middleware to use async handlers and update the tests', expected: 'implement' },
  { prompt: 'add a retry with exponential backoff to the HTTP client', expected: 'implement' },
  { prompt: 'write a unit test for the token refresh path', expected: 'implement' },
  { prompt: 'fix the null pointer exception in the payment handler', expected: 'implement' },
  { prompt: 'implement a new REST endpoint for user registration with database schema', expected: 'implement' },
  { prompt: 'migrate this component from class syntax to hooks', expected: 'implement' },

  // ─── review ────────────────────────────────────────────────
  { prompt: 'review this pull request for security issues and correctness', expected: 'review' },
  { prompt: 'audit the authentication flow for vulnerabilities', expected: 'review' },
  { prompt: 'critique my implementation of the caching layer and point out edge cases', expected: 'review' },
  { prompt: 'do a code review of the diff I just pasted, focus on error handling', expected: 'review' },

  // ─── plan ──────────────────────────────────────────────────
  { prompt: 'plan a migration from REST to GraphQL across our three services', expected: 'plan' },
  { prompt: 'design a distributed caching architecture for our microservice platform', expected: 'plan' },
  {
    prompt:
      "Let's think through whether we should use a monorepo or polyrepo. Compare and contrast the approaches, consider all trade-offs, and decide which is better for a team of 15 engineers.",
    expected: 'plan',
  },
  { prompt: 'what is our strategy for sharding the events table? weigh the options', expected: 'plan' },
  { prompt: 'draft an RFC for replacing our job queue', expected: 'plan' },
];

describe('classifier corpus', () => {
  const failures: string[] = [];

  for (const { prompt, expected } of CORPUS) {
    const want = Array.isArray(expected) ? expected : [expected];
    it(`classifies "${prompt.slice(0, 50)}" as ${want.join('|')}`, () => {
      const got = classify(prompt).dimension;
      if (!want.includes(got)) failures.push(`${prompt.slice(0, 40)} -> ${got} (want ${want.join('|')})`);
      expect(want).toContain(got);
    });
  }

  it('produces a usable confidence for every corpus entry', () => {
    for (const { prompt } of CORPUS) {
      const r = classify(prompt);
      expect(r.confidence).toBeGreaterThan(0);
      expect(Number.isFinite(r.confidence)).toBe(true);
    }
  });

  it('reaches every dimension at least once', () => {
    const seen = new Set(CORPUS.map((c) => classify(c.prompt).dimension));
    // `review` was previously unreachable: no code path ever returned it.
    expect(seen).toContain('review');
    expect(seen).toContain('plan');
    expect(seen).toContain('implement');
    expect(seen).toContain('gather');
    expect(seen).toContain('lightweight');
  });
});
