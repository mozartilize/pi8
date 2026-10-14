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

export interface DemandInterval {
  center: number;
  lower: number;
  upper: number;
}

/** Task difficulty in [0, 1] and the declaration it came from. */
export interface TaskDifficulty {
  /** Maximum axis demand, for summaries. Scalar inputs apply to every axis. */
  value: number;
  axes?: { reasoning: number; agentic: number; research: number };
  /** Absent bounds mean an exact declared demand, not unknown demand. */
  bounds?: Record<'reasoning' | 'agentic' | 'research', { lower: number; upper: number }>;
  source: 'execution-rubric' | 'reasoning-rubric' | 'declared-complexity';
}

export interface DecisionStateV1 {
  phase: Dimension;
  /** True only while the host restricts the entry to collecting context, before a handoff or a declared answer. */
  contextAcquisition?: boolean;
  workItemId?: string;
  /** Explicitly observed open decisions; undefined when not declared. */
  openDecisions?: number;
  /** Demand of the accepted declaration; undefined when neither rubric nor complexity is known. */
  difficulty?: TaskDifficulty;
  estimatedContextTokens: number;
  /**
   * Billed prompt tokens per estimated token, by `provider/id`. A provider's
   * tokenizer and request overhead differ from the estimate. An absent model
   * has the scale 1.
   */
  promptTokenScales?: ReadonlyMap<string, number>;
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
