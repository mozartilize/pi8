import { describe, expect, it } from 'vitest';
import { assessTerminal } from './terminal-classifier.js';

describe('terminal classifier', () => {
  it.each([
    'investigate the auth failure, then fix it',
    'find every caller before updating the signature',
    'research the API and then add pagination support',
  ])('preserves the terminal implementation deliverable: %s', (prompt) => {
    const result = assessTerminal(prompt);
    expect(result).toMatchObject({ kind: 'implement', compound: true });
  });

  it.each([
    'fix the auth failure',
    'implement pagination',
    'review and improve this',
    'quote this text: "investigate it, then fix it"',
    "investigate the issue, but don't edit or fix anything",
  ])('does not grant compound cheap-first eligibility: %s', (prompt) => {
    expect(assessTerminal(prompt).discountEligible).toBe(false);
  });

  it.each([
    'review the auth flow, then fix it',
    'design the solution, then implement it',
  ])('takes the last stated deliverable as terminal: %s', (prompt) => {
    expect(assessTerminal(prompt).kind).toBe('implement');
  });

  it.each([
    ['review the auth flow', 'review'],
    ['plan the migration', 'plan'],
    ["review the auth flow, but don't fix anything", 'review'],
  ])('keeps a non-mutating deliverable: %s', (prompt, kind) => {
    expect(assessTerminal(prompt).kind).toBe(kind);
  });

  it('lets compound structure be positive moderate-complexity evidence', () => {
    expect(assessTerminal('investigate the auth flow, then fix it')).toMatchObject({
      complexity: 'moderate',
      compound: true,
      discountEligible: true,
    });
  });

  it('raises the floor but withholds eligibility when scope is defaulted', () => {
    expect(assessTerminal('fix the auth failure')).toMatchObject({
      kind: 'implement',
      scope: 'open-ended',
      discountEligible: false,
    });
  });

  it('reads hard complexity cues over compound structure', () => {
    expect(assessTerminal('investigate the race condition, then fix it')).toMatchObject({
      complexity: 'hard',
      compound: true,
      discountEligible: true,
    });
  });

  it('reads bounded scope cues', () => {
    expect(assessTerminal('investigate this function, then fix it')).toMatchObject({
      scope: 'bounded',
      compound: true,
    });
  });

  it.each([
    'modifies the retry logic in the scheduler',
    'this patch modifies the parser',
    'modified the schema last week, align the caller',
  ])('matches y->ies/ied inflections of a mutation cue: %s', (prompt) => {
    expect(assessTerminal(prompt).kind).toBe('implement');
  });

  it('reads a backticked file path as a bounded-scope signal', () => {
    expect(assessTerminal('fix the bug in `src/auth.ts`').scope).toBe('bounded');
    expect(assessTerminal('fix the bug in "src/auth.ts"').scope).toBe('bounded');
    expect(assessTerminal('fix the bug in src/auth.ts').scope).toBe('bounded');
  });

  it('classifies non-mutating work by its own cues', () => {
    expect(assessTerminal('review and improve this')).toMatchObject({ kind: 'review', compound: false });
    expect(assessTerminal('plan the migration strategy')).toMatchObject({ kind: 'plan' });
    expect(assessTerminal('where is the retry logic?')).toMatchObject({ kind: 'gather' });
    expect(assessTerminal('')).toMatchObject({ kind: 'lightweight', confidence: 'low' });
  });
});
