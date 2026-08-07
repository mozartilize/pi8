/**
 * Mutable per-session routing state for provider.ts.
 *
 * Groups the provider's mutable routing lifecycle, including the base intent
 * cached for the latest user entry, into a single container with typed accessors.
 */
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ClassifyResult } from './classifier.js';
import type {
  AssessmentFallbackReason,
  DecisionCause,
  Dimension,
  RoutingAssessment,
  RoutingDecision,
} from './types.js';
import type { ServedInfo } from './ui.js';

export interface CachedRoutingIntent {
  key: string;
  classifyResult: ClassifyResult;
  dimension: Dimension;
  cause: DecisionCause;
  thin: boolean;
  contextChars: number;
  /** Verdict for this intent; reused for the whole tool loop, free. */
  assessment?: RoutingAssessment;
  /** Why no verdict exists, so the tool loop does not retry a dead path. */
  fallbackReason?: AssessmentFallbackReason;
}

/**
 * A `/router-escalate` request waiting to be applied to the next provider
 * invocation. One-shot: peeked while routing, consumed only once a decision
 * was actually recorded, so a router-internal failure cannot silently discard
 * the user's request.
 */
export interface PendingUserEscalation {
  /** Explicit target dimension; absent means "one tier up". */
  target?: Dimension;
  /** Model the user is escaping from, so the repick can exclude it. */
  fromModel?: string;
}

interface RouterSessionState {
  lastDecision: RoutingDecision | undefined;
  /** Last chosen candidate key (`provider/id` or `provider/id:effort`). */
  lastChosenRegistryId: string | undefined;
  lastServed: ServedInfo | undefined;
  lastNotifiedModel: string | undefined;
  accumulatedCost: number;
  lastResolvedThinkingLevel: string | undefined;
  cachedRoutingIntent: CachedRoutingIntent | undefined;
  lastExtensionContext: ExtensionContext | undefined;
  currentModelRegistry: ExtensionContext['modelRegistry'] | undefined;
  lastRegisteredModels: string;
  pendingUserEscalation: PendingUserEscalation | undefined;
  /** Incremented once when the depth latch is first evaluated per session. */
  latchGeneration: number;
  /** USD spent on assessments, kept apart from routed spend. */
  assessmentCost: number;
  /** Skill names captured at before_agent_start; names only. */
  activeSkillNames: readonly string[];
  /**
   * Per-session assessor strike counts, keyed by candidate registryId. A
   * strike is recorded when an assessor produced NO output before the
   * deadline (a structural "this model cannot deliver a verdict here"
   * signal, distinct from auth/parse/refusal). `selectAssessor` prefers
   * lower-strike candidates so the selector stops repicking a dud every
   * turn; a successful verdict clears that model's strikes so a transient
   * blip self-heals. Reorder-only — never excludes, so the pool never empties.
   */
  assessorStrikes: Map<string, number>;
}

/** Intent key whose latch transition was vetoed, so subsequent invocations of
 *  the same entry reuse the veto rather than re-evaluating. */
let latchVetoIntentKey: string | undefined;

const state: RouterSessionState = {
  lastDecision: undefined,
  lastChosenRegistryId: undefined,
  lastServed: undefined,
  lastNotifiedModel: undefined,
  accumulatedCost: 0,
  lastResolvedThinkingLevel: undefined,
  cachedRoutingIntent: undefined,
  lastExtensionContext: undefined,
  currentModelRegistry: undefined,
  lastRegisteredModels: '',
  pendingUserEscalation: undefined,
  latchGeneration: 0,
  assessmentCost: 0,
  activeSkillNames: [],
  assessorStrikes: new Map(),
};

export const getLastDecision = (): RoutingDecision | undefined => state.lastDecision;
export const getLastChosenRegistryId = (): string | undefined => state.lastChosenRegistryId;
export const getLastServed = (): ServedInfo | undefined => state.lastServed;
export const getLastNotifiedModel = (): string | undefined => state.lastNotifiedModel;
export const getAccumulatedCost = (): number => state.accumulatedCost;
export const getLastResolvedThinkingLevel = (): string | undefined => state.lastResolvedThinkingLevel;
export const getCachedRoutingIntent = (): CachedRoutingIntent | undefined => state.cachedRoutingIntent;
export const getLastExtensionContext = (): ExtensionContext | undefined => state.lastExtensionContext;
export const getCurrentModelRegistry = (): ExtensionContext['modelRegistry'] | undefined =>
  state.currentModelRegistry;
export const getLastRegisteredModels = (): string => state.lastRegisteredModels;

export const peekPendingUserEscalation = (): PendingUserEscalation | undefined =>
  state.pendingUserEscalation;

export const setPendingUserEscalation = (
  pending: PendingUserEscalation | undefined,
): void => {
  state.pendingUserEscalation = pending;
};

export const consumePendingUserEscalation = (): PendingUserEscalation | undefined => {
  const pending = state.pendingUserEscalation;
  state.pendingUserEscalation = undefined;
  return pending;
};

export const setLastDecision = (d: RoutingDecision): void => {
  state.lastDecision = d;
  state.lastChosenRegistryId = d.chosen;
};

export const setLastServed = (s: ServedInfo | undefined): void => {
  state.lastServed = s;
};

/** The model most recently surfaced to the user via a routing notification. */
export const setLastNotifiedModel = (id: string | undefined): void => {
  state.lastNotifiedModel = id;
};

export const updateLastServed = (patch: Partial<ServedInfo>): void => {
  if (!state.lastServed) return;
  state.lastServed = { ...state.lastServed, ...patch };
};

export const setLastResolvedThinkingLevel = (level: string | undefined): void => {
  state.lastResolvedThinkingLevel = level;
};

export const setCachedRoutingIntent = (intent: CachedRoutingIntent | undefined): void => {
  state.cachedRoutingIntent = intent;
};

export const addAccumulatedCost = (delta: number): void => {
  state.accumulatedCost += delta;
};

export const getLatchGeneration = (): number => state.latchGeneration;

/**
 * Bumped once when the depth latch is first evaluated in a session, whichever
 * way it resolves. It is part of the intent key so a latch decision opens a
 * fresh intent instead of reusing a verdict formed before the transition.
 */
export const bumpLatchGeneration = (): number => {
  state.latchGeneration += 1;
  return state.latchGeneration;
};

export const getAssessmentCost = (): number => state.assessmentCost;

/** Kept apart from routed spend so `/router-status` can show the routing tax. */
export const addAssessmentCost = (delta: number): void => {
  if (!Number.isFinite(delta) || delta <= 0) return;
  state.assessmentCost += delta;
};

/**
 * Skill names captured at `before_agent_start`. Pi exposes no runtime skills
 * getter — `systemPromptOptions` is the only source, and Pi's own docs mark
 * it sensitive, so only the names are retained and never the descriptions or
 * file contents.
 */
export const getAssessorStrikes = (): ReadonlyMap<string, number> => state.assessorStrikes;
export const strikeAssessor = (registryId: string): void => {
  state.assessorStrikes.set(registryId, (state.assessorStrikes.get(registryId) ?? 0) + 1);
};
export const clearAssessorStrikes = (registryId: string): void => {
  state.assessorStrikes.delete(registryId);
};

export const getActiveSkillNames = (): readonly string[] => state.activeSkillNames;

export const setActiveSkillNames = (names: readonly string[]): void => {
  state.activeSkillNames = [...names];
};

export const getLatchVetoIntentKey = (): string | undefined => latchVetoIntentKey;

export const setLatchVetoIntentKey = (key: string): void => {
  latchVetoIntentKey = key;
};

export const setLastExtensionContext = (ctx: ExtensionContext | undefined): void => {
  state.lastExtensionContext = ctx;
};

export const setCurrentModelRegistry = (
  registry: ExtensionContext['modelRegistry'] | undefined,
): void => {
  state.currentModelRegistry = registry;
};

export const setLastRegisteredModels = (key: string): void => {
  state.lastRegisteredModels = key;
};

export const resetRouterSession = (): void => {
  state.lastDecision = undefined;
  state.lastChosenRegistryId = undefined;
  state.lastServed = undefined;
  state.lastNotifiedModel = undefined;
  state.accumulatedCost = 0;
  state.lastResolvedThinkingLevel = undefined;
  state.cachedRoutingIntent = undefined;
  state.pendingUserEscalation = undefined;
  state.latchGeneration = 0;
  state.assessmentCost = 0;
  state.activeSkillNames = [];
  state.assessorStrikes.clear();
  latchVetoIntentKey = undefined;
  // lastExtensionContext and currentModelRegistry are intentionally preserved
  // — they are tied to the Pi runtime / session manager, not per-turn state.
};
