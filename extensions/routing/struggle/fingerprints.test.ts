import { describe, expect, it } from 'vitest';
import { TrajectoryState } from './trajectory.js';
import {
  cycleFromToolResult,
  lineDistance,
  MAX_DIFF_CHARS,
  MAX_DIFF_LINES,
  type ToolCycleInput,
} from './fingerprints.js';

function lines(count: number, seed: number): string {
  return Array.from({ length: count }, (_, i) => `line ${i} ${seed}`).join('\n');
}

function scrambled(count: number, seed: number): string {
  return Array.from({ length: count }, (_, i) => `x${(i * seed) % count}_${seed}`).join('\n');
}

function search(matches: unknown[]): ToolCycleInput {
  return {
    toolName: 'grep',
    toolCallId: `grep-${Math.random()}`,
    input: { pattern: 'TODO', path: 'src' },
    content: [{ type: 'text', text: 'results' }],
    details: { matches },
  };
}

describe('lineDistance', () => {
  it('counts added and deleted lines exactly', () => {
    expect(lineDistance('a\nb\nc', 'a\nx\nc')).toEqual({ available: true, added: 1, deleted: 1 });
    expect(lineDistance('a\nb', 'a\nb\nc')).toEqual({ available: true, added: 1, deleted: 0 });
    expect(lineDistance('a\nb\nc', 'a\nc')).toEqual({ available: true, added: 0, deleted: 1 });
    expect(lineDistance('same', 'same')).toEqual({ available: true, added: 0, deleted: 0 });
  });

  it('stays cheap and exact on a large nearly-identical file', () => {
    const before = lines(12_000, 1);
    const after = before.replace('line 6000 1', 'line 6000 edited');
    const started = Date.now();
    const result = lineDistance(before, after);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result).toEqual({ available: true, added: 1, deleted: 1 });
  });

  it('reports unavailable inside the budget on adversarial input', () => {
    const started = Date.now();
    const result = lineDistance(scrambled(12_000, 7), scrambled(12_000, 13));
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.available).toBe(false);
  });

  it('refuses a comparison after the shared deadline expires', () => {
    expect(lineDistance('a', 'b', Date.now() - 1))
      .toEqual({ available: false, reason: 'budget-exhausted' });
  });

  it('refuses a huge one-line input before diffing', () => {
    const huge = 'x'.repeat(MAX_DIFF_CHARS);
    expect(lineDistance(huge, 'y')).toEqual({ available: false, reason: 'too-large' });
  });

  it('refuses outright above the line ceiling', () => {
    const huge = lines(MAX_DIFF_LINES, 1);
    const result = lineDistance(huge, `${huge}\nextra`);
    expect(result).toEqual({ available: false, reason: 'too-large' });
  });
});

describe('equivalence safety', () => {
  it.each(['lookup', 'read', 'grep'])('does not escalate distinct or unverified %s results', (toolName) => {
    const state = new TrajectoryState();
    for (let i = 0; i < 5; i++) {
      const decision = state.observeToolResult({
        toolName, toolCallId: String(i),
        input: toolName === 'lookup' ? { query: String(i) } : toolName === 'read' ? { path: 'a' } : { path: 'a', pattern: 'x' },
        content: toolName === 'lookup' ? 'no results' : `${'a'.repeat(5000)}${i}`,
        details: toolName === 'grep' ? { matches: Array.from({ length: 65 }, (_, j) => ({ path: 'a', line: j, text: j === 64 ? String(i) : 'x' })) } : undefined,
      }, i);
      expect(decision?.escalate).toBe(false);
    }
  });

  it('does not infer equivalence from oversized observations', () => {
    const state = new TrajectoryState();
    for (let i = 0; i < 5; i++) {
      const decision = state.observeToolResult({ toolName: 'read', toolCallId: String(i), input: { path: 'a' }, content: 'x'.repeat(1_000_001) }, i);
      expect(decision?.escalate).toBe(false);
    }
  });

  it('preserves read case and search tails in observation identities', () => {
    const read = (text: string) => cycleFromToolResult({ toolName: 'read', toolCallId: 'r', input: { path: 'a' }, content: text }, 1);
    expect(read('Case').observationKey).not.toBe(read('case').observationKey);
    const match = (tail: string) => cycleFromToolResult(search([{ path: 'a', text: 'x'.repeat(200) + tail }]), 1);
    expect(match('a').observationKey).not.toBe(match('b').observationKey);
  });
});

describe('search observation identity', () => {
  const observation = (matches: unknown[]): string =>
    cycleFromToolResult(search(matches), 1).observationKey;

  it('separates the same paths at different locations', () => {
    expect(observation([{ path: 'a.ts', line: 20 }]))
      .not.toBe(observation([{ path: 'a.ts', line: 140 }]));
  });

  it('separates the same locations with different matched text', () => {
    expect(observation([{ path: 'a.ts', line: 20, text: 'TODO: first' }]))
      .not.toBe(observation([{ path: 'a.ts', line: 20, text: 'TODO: second' }]));
  });

  it('separates different match counts in the same file', () => {
    expect(observation([{ path: 'a.ts', line: 20 }]))
      .not.toBe(observation([{ path: 'a.ts', line: 20 }, { path: 'a.ts', line: 90 }]));
  });

  it('treats a reordered identical result set as equivalent', () => {
    const first = [{ path: 'a.ts', line: 20 }, { path: 'b.ts', line: 5 }];
    expect(observation(first)).toBe(observation([...first].reverse()));
  });
});
