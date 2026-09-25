import { describe, it, expect } from 'vitest';
import { classify } from './classifier.js';
import type { Dimension } from '../../types.js';

/**
 * Labeled corpus of realistic coding-agent prompts.
 *
 * Tune keywords against movement across the corpus, not one anecdotal prompt.
 * Assert output categories, not exact weights or intermediate scores.
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

  // ─── leading-verb intents (mutating work) ──────────────────
  // These fell through to gather/plan before the intent-verb list gained
  // debug/diagnose/convert/rewrite/document/test/configure/scaffold/etc.
  { prompt: 'debug why the login test is flaky', expected: 'implement' },
  { prompt: 'diagnose the memory leak in the worker', expected: 'implement' },
  { prompt: 'troubleshoot the failing CI pipeline', expected: 'implement' },
  { prompt: 'convert this callback code to promises', expected: 'implement' },
  { prompt: 'rewrite the parser to be streaming', expected: 'implement' },
  { prompt: 'document the public API of this module', expected: 'implement' },
  { prompt: 'test the retry logic', expected: 'implement' },
  { prompt: 'configure eslint for this repo', expected: 'implement' },
  { prompt: 'set up a github actions workflow', expected: 'implement' },
  { prompt: 'scaffold a new express service', expected: 'implement' },
  { prompt: 'generate types from this json schema', expected: 'implement' },
  { prompt: 'sketch the data model for a chat app', expected: 'plan' },

  // ─── honest duals: leading verb + design noun ──────────────
  // The opening verb (analyze/investigate/research/compare) is genuinely
  // ambiguous between exploration and design/critique. Either verdict is
  // acceptable; the assessment layer resolves the deliverable. Pinned as a
  // set so a future tuning pass cannot silently collapse the ambiguity to
  // the WRONG single answer.
  { prompt: 'analyze the tradeoffs between kafka and rabbitmq', expected: ['plan', 'gather'] },
  { prompt: 'investigate the tradeoffs of monorepo vs polyrepo', expected: ['plan', 'gather'] },
  { prompt: 'research where parseConfig is used', expected: ['gather', 'plan'] },
  { prompt: 'is my caching implementation correct?', expected: ['review', 'gather'] },
  { prompt: 'compare my two branches and tell me which is cleaner', expected: ['review', 'plan'] },
];

const TERMINAL_CASES = [
  { prompt: 'investigate the cache miss, then fix it', kind: 'implement', compound: true },
  { prompt: 'review and improve this', kind: 'review', compound: false },
  { prompt: 'research the API, then add webhook support', kind: 'implement', compound: true },
] as const;

describe('terminal corpus', () => {
  for (const { prompt, kind, compound } of TERMINAL_CASES) {
    it(`reads "${prompt.slice(0, 50)}" as terminal ${kind}`, () => {
      const terminal = classify(prompt).terminal;
      expect(terminal.kind).toBe(kind);
      expect(terminal.compound).toBe(compound);
      expect(terminal.confidence === 'high').toBe(compound);
    });
  }
});

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
