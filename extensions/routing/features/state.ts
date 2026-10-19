/**
 * Decision state consumed by the pure feature mapping. Every field records
 * an observation or explicitly marks it unknown. A missing declaration is not
 * a declaration of zero.
 */
import type { CacheRetention, ModelThinkingLevel } from '@earendil-works/pi-ai';

import type { Dimension } from '../../types.js';
import type { RegistryModelInfo } from '../score/scorer.js';

export interface ServedIdentity {
  /** Exact `provider/modelId`. */
  registryId: string;
  effort?: ModelThinkingLevel;
}

export type FrictionKind = 'attributed-rework' | 'severe-reasoning-loop' | 'unattributed';

/**
 * One friction event of the exact served model and effort. A decision builds
 * its friction from its own evidence only; an event never moves to a later
 * decision.
 */
export interface FrictionEvent extends ServedIdentity {
  kind: FrictionKind;
}

/** One recorded prompt prefix that a provider may still hold in its cache. */
export interface WarmPrefixEvidence {
  /** Prompt tokens of the recorded request. */
  tokens: number;
  /** When the recorded request was observed. Its age is measured from this time. */
  observedAtMs: number;
  /**
   * Authored weight of a hit while the prefix is inside its lifetime: 1 for a
   * request of this session, lower for a request of another session. It is not
   * a measured hit rate. 0 means the record gives no hit. It never extends the
   * lifetime.
   */
  hitProbability: number;
  /**
   * Retention tier of the request that wrote the prefix. The prefix lives for
   * the model's lifetime at this tier, not at the tier of a later request.
   */
  retention: CacheRetention;
}

/**
 * Cache evidence of the current request. A warm-prefix entry is eligibility
 * to try reuse, not a guaranteed hit. Each candidate model declares its own
 * cache lifetime, so the feature mapping applies the lifetime per action.
 */
export interface CacheEvidenceV1 {
  /** Identity of the prompt head the warm entries were observed for. */
  promptIdentity: string;
  /** Action key of the incumbent, for shared-cache effort reuse. */
  incumbentKey?: string;
  /** Recorded warm prefixes by action key. */
  warmPrefixes: ReadonlyMap<string, readonly WarmPrefixEvidence[]>;
  /**
   * Retention tier of the delegated request. At `none` the request reads and
   * writes no cache; the tier also sets the cache-write price.
   */
  retention: CacheRetention;
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
  rework?: { failed: ServedIdentity };
  /** Friction evidence of this decision only; never persisted or carried into a later decision. */
  friction: readonly FrictionEvent[];
  cache?: CacheEvidenceV1;
  /** Identity of the current prompt head. */
  promptIdentity?: string;
  nowMs: number;
  /** AA Intelligence Index version of the benchmark snapshot. */
  benchmarkIndexVersion?: string;
}

/*
 * Domain snapshots. Each domain reads only its own part of the decision
 * state, so a field that a domain does not name cannot change its result.
 * `DecisionStateV1` is the one host-side object that supplies all of them.
 */

/** A snapshot type: every nested property, array and map is read-only. */
export type Immutable<T> =
  T extends (...args: never[]) => unknown ? T
  : T extends ReadonlyMap<infer K, infer V> ? ReadonlyMap<K, Immutable<V>>
  : T extends readonly (infer E)[] ? readonly Immutable<E>[]
  : T extends object ? { readonly [P in keyof T]: Immutable<T[P]> }
  : T;

/** Accepted declarations: the routed phase and what the model declared about the task. */
export type TaskDeclarations = Immutable<Pick<DecisionStateV1, 'phase' | 'contextAcquisition' | 'openDecisions' | 'difficulty'>>;

/** Measured workload: input size and modality, observed by the host, not declared. */
export type WorkloadMeasurement = Immutable<Pick<DecisionStateV1, 'estimatedContextTokens' | 'needsVision'>>;

/** Task demand reads declarations and measured workload. */
export type TaskSnapshot = TaskDeclarations & WorkloadMeasurement;

/** Benchmark observations: the index version that quality and output-token evidence must match. */
export type BenchmarkSnapshot = Immutable<Pick<DecisionStateV1, 'benchmarkIndexVersion'>>;

/** Prompt-cache records of the current request and the time that ages them. */
export type CacheSnapshot = Immutable<Pick<DecisionStateV1, 'cache' | 'promptIdentity' | 'nowMs'>>;

/** Spend: the measured prompt size, the per-model token scale, and the cache records. */
export type SpendSnapshot = Pick<WorkloadMeasurement, 'estimatedContextTokens'> & CacheSnapshot
  & Immutable<Pick<DecisionStateV1, 'promptTokenScales'>>;

/** Prices and cache lifetimes of one model, as Pi's registry declares them. */
export type PriceSnapshot = Immutable<Pick<RegistryModelInfo, 'cost' | 'promptCache' | 'api' | 'compat'>>;

/** Continuity and recovery: the boundary, incumbent, attributed rework and friction. */
export type SessionSnapshot = Immutable<Pick<DecisionStateV1, 'boundary' | 'incumbent' | 'rework' | 'friction'>>;
