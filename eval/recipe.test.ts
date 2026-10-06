import { describe, expect, it } from 'vitest';
import { canonicalJson, hashRecipe, slotKey, wholeTaskRecipe } from './recipe.ts';
import type { EvaluationArm } from './schema.ts';

const frozen = {
  task: { id: 'queue', baseRevision: 'r1', publicFixtureDigest: 'f', environmentDigest: 'e' },
  runtime: {
    piRevision: 'p', pi8Commit: 'c', configDigest: 'cfg', benchmarkStoreDigest: 'b', candidateRegistryDigest: 'r',
    providerEndpointDigest: 'ep', systemPromptDigest: 's', toolsetDigest: 't', generationParametersDigest: 'g',
  },
};
const arm = (id: string): EvaluationArm => ({ id, policy: { kind: 'fixed-candidate', candidateKey: 'a/b:high' }, continuation: 'normal-policy' });

describe('execution recipe identity', () => {
  it('ignores the arm id and the key order', () => {
    const a = wholeTaskRecipe(arm('arm-a'), frozen);
    const b = wholeTaskRecipe(arm('arm-b'), { task: frozen.task, runtime: { ...frozen.runtime } });
    expect(hashRecipe(a)).toBe(hashRecipe(b));
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: undefined }] })).toBe('{"a":[2,{"d":1}],"b":1}');
  });

  it('changes with the policy and keeps the replicate out of the hash', () => {
    const a = wholeTaskRecipe(arm('x'), frozen);
    const other = wholeTaskRecipe({ ...arm('x'), policy: { kind: 'current-auto' } }, frozen);
    expect(hashRecipe(a)).not.toBe(hashRecipe(other));
    expect(slotKey(a, 1).recipeHash).toBe(slotKey(a, 2).recipeHash);
    expect(slotKey(a, 1).replicate).not.toBe(slotKey(a, 2).replicate);
  });
});
