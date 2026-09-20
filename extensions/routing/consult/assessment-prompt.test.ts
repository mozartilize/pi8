import { describe, expect, it } from 'vitest';
import {
  ASSESSMENT_PROMPT_VERSION,
  buildAssessmentPrompt,
  parseAssessment,
  redactSecrets,
  type AssessmentEvidence,
} from './assessment-prompt.js';

const evidence = (overrides: Partial<AssessmentEvidence> = {}): AssessmentEvidence => ({
  conversation: 'User: list the main features of docs/plan.md',
  summary: undefined,
  toolNames: ['read', 'bash'],
  skillNames: ['writing-plans'],
  toolActivity: [{ name: 'read', count: 3 }],
  ...overrides,
});

describe('assessment prompt version', () => {
  it('exports a non-empty version stamped into every decision', () => {
    expect(ASSESSMENT_PROMPT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('buildAssessmentPrompt', () => {
  it('includes all five dimensions and the required output field names', () => {
    const prompt = buildAssessmentPrompt(evidence(), 6000);
    for (const dim of ['lightweight', 'gather', 'plan', 'implement', 'review']) {
      expect(prompt).toContain(dim);
    }
    for (const field of ['Kind:', 'Complexity:', 'Scope:', 'Compound:', 'Confidence:', 'Reasoning:']) {
      expect(prompt).toContain(field);
    }
  });

  it('replaces the assessor with the strict six-line v2 contract', () => {
    expect(ASSESSMENT_PROMPT_VERSION).toBe('2.0.0');
    const prompt = buildAssessmentPrompt({
      conversation: '[user] investigate X then fix it',
      toolNames: ['read', 'edit'],
      skillNames: [],
      toolActivity: [],
    }, 6000);
    expect(prompt).toContain('Kind: [lightweight|gather|plan|implement|review]');
    expect(prompt).toContain('Complexity: [trivial|routine|moderate|hard|frontier]');
    expect(prompt).toContain('Compound: [yes|no]');
    expect(prompt).not.toContain('InitialPhase');
  });

  it('labels a compaction summary as a summary and never as user speech', () => {
    const prompt = buildAssessmentPrompt(
      evidence({
        summary: 'earlier we refactored the scorer',
        conversation: 'User: ok',
      }),
      6000,
    );
    expect(prompt).toContain('Summary of compacted history: earlier we refactored the scorer');
    expect(prompt).not.toContain('User: earlier we refactored the scorer');
  });

  it('includes tool and skill names but never descriptions or payloads', () => {
    const prompt = buildAssessmentPrompt(evidence(), 6000);
    expect(prompt).toContain('read');
    expect(prompt).toContain('writing-plans');
    expect(prompt).not.toContain('Read file contents');
  });

  it('reports tool activity as names and counts only', () => {
    const prompt = buildAssessmentPrompt(
      evidence({ toolActivity: [{ name: 'bash', count: 12 }] }),
      6000,
    );
    expect(prompt).toContain('bash×12');
  });

  it('enforces the total character cap', () => {
    const prompt = buildAssessmentPrompt(
      evidence({ conversation: 'User: ' + 'x'.repeat(50_000) }),
      2000,
    );
    expect(prompt.length).toBeLessThanOrEqual(2000);
  });

  it('preserves the tail of the conversation when truncating', () => {
    const prompt = buildAssessmentPrompt(
      evidence({ conversation: 'User: ' + 'x'.repeat(20_000) + ' FINAL_REQUEST' }),
      2000,
    );
    expect(prompt).toContain('FINAL_REQUEST');
  });

  it('keeps the output contract intact when every section is present under a tight cap', () => {
    const prompt = buildAssessmentPrompt(
      evidence({
        summary: 's'.repeat(1200),
        conversation: 'User: ' + 'x'.repeat(50_000),
        toolNames: Array.from({ length: 40 }, (_, i) => `tool-${i}`),
        skillNames: Array.from({ length: 40 }, (_, i) => `skill-${i}`),
        toolActivity: Array.from({ length: 20 }, (_, i) => ({ name: `t${i}`, count: i + 1 })),
      }),
      2000,
    );
    expect(prompt.length).toBeLessThanOrEqual(2000);
    // The parseable reply contract must survive even a hard truncation.
    for (const field of ['Kind:', 'Complexity:', 'Scope:', 'Compound:', 'Confidence:', 'Reasoning:']) {
      expect(prompt).toContain(field);
    }
  });

  it('redacts credential-shaped values before dispatch', () => {
    const prompt = buildAssessmentPrompt(
      evidence({ conversation: 'User: my key is sk-abcdef0123456789abcdef0123456789' }),
      6000,
    );
    expect(prompt).not.toContain('sk-abcdef0123456789abcdef0123456789');
    expect(prompt).toContain('[redacted]');
  });
});

describe('redactSecrets', () => {
  it('redacts bearer tokens, sk- keys, ghp tokens and AWS access keys', () => {
    expect(redactSecrets('Authorization: Bearer abc.def.ghi')).toContain('[redacted]');
    expect(redactSecrets('sk-0123456789abcdef0123456789abcdef')).toBe('[redacted]');
    expect(redactSecrets('ghp_0123456789abcdef0123456789abcdef0123')).toBe('[redacted]');
    expect(redactSecrets('AKIAIOSFODNN7EXAMPLE')).toBe('[redacted]');
  });

  it('leaves ordinary prose untouched', () => {
    expect(redactSecrets('please review the scorer changes')).toBe(
      'please review the scorer changes',
    );
  });

  it('redacts github_pat, slack xox and JWT tokens', () => {
    expect(redactSecrets('github_pat_11ABCdefGHIjklmnopQRStuv')).toBe('[redacted]');
    expect(redactSecrets('xoxb-123456789012-abcdefghijklmn')).toBe('[redacted]');
    expect(redactSecrets('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U')).toBe(
      '[redacted]',
    );
  });

  it('redacts a KEY=VALUE assignment to the end of the line', () => {
    expect(redactSecrets('API_KEY=abc123 rest of line')).toBe('[redacted]');
    expect(redactSecrets('PASSWORD: my secret phrase')).toBe('[redacted]');
    // The scrub is line-bounded so a following line of prose survives.
    expect(redactSecrets('API_KEY=abc123\nnext line stays')).toBe('[redacted]\nnext line stays');
  });

  it('does not redact lowercase bearer prose', () => {
    expect(redactSecrets('the bearer shareholding account was closed')).toBe(
      'the bearer shareholding account was closed',
    );
  });
});

describe('parseAssessment', () => {
  const wellFormed = [
    'Kind: gather',
    'Complexity: routine',
    'Scope: bounded',
    'Compound: no',
    'Confidence: high',
    'Reasoning: the user wants a feature list from one named file',
  ].join('\n');

  it('parses a well-formed reply', () => {
    expect(parseAssessment(wellFormed)).toEqual({
      kind: 'gather',
      complexity: 'routine',
      scope: 'bounded',
      compound: false,
      confidence: 'high',
      reasoning: 'the user wants a feature list from one named file',
    });
  });

  it('accepts only complete v2 and rejects old v1 output', () => {
    const validV2 = [
      'Kind: implement',
      'Complexity: hard',
      'Scope: open-ended',
      'Compound: yes',
      'Confidence: high',
      'Reasoning: terminal mutation requested',
    ].join('\n');
    expect(parseAssessment(validV2)).toMatchObject({
      kind: 'implement', complexity: 'hard', scope: 'open-ended', compound: true,
    });
    expect(parseAssessment(validV2.replace('Complexity: hard\n', ''))).toBeUndefined();
    expect(parseAssessment(validV2.replace('Compound: yes', 'Compound: maybe'))).toBeUndefined();
    expect(parseAssessment([
      'Dimension: implement',
      'Scope: open-ended',
      'Outcome: implement',
      'Confidence: high',
      'Reasoning: old response',
    ].join('\n'))).toBeUndefined();
  });

  it('tolerates surrounding prose and case differences', () => {
    const noisy = `Sure!\n\nkind: IMPLEMENT\ncomplexity: Hard\nscope: Open-Ended\ncompound: No\nconfidence: Medium\nreasoning: it asks for a code change\n\nHope that helps.`;
    expect(parseAssessment(noisy)?.kind).toBe('implement');
    expect(parseAssessment(noisy)?.scope).toBe('open-ended');
    expect(parseAssessment(noisy)?.compound).toBe(false);
    expect(parseAssessment(noisy)?.confidence).toBe('medium');
  });

  it('rejects the whole reply when any single field is invalid', () => {
    const badScope = wellFormed.replace('Scope: bounded', 'Scope: medium');
    expect(parseAssessment(badScope)).toBeUndefined();
  });

  it('rejects a reply missing a field — partial adoption is not permitted', () => {
    const missing = wellFormed.split('\n').filter((l) => !l.startsWith('Complexity')).join('\n');
    expect(parseAssessment(missing)).toBeUndefined();
  });

  it('rejects an unknown kind', () => {
    expect(parseAssessment(wellFormed.replace('Kind: gather', 'Kind: research'))).toBeUndefined();
  });

  it('rejects empty or non-string input without throwing', () => {
    expect(parseAssessment('')).toBeUndefined();
    expect(parseAssessment(undefined as unknown as string)).toBeUndefined();
  });

  it('strips surrounding brackets from a field value', () => {
    const bracketed = wellFormed.replace('Kind: gather', 'Kind: [gather]');
    expect(parseAssessment(bracketed)?.kind).toBe('gather');
  });

  it('uses the first occurrence when a field repeats', () => {
    const duplicated = [
      'Kind: gather',
      'Kind: plan',
      ...wellFormed.split('\n').slice(1),
    ].join('\n');
    expect(parseAssessment(duplicated)?.kind).toBe('gather');
  });

  it('captures only the first line of a multi-line reasoning', () => {
    const multiLine = wellFormed.replace(
      'Reasoning: the user wants a feature list from one named file',
      'Reasoning: first line\nsecond line that is not part of the value',
    );
    expect(parseAssessment(multiLine)?.reasoning).toBe('first line');
  });

  it('rejects a value with trailing prose — strict equality, not prefix match', () => {
    const trailing = wellFormed.replace('Confidence: high', 'Confidence: high confidence here');
    expect(parseAssessment(trailing)).toBeUndefined();
  });

  it('truncates an over-long reasoning rather than rejecting it', () => {
    const long = wellFormed.replace(
      'the user wants a feature list from one named file',
      'y'.repeat(1000),
    );
    expect(parseAssessment(long)!.reasoning.length).toBeLessThanOrEqual(240);
  });
});
