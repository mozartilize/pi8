/**
 * Effective model-effort actions, enumerated from Pi's supported thinking
 * levels independently of benchmark coverage. A supported effort with no
 * benchmark row stays an action; its quality features use the missing
 * interval, never another effort's measurement.
 *
 * Two levels that the model's `thinkingLevelMap` sends as the same provider
 * value are one effective action. The action carries one served effort, and
 * feature lookup and dispatch both use that effort.
 */
import { clampThinkingLevel, type ModelThinkingLevel } from '@earendil-works/pi-ai';

import type { RegistryModelInfo } from '../score/scorer.js';
import { candidateKey, isThinkingSupportedByRegistryModel, servesThinkingOff } from '../score/scorer.js';

export const EFFORT_ORDER: readonly ModelThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export const effortRank = (effort: ModelThinkingLevel | undefined): number =>
  effort === undefined ? -1 : EFFORT_ORDER.indexOf(effort);

export interface EffectiveAction {
  /** Exact `provider/modelId`; the recovery model identity. */
  registryId: string;
  /** Served effort; undefined for a model without reasoning. */
  effort?: ModelThinkingLevel;
  /** Action identity: `provider/modelId` or `provider/modelId:effort`. */
  key: string;
  /** Supported levels this action serves. */
  levels: ModelThinkingLevel[];
}

/** Action identity; the same key format as routing candidates. */
export const actionKey = (registryId: string, effort: ModelThinkingLevel | undefined): string =>
  candidateKey({ registryId, effort });

/** Provider value Pi sends for a level; the level name when the map has no entry. */
function providerValue(model: RegistryModelInfo, level: ModelThinkingLevel): string {
  const mapped = (model.thinkingLevelMap as Partial<Record<ModelThinkingLevel, string | null>> | undefined)?.[level];
  return typeof mapped === 'string' ? mapped : level;
}

function supportedLevels(model: RegistryModelInfo): ModelThinkingLevel[] {
  return EFFORT_ORDER.filter((level) =>
    level === 'off' ? servesThinkingOff(model) : isThinkingSupportedByRegistryModel(model, level));
}

/**
 * The level that represents an alias group: the level whose name equals the
 * provider value when one exists, else the lowest level of the group.
 */
function representative(model: RegistryModelInfo, group: readonly ModelThinkingLevel[]): ModelThinkingLevel {
  return group.find((level) => providerValue(model, level) === level) ?? group[0]!;
}

/** All supported effective actions of one registry model. */
export function enumerateEffectiveActions(model: RegistryModelInfo): EffectiveAction[] {
  const registryId = `${model.provider}/${model.id}`;
  if (!model.reasoning) return [{ registryId, key: registryId, levels: [] }];
  const groups = new Map<string, ModelThinkingLevel[]>();
  for (const level of supportedLevels(model)) {
    const value = level === 'off' ? '\u0000off' : providerValue(model, level);
    const group = groups.get(value) ?? [];
    group.push(level);
    groups.set(value, group);
  }
  return [...groups.values()]
    .map((levels) => {
      const effort = representative(model, levels);
      return { registryId, effort, key: actionKey(registryId, effort), levels };
    })
    .sort((a, b) => effortRank(a.effort) - effortRank(b.effort));
}

/**
 * The single action of an explicit effort override: Pi's clamp of the
 * requested level, then its alias group.
 */
export function overrideAction(model: RegistryModelInfo, requested: ModelThinkingLevel): EffectiveAction | undefined {
  const actions = enumerateEffectiveActions(model);
  if (!model.reasoning) return actions[0];
  const clamped = clampThinkingLevel(model as Parameters<typeof clampThinkingLevel>[0], requested);
  return actions.find((action) => action.levels.includes(clamped));
}
