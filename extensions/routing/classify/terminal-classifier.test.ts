import { describe, expect, it } from 'vitest';
import { assessTerminal } from './terminal-classifier.js';

describe('terminal classifier', () => {
  it.each([
    'investigate the auth failure, then fix it',
    'find every caller before updating the signature',
    'research the API and then add pagination support',
  ])('reads the final implementation deliverable after an investigation step: %s', (prompt) => {
    expect(assessTerminal(prompt).kind).toBe('implement');
  });

  it.each([
    'quote this text: "investigate it, then fix it"',
    "investigate the issue, but don't edit or fix anything",
  ])('reads no change in quoted or negated mutation cues: %s', (prompt) => {
    expect(assessTerminal(prompt).kind).not.toBe('implement');
  });

  it('reports only the final step: kind, complexity, and scope', () => {
    expect(Object.keys(assessTerminal('investigate the auth flow, then fix it')).sort()).toEqual(['complexity', 'kind', 'scope']);
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

  it('defaults unknown complexity to moderate and unknown scope to open-ended', () => {
    expect(assessTerminal('fix the auth failure')).toMatchObject({
      kind: 'implement',
      complexity: 'moderate',
      scope: 'open-ended',
    });
  });

  it('reads hard complexity cues', () => {
    expect(assessTerminal('investigate the race condition, then fix it')).toMatchObject({ complexity: 'hard' });
  });

  it('reads bounded scope cues', () => {
    expect(assessTerminal('investigate this function, then fix it')).toMatchObject({ scope: 'bounded' });
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
    expect(assessTerminal('review and improve this')).toMatchObject({ kind: 'review' });
    expect(assessTerminal('plan the migration strategy')).toMatchObject({ kind: 'plan' });
    expect(assessTerminal('where is the retry logic?')).toMatchObject({ kind: 'gather' });
    expect(assessTerminal('')).toMatchObject({ kind: 'lightweight' });
  });
});
