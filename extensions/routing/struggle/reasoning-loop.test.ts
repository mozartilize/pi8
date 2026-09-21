import { describe, expect, it } from 'vitest';
import {
  ReasoningLoopDetector,
  RL_MIN_TOKENS,
  RL_STRIDE,
  RL_WINDOW,
} from './reasoning-loop.js';

function pad(token: string, count: number): string {
  return Array.from({ length: count }, () => token).join(' ');
}

describe('ReasoningLoopDetector', () => {
  it('does not fire on long reasoning without repetition', () => {
    const loop = new ReasoningLoopDetector();
    const tokens = Array.from({ length: RL_MIN_TOKENS + 50 }, (_, i) => `step${i}`);
    loop.update(tokens.join(' '));
    expect(loop.severity()).toBe('none');
  });

  it('stays none below the token floor even with repetition', () => {
    const loop = new ReasoningLoopDetector();
    const block = pad('wait actually loop', RL_WINDOW);
    loop.update(`${block} ${block} ${block}`);
    expect(loop.snapshot().tokenCount).toBeLessThan(RL_MIN_TOKENS);
    expect(loop.severity()).toBe('none');
  });

  it('goes severe on a repeated 128-char block after the token floor', () => {
    const loop = new ReasoningLoopDetector();
    const block = 'abcdefghij'.repeat(13).slice(0, 128);
    loop.update(`${Array.from({ length: RL_MIN_TOKENS }, (_, i) => `t${i}`).join(' ')} `);
    loop.update(block);
    loop.update(block);
    loop.update(block);
    expect(loop.severity()).toBe('severe');
  });

  it('does not persist raw text on the snapshot', () => {
    const loop = new ReasoningLoopDetector();
    loop.update('secret chain of thought wait');
    const snapshot = loop.snapshot();
    expect(JSON.stringify(snapshot)).not.toContain('secret');
  });

  it('treats equivalent input split across chunks the same as one block', () => {
    const once = new ReasoningLoopDetector();
    const split = new ReasoningLoopDetector();
    const filler = Array.from({ length: RL_MIN_TOKENS }, (_, i) => `t${i}`).join(' ');
    const text = `${filler} ${'abcdefghij'.repeat(13).slice(0, 128).repeat(3)}`;
    once.update(text);
    for (const chunk of text.match(/.{1,17}/g) ?? []) split.update(chunk);
    expect(split.severity()).toBe(once.severity());
    expect(split.severity()).toBe('severe');
    expect(split.snapshot().tokenCount).toBe(once.snapshot().tokenCount);
  });

  it('does not let character-chunked text below the floor become severe', () => {
    const text = `${pad('alpha', 200)} `;
    const once = new ReasoningLoopDetector();
    const chars = new ReasoningLoopDetector();
    once.update(text);
    for (const ch of text) chars.update(ch);
    expect(once.snapshot().tokenCount).toBe(chars.snapshot().tokenCount);
    expect(once.severity()).toBe('none');
    expect(chars.severity()).toBe('none');
  });

  it('treats character-chunked text above the floor the same as one block', () => {
    const once = new ReasoningLoopDetector();
    const chars = new ReasoningLoopDetector();
    const filler = Array.from({ length: RL_MIN_TOKENS }, (_, i) => `t${i}`).join(' ');
    const text = `${filler} ${'abcdefghij'.repeat(13).slice(0, 128).repeat(3)}`;
    once.update(text);
    for (const ch of text) chars.update(ch);
    expect(chars.snapshot().tokenCount).toBe(once.snapshot().tokenCount);
    expect(chars.severity()).toBe(once.severity());
    expect(chars.severity()).toBe('severe');
  });

  it('counts a reflection marker split across deltas', () => {
    const loop = new ReasoningLoopDetector();
    loop.update('wai');
    loop.update('t actually ');
    expect(loop.snapshot().reflectionTransitions).toBeGreaterThan(0);
  });

  // Same tokens every round, so windows are near-duplicates, but a per-round
  // punctuation marker keeps every 128-char block unique — the exact-block
  // rule is a separate lifetime signal and would mask the rolling share.
  const loopRound = (round: number): string => {
    const tokens = ['wait', ...Array.from({ length: RL_WINDOW - 1 }, (_, i) => `tok${i}`)];
    return `${tokens.join(` ${'.'.repeat(round + 1)} `)} `;
  };

  it('ages repeat evidence out of the rolling share', () => {
    const loop = new ReasoningLoopDetector();
    for (let round = 0; round < 12; round += 1) loop.update(loopRound(round));
    expect(loop.snapshot().repeatedWindowCount).toBeGreaterThan(0);

    let token = 0;
    for (let i = 0; i < 40; i += 1) {
      loop.update(`${Array.from({ length: RL_STRIDE }, () => `unique${token++}`).join(' ')} `);
    }
    const after = loop.snapshot();
    expect(after.repeatedWindowCount).toBe(0);
    expect(after.severity).toBe('none');
  });

  it('keeps the repeat share within 0..1 on a long repetitive stream', () => {
    const loop = new ReasoningLoopDetector();
    for (let round = 0; round < 200; round += 1) loop.update(loopRound(round));
    const { repeatedWindowCount, windowCount } = loop.snapshot();
    expect(windowCount).toBeGreaterThan(0);
    expect(repeatedWindowCount).toBeGreaterThanOrEqual(0);
    expect(repeatedWindowCount).toBeLessThanOrEqual(windowCount);
  });

  it('bounds retained tokens and hashes exact comparison blocks', () => {
    const loop = new ReasoningLoopDetector();
    const secret = 'unique-secret-phrase-xyz';
    loop.update(secret);
    loop.update(pad('later', RL_WINDOW * 4));
    const serialized = JSON.stringify({
      snapshot: loop.snapshot(),
      internals: { ...(loop as unknown as Record<string, unknown>) },
    });
    expect(serialized).not.toContain(secret);
    expect(loop.snapshot().tokenCount).toBeGreaterThan(RL_WINDOW);
  });
});
