import { describe, expect, it } from 'vitest';

import { detectToolGaps, extractMissingTools } from './gap-detector.js';
import type { DecisionLogEntry } from './decisionlog.js';

function gapEntry(overrides: Partial<DecisionLogEntry> = {}): DecisionLogEntry {
  return {
    ts: Date.now(),
    dimension: 'lightweight',
    chosen: 'x/y',
    served: 'x/y',
    viaFallback: false,
    confidence: 1,
    routedUp: false,
    cause: 'self-healing-gap',
    reason: 'gap',
    chain: ['x/y'],
    gap: { role: 'worker', tool: 'ctx_search' },
    ...overrides,
  };
}

describe('detectToolGaps', () => {
  it('aggregates recurring gap observations by role+tool', () => {
    const entries = [
      gapEntry(),
      gapEntry({ gap: { role: 'worker', tool: 'ctx_search', workaroundTool: 'ctx_search' } }),
      gapEntry({ gap: { role: 'reviewer', tool: 'web_search' } }),
    ];

    const out = detectToolGaps(entries);
    expect(out[0].role).toBe('worker');
    expect(out[0].tool).toBe('ctx_search');
    expect(out[0].observations).toBe(2);
    expect(out[0].withWorkaround).toBe(1);
    expect(out[0].strength).toBeGreaterThan(0);
  });

  it('ignores non-gap decision log entries', () => {
    const entries = [
      gapEntry({ cause: 'heuristic', gap: undefined }),
      gapEntry({ cause: 'no-data', gap: undefined }),
    ];
    expect(detectToolGaps(entries)).toEqual([]);
  });
});

describe('extractMissingTools', () => {
  it('extracts a quoted tool name from a "not available" error', () => {
    expect(extractMissingTools('The tool "ctx_search" is not available to this agent.')).toEqual([
      'ctx_search',
    ]);
  });

  it('handles the "tool X not found" and "unknown tool: X" phrasings', () => {
    expect(extractMissingTools('Error: tool web_search not found')).toEqual(['web_search']);
    expect(extractMissingTools('unknown tool: read_file')).toEqual(['read_file']);
  });

  it('handles "does not have access to tool X"', () => {
    expect(extractMissingTools('subagent does not have access to tool ctx_execute')).toEqual([
      'ctx_execute',
    ]);
  });

  it('dedupes repeated mentions and returns nothing for unrelated text', () => {
    expect(
      extractMissingTools('tool grep not available; the grep tool is not available either'),
    ).toEqual(['grep']);
    expect(extractMissingTools('the run completed successfully')).toEqual([]);
    expect(extractMissingTools('')).toEqual([]);
  });

  it('never captures the bare word "tool"', () => {
    expect(extractMissingTools('the tool is not available')).not.toContain('tool');
  });
});
