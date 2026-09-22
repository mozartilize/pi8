/**
 * Mutable per-session routing state for provider.ts and its sub-domains.
 *
 * Encapsulated domain aggregates:
 * - `AssessmentState`: Assessment spend, EMA usage calculation, and strikes.
 * - `IntentState`: Cached routing intent, latch generation, and veto intent key.
 * - `RuntimeBindings`: Pi extension runtime context & model registry (survives session reset).
 * - `RouterSession`: Unified session aggregate owning the lifecycle and domain objects.
 */
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ClassifyResult } from '../routing/classify/classifier.js';
import type {
  AssessmentFallbackReason,
  AssessorTokenEstimate,
  Candidate,
  DecisionCause,
  Dimension,
  RoutingAssessment,
  RoutingDecision,
} from '../types.js';
import { servedKey, type ServedInfo } from '../host/ui.js';
import type { WorkPhaseState } from '../routing/policy/work-phase.js';
import { BlacklistState, defaultBlacklistState } from './blacklist.js';
import { TrajectoryState } from '../routing/struggle/trajectory.js';
import type { PendingTrajectoryEscalation, StruggleDecision } from '../routing/struggle/types.js';
import type { ToolCycleInput } from '../routing/struggle/fingerprints.js';

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

/** Embedding-classifier outcome tallies. `kept` = fired - promoted - abstainedLowConf. */
export interface EmbeddingStats {
  /** Inference returned a verdict (a vector was classified). */
  fired: number;
  /** Verdict was confident and stronger than keyword → dimension raised. */
  promoted: number;
  /** Verdict below the confidence floor → abstained, keyword stood (R3). */
  abstainedLowConf: number;
  /** No verdict: timeout, unavailable, or inference error → keyword stood (R2). */
  degraded: number;
}

type EmbeddingOutcome = keyof EmbeddingStats;

export const ASSESSOR_USAGE_EMA_ALPHA = 0.2;

/**
 * Domain object for assessment spend, EMA usage, and assessor strikes.
 */
export class AssessmentState {
  private cost = 0;
  private tokenEma: AssessorTokenEstimate | undefined;
  private readonly strikes = new Map<string, number>();

  getCost(): number {
    return this.cost;
  }

  addCost(delta: number): void {
    if (!Number.isFinite(delta) || delta <= 0) return;
    this.cost += delta;
  }

  getTokenEstimate(fallback: AssessorTokenEstimate): AssessorTokenEstimate {
    return this.tokenEma ? { ...this.tokenEma } : { ...fallback };
  }

  recordSuccessfulUsage(observed: AssessorTokenEstimate): void {
    if (
      !Number.isFinite(observed.input)
      || observed.input <= 0
      || !Number.isFinite(observed.output)
      || observed.output < 0
    ) {
      return;
    }
    const previous = this.tokenEma;
    this.tokenEma = previous
      ? {
          input:
            ASSESSOR_USAGE_EMA_ALPHA * observed.input
            + (1 - ASSESSOR_USAGE_EMA_ALPHA) * previous.input,
          output:
            ASSESSOR_USAGE_EMA_ALPHA * observed.output
            + (1 - ASSESSOR_USAGE_EMA_ALPHA) * previous.output,
        }
      : { input: observed.input, output: observed.output };
  }

  getStrikes(): ReadonlyMap<string, number> {
    return this.strikes;
  }

  strike(registryId: string): void {
    this.strikes.set(registryId, (this.strikes.get(registryId) ?? 0) + 1);
  }

  clearStrikes(registryId: string): void {
    this.strikes.delete(registryId);
  }

  reset(): void {
    this.cost = 0;
    this.tokenEma = undefined;
    this.strikes.clear();
  }
}

/**
 * Domain object for per-turn intent caching, latch evaluation/veto, and multi-work phases.
 */
export class IntentState {
  private cachedIntent: CachedRoutingIntent | undefined;
  private latchGen = 0;
  private vetoIntentKey: string | undefined;
  private phaseState: WorkPhaseState | undefined;

  getCachedIntent(): CachedRoutingIntent | undefined {
    return this.cachedIntent;
  }

  setCachedIntent(intent: CachedRoutingIntent | undefined): void {
    this.cachedIntent = intent;
  }

  getLatchGeneration(): number {
    return this.latchGen;
  }

  bumpLatchGeneration(): number {
    this.latchGen += 1;
    return this.latchGen;
  }

  getLatchVetoIntentKey(): string | undefined {
    return this.vetoIntentKey;
  }

  setLatchVetoIntentKey(key: string | undefined): void {
    this.vetoIntentKey = key;
  }

  getWorkPhaseState(): WorkPhaseState | undefined {
    return this.phaseState;
  }

  commitWorkPhaseState(next: WorkPhaseState | undefined): void {
    this.phaseState = next;
  }

  reset(): void {
    this.cachedIntent = undefined;
    this.latchGen = 0;
    this.vetoIntentKey = undefined;
    this.phaseState = undefined;
  }
}

/**
 * Runtime extension context & model registry bindings that survive session resets.
 */
export class RuntimeBindings {
  private lastContext: ExtensionContext | undefined;
  private currentRegistry: ExtensionContext['modelRegistry'] | undefined;
  private lastRegModels = '';

  getLastExtensionContext(): ExtensionContext | undefined {
    return this.lastContext;
  }

  setLastExtensionContext(ctx: ExtensionContext | undefined): void {
    this.lastContext = ctx;
  }

  getCurrentModelRegistry(): ExtensionContext['modelRegistry'] | undefined {
    return this.currentRegistry;
  }

  setCurrentModelRegistry(registry: ExtensionContext['modelRegistry'] | undefined): void {
    this.currentRegistry = registry;
  }

  getLastRegisteredModels(): string {
    return this.lastRegModels;
  }

  setLastRegisteredModels(key: string): void {
    this.lastRegModels = key;
  }

  clear(): void {
    this.lastContext = undefined;
    this.currentRegistry = undefined;
    this.lastRegModels = '';
  }
}

/**
 * Root session state container for the auto-model-router.
 */
export class RouterSession {
  public readonly blacklist: BlacklistState;
  public readonly assessment: AssessmentState;
  public readonly intent: IntentState;
  private readonly trajectory = new TrajectoryState();

  private sessionGen = 0;
  private decision: RoutingDecision | undefined;
  private chosenRegistryId: string | undefined;
  private served: ServedInfo | undefined;
  /** Preserve the incumbent while the next provider invocation is in flight. */
  private previousServed: ServedInfo | undefined;
  private semiHold: { intentKey: string; model: string } | undefined;
  private notifiedModel: string | undefined;
  /**
   * Session-scoped manual model pin (`provider/id`) set via `/router-manual`.
   * When present the turn skips assessment, restricts scoring to this model,
   * and serves it with no fallback tail (pinned-only). Cleared on every
   * `session_start` reset, so a new session always starts on the auto router.
   */
  private manualModel: string | undefined;
  /**
   * The auto decision in effect just before the pin was engaged. `/router-manual
   * resume` reuses this (chosen model + fallback chain) for the next user entry
   * instead of recomputing. Captured at pin time because a manual turn overwrites
   * `decision`; held while pinned, then armed by `resumeManual()` and consumed by
   * `resolveResumeDecision()`. `resumeIntentKey` scopes the one-shot to a single
   * user entry so tool-loop continuations reuse it but the next entry recomputes.
   */
  private resumeSnapshot: RoutingDecision | undefined;
  private resumeIntentKey: string | undefined;
  private accumCost = 0;
  private resolvedThinkingLevel: string | undefined;
  private activeSkills: readonly string[] = [];
  private readonly embedStats: EmbeddingStats = {
    fired: 0,
    promoted: 0,
    abstainedLowConf: 0,
    degraded: 0,
  };
  private memoizedCandidateExpansion: { key: string; candidates: Candidate[] } | undefined;

  constructor(
    blacklist: BlacklistState = new BlacklistState(),
    assessment: AssessmentState = new AssessmentState(),
    intent: IntentState = new IntentState(),
  ) {
    this.blacklist = blacklist;
    this.assessment = assessment;
    this.intent = intent;
  }

  getSessionGeneration(): number {
    return this.sessionGen;
  }

  getLastDecision(): RoutingDecision | undefined {
    return this.decision;
  }

  getLastChosenRegistryId(): string | undefined {
    return this.chosenRegistryId;
  }

  setLastDecision(d: RoutingDecision): void {
    this.decision = d;
    this.chosenRegistryId = d.chosen;
  }

  getLastServed(): ServedInfo | undefined {
    return this.served;
  }

  rotateServedForNewTurn(): void {
    if (this.served) this.previousServed = this.served;
    this.served = undefined;
  }

  getPreviousServed(): ServedInfo | undefined {
    return this.previousServed;
  }

  setSemiHold(intentKey: string, model: string): void {
    this.semiHold = { intentKey, model };
  }

  getSemiHold(intentKey: string): string | undefined {
    if (this.semiHold?.intentKey !== intentKey) this.semiHold = undefined;
    return this.semiHold?.model;
  }

  setLastServed(s: ServedInfo | undefined): void {
    this.served = s;
  }

  updateLastServed(patch: Partial<ServedInfo>): void {
    if (!this.served) return;
    this.served = { ...this.served, ...patch };
  }

  getLastNotifiedModel(): string | undefined {
    return this.notifiedModel;
  }

  setLastNotifiedModel(id: string | undefined): void {
    this.notifiedModel = id;
  }

  getManualModel(): string | undefined {
    return this.manualModel;
  }

  setManualModel(registryId: string): void {
    // Snapshot the pre-pin auto decision so `resume` can reuse it. Keep the
    // existing snapshot when switching pins (A -> B): the intervening manual
    // turns overwrote `decision`, so only the first pin captures the auto route.
    if (this.manualModel === undefined) this.resumeSnapshot = this.decision;
    this.manualModel = registryId;
  }

  /**
   * Leave manual mode and arm a one-shot reuse of the pre-pin auto decision.
   * Returns whether a pin (or an armed snapshot) was active. Clears the pin and,
   * like leaving manual mode generally, discards pin-owned trajectory evidence so
   * auto routing cannot act on it. `resumeSnapshot` is retained (now armed) and
   * `resumeIntentKey` is reset so the next user entry captures the one-shot.
   */
  resumeManual(): boolean {
    const active = this.manualModel !== undefined || this.resumeSnapshot !== undefined;
    if (this.manualModel !== undefined) this.trajectory.consumePending();
    this.manualModel = undefined;
    this.resumeIntentKey = undefined;
    return active;
  }

  /**
   * The decision `resume` should serve this invocation, or undefined to recompute.
   * Armed only while no pin is active. The first invocation binds the one-shot to
   * the current user entry; same-entry tool-loop continuations reuse it; the first
   * invocation of a new entry expires it and returns undefined.
   */
  resolveResumeDecision(intentKey: string): RoutingDecision | undefined {
    if (this.manualModel !== undefined || this.resumeSnapshot === undefined) return undefined;
    if (this.resumeIntentKey === undefined) this.resumeIntentKey = intentKey;
    if (this.resumeIntentKey === intentKey) return this.resumeSnapshot;
    this.clearPendingResume();
    return undefined;
  }

  clearPendingResume(): void {
    this.resumeSnapshot = undefined;
    this.resumeIntentKey = undefined;
  }

  getAccumulatedCost(): number {
    return this.accumCost;
  }

  addAccumulatedCost(delta: number): void {
    this.accumCost += delta;
  }

  getLastResolvedThinkingLevel(): string | undefined {
    return this.resolvedThinkingLevel;
  }

  setLastResolvedThinkingLevel(level: string | undefined): void {
    this.resolvedThinkingLevel = level;
  }

  getActiveSkillNames(): readonly string[] {
    return this.activeSkills;
  }

  setActiveSkillNames(names: readonly string[]): void {
    this.activeSkills = [...names];
  }

  getEmbeddingStats(): EmbeddingStats {
    return { ...this.embedStats };
  }

  recordEmbedding(outcome: EmbeddingOutcome): void {
    this.embedStats[outcome] += 1;
  }

  getCandidateExpansion(): { key: string; candidates: Candidate[] } | undefined {
    return this.memoizedCandidateExpansion;
  }

  setCandidateExpansion(entry: { key: string; candidates: Candidate[] } | undefined): void {
    this.memoizedCandidateExpansion = entry;
  }

  // ─── Direct Blacklist Facade ─────────────────────────────────────────

  blacklistModel(registryId: string): void {
    this.blacklist.blacklistModel(registryId);
  }

  removeBlacklistedModel(registryId: string): boolean {
    return this.blacklist.removeBlacklistedModel(registryId);
  }

  clearBlacklistedModels(): void {
    this.blacklist.clearBlacklistedModels();
  }

  getBlacklistedModels(): ReadonlySet<string> {
    return this.blacklist.getBlacklistedModels();
  }

  blacklistProvider(provider: string): void {
    this.blacklist.blacklistProvider(provider);
  }

  removeBlacklistedProvider(provider: string): boolean {
    return this.blacklist.removeBlacklistedProvider(provider);
  }

  clearBlacklistedProviders(): void {
    this.blacklist.clearBlacklistedProviders();
  }

  getBlacklistedProviders(): ReadonlySet<string> {
    return this.blacklist.getBlacklistedProviders();
  }

  addSessionBlacklistPatterns(patterns: readonly string[]): string[] {
    return this.blacklist.addSessionBlacklistPatterns(patterns);
  }

  removeSessionBlacklistPatterns(patterns: readonly string[]): string[] {
    return this.blacklist.removeSessionBlacklistPatterns(patterns);
  }

  getSessionBlacklistPatterns(): readonly string[] {
    return this.blacklist.getSessionBlacklistPatterns();
  }

  clearSessionBlacklist(): void {
    this.blacklist.clearSessionBlacklist();
  }

  // ─── Direct Assessment Facade ────────────────────────────────────────

  getAssessmentCost(): number {
    return this.assessment.getCost();
  }

  addAssessmentCost(delta: number): void {
    this.assessment.addCost(delta);
  }

  getAssessorTokenEstimate(fallback: AssessorTokenEstimate): AssessorTokenEstimate {
    return this.assessment.getTokenEstimate(fallback);
  }

  recordSuccessfulAssessorUsage(observed: AssessorTokenEstimate): void {
    this.assessment.recordSuccessfulUsage(observed);
  }

  getAssessorStrikes(): ReadonlyMap<string, number> {
    return this.assessment.getStrikes();
  }

  strikeAssessor(registryId: string): void {
    this.assessment.strike(registryId);
  }

  clearAssessorStrikes(registryId: string): void {
    this.assessment.clearStrikes(registryId);
  }

  // ─── Direct Intent & Work-Phase Facade ────────────────────────────────

  getCachedIntent(): CachedRoutingIntent | undefined {
    return this.intent.getCachedIntent();
  }

  setCachedIntent(intent: CachedRoutingIntent | undefined): void {
    this.intent.setCachedIntent(intent);
  }

  getLatchGeneration(): number {
    return this.intent.getLatchGeneration();
  }

  bumpLatchGeneration(): number {
    return this.intent.bumpLatchGeneration();
  }

  getLatchVetoIntentKey(): string | undefined {
    return this.intent.getLatchVetoIntentKey();
  }

  setLatchVetoIntentKey(key: string | undefined): void {
    this.intent.setLatchVetoIntentKey(key);
  }

  getWorkPhaseState(): WorkPhaseState | undefined {
    return this.intent.getWorkPhaseState();
  }

  commitWorkPhaseState(next: WorkPhaseState | undefined): void {
    this.intent.commitWorkPhaseState(next);
  }

  bindTrajectoryIntent(intentKey: string): void {
    this.trajectory.bindIntent(intentKey);
  }

  observeTrajectory(event: ToolCycleInput, invocation: number): StruggleDecision | undefined {
    this.syncTrajectoryOwner();
    return this.trajectory.observeToolResult(event, invocation);
  }

  /**
   * Bind struggle evidence to whichever capability is serving before that
   * evidence is recorded. Every owner change goes through here — a trajectory
   * handoff or an objective-failure fallback — so a pending claim always names
   * the model whose own cycles produced it.
   */
  private syncTrajectoryOwner(): void {
    // Served identity only. The decision fallback names a pick that has not
    // run yet and is spelled differently, so owning evidence by it would make
    // one model's own serve look like a handoff and drop its own evidence.
    this.trajectory.bindOwner(this.servedCapabilityKey());
  }

  /** Identity of the capability that last actually served, effort included. */
  private servedCapabilityKey(): string | undefined {
    const served = this.getLastServed();
    if (!served?.registryId) return undefined;
    return servedKey(served);
  }

  servedTrajectoryKey(): string | undefined {
    return this.servedCapabilityKey() ?? this.getLastDecision()?.chosen;
  }

  noteTrajectoryToolCall(toolName: string, toolCallId: string, input?: unknown): StruggleDecision | undefined {
    this.syncTrajectoryOwner();
    return this.trajectory.noteToolCall(toolName, toolCallId, input);
  }

  abandonUnresolvedTrajectoryCalls(): StruggleDecision | undefined {
    this.syncTrajectoryOwner();
    return this.trajectory.abandonUnresolvedCalls();
  }

  /**
   * Complete a tool batch whose remaining calls never produced results
   * (blocked preflights from this extension or another) and arm pending
   * escalation from that evidence before the next routing peek.
   */
  flushAndArmUnresolvedTrajectory(): void {
    const decision = this.abandonUnresolvedTrajectoryCalls();
    if (!decision) return;
    this.armTrajectoryEscalation(
      decision,
      this.servedTrajectoryKey(),
      this.getLastDecision()?.dimension,
      false,
    );
  }

  armTrajectoryEscalation(
    decision: StruggleDecision,
    fromModel: string | undefined,
    dimension: Dimension | undefined,
    preOutput: boolean,
  ): void {
    this.trajectory.maybeArmPending(decision, fromModel, dimension, preOutput);
  }

  peekPendingTrajectoryEscalation(): PendingTrajectoryEscalation | undefined {
    return this.trajectory.peekPending();
  }

  consumePendingTrajectoryEscalation(): PendingTrajectoryEscalation | undefined {
    return this.trajectory.consumePending();
  }

  /**
   * Reset session-scoped state on `session_start` or test teardown.
   * Increments session generation and clears all session-bound data.
   */
  reset(): void {
    this.sessionGen += 1;
    this.decision = undefined;
    this.chosenRegistryId = undefined;
    this.previousServed = undefined;
    this.semiHold = undefined;
    this.served = undefined;
    this.notifiedModel = undefined;
    this.manualModel = undefined;
    this.resumeSnapshot = undefined;
    this.resumeIntentKey = undefined;
    this.accumCost = 0;
    this.resolvedThinkingLevel = undefined;
    this.activeSkills = [];
    this.embedStats.fired = 0;
    this.embedStats.promoted = 0;
    this.embedStats.abstainedLowConf = 0;
    this.embedStats.degraded = 0;
    this.memoizedCandidateExpansion = undefined;

    this.assessment.reset();
    this.intent.reset();
    this.trajectory.reset();
    // Note: blacklist exclusions are cleared independently via blacklist.clearSessionBlacklist()
  }
}

// ─── Default Singleton & Backwards-Compatibility Adapters ──────────────

export const defaultRuntimeBindings = new RuntimeBindings();
export const defaultRouterSession = new RouterSession(defaultBlacklistState);

export const getSessionGeneration = (): number => defaultRouterSession.getSessionGeneration();
export const getLastDecision = (): RoutingDecision | undefined =>
  defaultRouterSession.getLastDecision();
export const getLastChosenRegistryId = (): string | undefined =>
  defaultRouterSession.getLastChosenRegistryId();
export const getLastServed = (): ServedInfo | undefined => defaultRouterSession.getLastServed();
export const getLastNotifiedModel = (): string | undefined =>
  defaultRouterSession.getLastNotifiedModel();
export const getAccumulatedCost = (): number => defaultRouterSession.getAccumulatedCost();
export const getLastResolvedThinkingLevel = (): string | undefined =>
  defaultRouterSession.getLastResolvedThinkingLevel();
export const getCachedRoutingIntent = (): CachedRoutingIntent | undefined =>
  defaultRouterSession.intent.getCachedIntent();
export const getLastExtensionContext = (): ExtensionContext | undefined =>
  defaultRuntimeBindings.getLastExtensionContext();
export const getCurrentModelRegistry = (): ExtensionContext['modelRegistry'] | undefined =>
  defaultRuntimeBindings.getCurrentModelRegistry();
export const getLastRegisteredModels = (): string =>
  defaultRuntimeBindings.getLastRegisteredModels();

export const setLastDecision = (d: RoutingDecision): void => {
  defaultRouterSession.setLastDecision(d);
};

export const setLastServed = (s: ServedInfo | undefined): void => {
  defaultRouterSession.setLastServed(s);
};

export const setLastNotifiedModel = (id: string | undefined): void => {
  defaultRouterSession.setLastNotifiedModel(id);
};

export const updateLastServed = (patch: Partial<ServedInfo>): void => {
  defaultRouterSession.updateLastServed(patch);
};

export const setLastResolvedThinkingLevel = (level: string | undefined): void => {
  defaultRouterSession.setLastResolvedThinkingLevel(level);
};

export const setCachedRoutingIntent = (intent: CachedRoutingIntent | undefined): void => {
  defaultRouterSession.intent.setCachedIntent(intent);
};

export const addAccumulatedCost = (delta: number): void => {
  defaultRouterSession.addAccumulatedCost(delta);
};

export const getLatchGeneration = (): number => defaultRouterSession.intent.getLatchGeneration();

export const bumpLatchGeneration = (): number => defaultRouterSession.intent.bumpLatchGeneration();

export const getEmbeddingStats = (): EmbeddingStats => defaultRouterSession.getEmbeddingStats();

export const recordEmbedding = (outcome: EmbeddingOutcome): void => {
  defaultRouterSession.recordEmbedding(outcome);
};

export const getAssessmentCost = (): number => defaultRouterSession.assessment.getCost();

export const addAssessmentCost = (delta: number): void => {
  defaultRouterSession.assessment.addCost(delta);
};

export const getAssessorTokenEstimate = (
  fallback: AssessorTokenEstimate,
): AssessorTokenEstimate => defaultRouterSession.assessment.getTokenEstimate(fallback);

export const recordSuccessfulAssessorUsage = (observed: AssessorTokenEstimate): void => {
  defaultRouterSession.assessment.recordSuccessfulUsage(observed);
};

export const getAssessorStrikes = (): ReadonlyMap<string, number> =>
  defaultRouterSession.assessment.getStrikes();

export const strikeAssessor = (registryId: string): void => {
  defaultRouterSession.assessment.strike(registryId);
};

export const clearAssessorStrikes = (registryId: string): void => {
  defaultRouterSession.assessment.clearStrikes(registryId);
};

export const getActiveSkillNames = (): readonly string[] =>
  defaultRouterSession.getActiveSkillNames();

export const setActiveSkillNames = (names: readonly string[]): void => {
  defaultRouterSession.setActiveSkillNames(names);
};

export const getLatchVetoIntentKey = (): string | undefined =>
  defaultRouterSession.intent.getLatchVetoIntentKey();

export const setLatchVetoIntentKey = (key: string | undefined): void => {
  defaultRouterSession.intent.setLatchVetoIntentKey(key);
};

export const setLastExtensionContext = (ctx: ExtensionContext | undefined): void => {
  defaultRuntimeBindings.setLastExtensionContext(ctx);
};

export const setCurrentModelRegistry = (
  registry: ExtensionContext['modelRegistry'] | undefined,
): void => {
  defaultRuntimeBindings.setCurrentModelRegistry(registry);
};

export const setLastRegisteredModels = (key: string): void => {
  defaultRuntimeBindings.setLastRegisteredModels(key);
};

export const getCandidateExpansion = ():
  | { key: string; candidates: Candidate[] }
  | undefined => defaultRouterSession.getCandidateExpansion();

export const setCandidateExpansion = (
  entry: { key: string; candidates: Candidate[] } | undefined,
): void => {
  defaultRouterSession.setCandidateExpansion(entry);
};

export const getWorkPhaseState = (): WorkPhaseState | undefined =>
  defaultRouterSession.intent.getWorkPhaseState();

export const commitWorkPhaseState = (next: WorkPhaseState | undefined): void => {
  defaultRouterSession.intent.commitWorkPhaseState(next);
};

export const resetRouterSession = (): void => {
  defaultRouterSession.reset();
  // lastExtensionContext and currentModelRegistry on defaultRuntimeBindings are intentionally preserved
};
