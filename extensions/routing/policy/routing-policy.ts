/**
 * Live helpers that the unified selector still needs: passive causes, and
 * whether the incumbent key can be scored at the served effort.
 */
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { Candidate, DecisionCause } from '../../types.js';
import { candidateKey, parseCandidateKey, MODEL_THINKING_LEVELS } from '../score/scorer.js';

/**
 * Causes that carry no active routing intent. A trajectory-friction
 * same-dimension repick may claim these, but a consult that raised the
 * dimension owns that decision.
 */
export const POLICY_PASSIVE_CAUSES: ReadonlySet<DecisionCause> = new Set([
  'heuristic',
  'continuation-context',
  'no-data',
] satisfies DecisionCause[]);

interface IncumbentEffort {
  model: string;
  effort: ModelThinkingLevel;
}

const effortRank = (effort: ModelThinkingLevel | undefined): number =>
  effort == null ? -1 : MODEL_THINKING_LEVELS.indexOf(effort);

/** The incumbent model and the effort its key says it served at. */
function incumbentEffortOf(incumbentRegistryId: string | undefined): IncumbentEffort | undefined {
  if (incumbentRegistryId == null) return undefined;
  const incumbent = parseCandidateKey(incumbentRegistryId);
  const effort = incumbent.effort as ModelThinkingLevel | undefined;
  if (effort == null || effort === 'off' || !MODEL_THINKING_LEVELS.includes(effort)) return undefined;
  return { model: `${incumbent.provider}/${incumbent.id}`, effort };
}

/**
 * `key` when the policy can score the incumbent at it: a row has the key, or
 * the key names an effort above a labelled row of its model. Otherwise
 * undefined.
 */
export function scoredIncumbentKey(candidates: readonly Candidate[], key: string): string | undefined {
  if (candidates.some((c) => candidateKey(c) === key)) return key;
  const minimum = incumbentEffortOf(key);
  if (!minimum) return undefined;
  return candidates.some((c) => c.registryId === minimum.model && c.reasoning && c.effort != null
    && effortRank(c.effort) < effortRank(minimum.effort))
    ? key
    : undefined;
}
