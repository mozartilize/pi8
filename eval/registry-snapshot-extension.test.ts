import { describe, expect, it } from 'vitest';
import { registrySnapshot } from './registry-snapshot-extension.ts';

describe('registry snapshot', () => {
  it('keeps fields that affect routing and omits provider runtime state', () => {
    const models = registrySnapshot([{
      provider: 'cursor',
      id: 'gemini-3.8-flash',
      api: 'cursor-sdk',
      contextWindow: 200_000,
      maxTokens: 16_384,
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      thinkingLevelMap: { high: 'high' },
      compat: { supportsMidConvoEffort: true },
      secretRuntimeState: 'do not persist',
    } as never]);

    expect(models).toEqual([{
      provider: 'cursor',
      id: 'gemini-3.8-flash',
      api: 'cursor-sdk',
      contextWindow: 200_000,
      maxTokens: 16_384,
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      thinkingLevelMap: { high: 'high' },
      compat: { supportsMidConvoEffort: true },
    }]);
  });
});
