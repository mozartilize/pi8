import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import { ROUTER_PROVIDER_ID } from '../types.js';
import { isThinkingSupportedByRegistryModel, parseCandidateKey, type RegistryModelInfo } from '../routing/score/scorer.js';

/** Exact registry IDs win over suffix parsing, including IDs containing colons. */
export function resolveManualModel(
  input: string,
  models: readonly RegistryModelInfo[],
): { registryId: string; thinking?: ModelThinkingLevel } | undefined {
  const value = input.trim();
  const exact = models.find((model) => `${model.provider}/${model.id}` === value);
  const parsed = parseCandidateKey(value);
  const model = exact ?? models.find((model) => model.provider === parsed.provider && model.id === parsed.id);
  if (!model || model.provider === ROUTER_PROVIDER_ID) return undefined;
  const thinking = exact ? undefined : parsed.effort;
  if (!exact && !thinking) return undefined;
  if (thinking && thinking !== 'off' && !isThinkingSupportedByRegistryModel(model, thinking)) return undefined;
  return { registryId: `${model.provider}/${model.id}`, ...(thinking ? { thinking } : {}) };
}
