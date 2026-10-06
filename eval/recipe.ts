/**
 * Canonical hashing of execution recipes. The hash covers the facts that
 * change the concrete execution. A recipe has no session id, run id, arm id,
 * oracle version, or price table, so these values cannot change its hash.
 */
import { createHash } from 'node:crypto';
import type { EvaluationArm, ExecutionRecipeV1, ExecutionSlotKey } from './schema.ts';

/** Convert a value to JSON text with sorted object keys and no undefined members. Equal values give equal text. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  const body = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`);
  return `{${body.join(',')}}`;
}

export function digestOf(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function hashRecipe(recipe: ExecutionRecipeV1): string {
  return digestOf(recipe);
}

export function slotKey(recipe: ExecutionRecipeV1, replicate: number): ExecutionSlotKey {
  return { recipeHash: hashRecipe(recipe), replicate };
}

/** Digest of the policy that an arm requests. It does not include the arm id, so two arms with the same policy have the same digest. */
export function policyDigest(arm: EvaluationArm): string {
  return digestOf({ policy: arm.policy, continuation: arm.continuation });
}

/** Convert an arm and the frozen runtime inputs to a whole-task recipe. */
export function wholeTaskRecipe(
  arm: EvaluationArm,
  frozen: Pick<ExecutionRecipeV1, 'task' | 'runtime'>,
): ExecutionRecipeV1 {
  return {
    schema: 1,
    task: frozen.task,
    runtime: frozen.runtime,
    execution: { kind: 'whole-task', policyDigest: policyDigest(arm) },
  };
}
