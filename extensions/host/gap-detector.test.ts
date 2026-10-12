import { describe, expect, it } from 'vitest';

import { detectToolGaps } from './gap-detector.js';
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
