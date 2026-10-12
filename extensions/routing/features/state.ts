/**
 * Decision state consumed by the pure feature mapping. Every field records
 * an observation or explicitly marks it unknown. A missing declaration is not
 * a declaration of zero.
 */
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';

import type { Dimension } from '../../types.js';

export interface ServedIdentity {
  /** Exact `provider/modelId`. */
  registryId: string;
  effort?: ModelThinkingLevel;
}

export type FrictionKind = 'attributed-rework' | 'severe-reasoning-loop' | 'unattributed';

/** One friction event, scoped to the exact served model, effort and work item. */
export interface FrictionEvent extends ServedIdentity {
  workItemId: string;
  kind: FrictionKind;
}

/**
 * Cache evidence of the current request. A warm-prefix entry is eligibility
 * to try reuse, not a guaranteed hit.
 */
export interface CacheEvidenceV1 {
  observedAtMs: number;
  /** Identity of the prompt head the warm entries were observed for. */
  promptIdentity: string;
  /** Action key of the incumbent; it keeps the whole conversation prefix. */
  incumbentKey?: string;
  /** Warm prefix tokens by action key. */
  warmPrefixTokens: ReadonlyMap<string, number>;
  ttlMs: number;
  source: 'session' | 'model-history' | 'none';
}

export type DecisionBoundary =
  /** An authorized assignment boundary without attributed rework. */
  | 'ordinary'
  /** An authorized boundary after verified rework attributed to `rework.failed`. */
  | 'rework';

/** Task difficulty in [0, 1] and the rubric it came from. */
export interface TaskDifficulty {
  /** Maximum axis demand, for summaries. Scalar inputs apply to every axis. */
  value: number;
  axes?: { reasoning: number; agentic: number; research: number };
  source: 'execution-rubric' | 'reasoning-rubric';
}

export interface DecisionStateV1 {
  phase: Dimension;
  workItemId?: string;
  /** Explicitly observed open decisions; undefined when not declared. */
  openDecisions?: number;
  /** Difficulty of the accepted handoff or plan; undefined when no rubric was declared. */
  difficulty?: TaskDifficulty;
  estimatedContextTokens: number;
  needsVision: boolean;
  boundary: DecisionBoundary;
  /** Served identity at an ordinary boundary; absent when there is no incumbent. */
  incumbent?: ServedIdentity;
  /** Attributed rework that opened a rework boundary. */
  rework?: { failed: ServedIdentity; workItemId: string };
  friction: readonly FrictionEvent[];
  cache?: CacheEvidenceV1;
  /** Identity of the current prompt head. */
  promptIdentity?: string;
  nowMs: number;
  /** A spawned subagent shares no prompt cache with its parent. */
  isSubagentSpawn: boolean;
  /** AA Intelligence Index version of the benchmark snapshot. */
  benchmarkIndexVersion?: string;
}
