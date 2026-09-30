import { describe, expect, it } from 'vitest';
import { estimateTokenCount } from './token-estimate.js';

describe('estimateTokenCount', () => {
  it('keeps non-ASCII context estimates conservative', () => {
    expect(estimateTokenCount('спроектируй систему')).toBeGreaterThanOrEqual(17);
    expect(estimateTokenCount('hello world')).toBe(3);
    expect(estimateTokenCount('héllo')).toBe(2);
  });

  it('counts an empty string as at least one token', () => {
    expect(estimateTokenCount('')).toBe(1);
  });
});
