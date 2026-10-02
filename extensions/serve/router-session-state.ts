/**
 * Mutable per-session routing state for provider.ts and its sub-domains.
 *
 * Encapsulated domain aggregates:
 * - `IntentState`: Cached routing intent and per-entry work-phase state.
 * - `RoutingContextState`: The branch's work ledger, rebuilt from Pi's session tree.
 * - `RuntimeBindings`: Pi extension runtime context & model registry (survives session reset).
 * - `RouterSession`: Unified session aggregate owning the lifecycle and domain objects.
 * Paths given an injected session must read and write that same owner, not a
 * default instance; otherwise state crosses sessions. Async writes must check
 * the session generation before publishing results from an earlier session.
 */
import { loadModelHistory, type ModelHistory } from '../bench/model-history.js';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type {
  Candidate,
  DecisionCause,
  Dimension,
  RoutingDecision,
} from '../types.js';
import { checkPlaywright, type PlaywrightCheck } from '../adapters/artificial-analysis-site.js';
import { debugLog } from '../host/debuglog.js';
import { servedKey, type ServedInfo } from '../host/ui.js';
import type { WorkPhaseState } from '../routing/policy/work-phase.js';
import { BlacklistState, defaultBlacklistState } from './blacklist.js';
import { TrajectoryState } from '../routing/struggle/trajectory.js';
import type { PendingTrajectoryEscalation, StruggleDecision } from '../routing/struggle/types.js';
import type { ToolCycleInput } from '../routing/struggle/fingerprints.js';
import { applyEvent, emptyLedger, type TopicLedger } from '../routing/context/ledger.js';
import { classifyBranch, rebuildLedger } from '../routing/context/persistence.js';
import { ReadCoverage, type LineRange } from '../routing/context/grounding.js';
import type { LegacyIndex } from '../routing/context/legacy.js';
import {
  CONTEXT_COMMIT_EVENT_LIMIT,
  type BranchState,
  type FlatContextEvent,
  type Incumbent,
  type RoutingContextEvent,
} from '../routing/context/types.js';
import type { ResolvedEntryContext } from './context-resolution.js';

export interface CachedRoutingIntent {
  key: string;
  dimension: Dimension;
  cause: DecisionCause;
  /** The entry's work-context resolution; resolved once per entry. */
  context?: ResolvedEntryContext;
}

/**
 * Domain object for per-turn intent caching and per-entry work-phase state.
 */
export class IntentState {
  private cachedIntent: CachedRoutingIntent | undefined;
  private phaseState: WorkPhaseState | undefined;

  getCachedIntent(): CachedRoutingIntent | undefined {
    return this.cachedIntent;
  }

  setCachedIntent(intent: CachedRoutingIntent | undefined): void {
    this.cachedIntent = intent;
  }

  getWorkPhaseState(): WorkPhaseState | undefined {
    return this.phaseState;
  }

  commitWorkPhaseState(next: WorkPhaseState | undefined): void {
    this.phaseState = next;
  }

  reset(): void {
    this.cachedIntent = undefined;
    this.phaseState = undefined;
  }
}

/**
 * The active branch's work ledger. Pi's session tree is its source of truth:
 * an event is applied only once the bound persistence has written it to the
 * branch, so the in-memory ledger is always the fold of the branch and a
 * reload rebuilds exactly what routing saw. With no persistence bound it
 * lives in memory only. A reset forgets the ledger but keeps that binding.
 */
export class RoutingContextState {
  private ledger: TopicLedger = emptyLedger();
  private branchState: BranchState = 'native-empty';
  private persist: ((event: RoutingContextEvent) => void) | undefined;
  /** Session entry id of the genuine user entry being routed. */
  private entrySource: string | undefined;
  /** Lines of anchored files read so far, until they cover the whole file; runtime-only. */
  private readCoverage = new Map<string, ReadCoverage>();
  /**
   * The index of the history before tracking started, for the boundary it
   * was built at. The path to an entry never changes, so it holds across
   * `/tree` and is dropped only on reset.
   */
  private legacyIndex: LegacyIndex | undefined;

  bindPersistence(persist: ((event: RoutingContextEvent) => void) | undefined): void {
    this.persist = persist;
  }

  getLedger(): TopicLedger {
    return this.ledger;
  }

  getBranchState(): BranchState {
    return this.branchState;
  }

  /** Rebuild from the active branch; an unreadable branch starts empty. */
  restore(branch: readonly unknown[] | undefined): void {
    this.ledger = rebuildLedger(branch);
    this.branchState = classifyBranch(branch, this.ledger);
    this.entrySource = undefined;
    this.readCoverage.clear();
  }

  /** Re-read an untracked branch's state; a tracked branch keeps its ledger's. */
  refreshBranchState(branch: readonly unknown[] | undefined): void {
    if (this.ledger.events === 0) this.branchState = classifyBranch(branch, this.ledger);
  }

  /**
   * Record lines of an anchored file the model read for a work item; true
   * once the reads of this version of the file cover every line.
   */
  noteRead(workItemId: string, path: string, file: { sha256: string; lineCount: number }, range: LineRange): boolean {
    const key = `${workItemId}\0${path}`;
    let coverage = this.readCoverage.get(key);
    if (!coverage || coverage.sha256 !== file.sha256) {
      coverage = new ReadCoverage(file.sha256, file.lineCount);
      this.readCoverage.set(key, coverage);
    }
    const complete = coverage.add(range);
    if (complete) this.readCoverage.delete(key);
    return complete;
  }

  /**
   * Write one event to the branch, then fold it. Returns whether it applied:
   * an event that does not apply is not written, and one the branch did not
   * record is not applied.
   */
  append(event: RoutingContextEvent): boolean {
    const next = applyEvent(this.ledger, event);
    if (next === this.ledger) return false;
    try {
      this.persist?.(event);
    } catch (err) {
      debugLog('context.persist-error', { op: event.op, message: err instanceof Error ? err.message : String(err) });
      return false;
    }
    this.ledger = next;
    this.branchState = 'tracked';
    return true;
  }

  /** Persist a ready handoff as one branch entry before publishing any of its changes. */
  appendCommit(events: readonly RoutingContextEvent[]): boolean {
    const first = events[0];
    if (!first || first.op === 'context-commit' || events.length > CONTEXT_COMMIT_EVENT_LIMIT
      || events.some((event) => event.op === 'context-commit' || event.sourceEntryId !== first.sourceEntryId)) return false;
    let next = this.ledger;
    for (const event of events) {
      const applied = applyEvent(next, event);
      if (applied === next) return false;
      next = applied;
    }
    const record: RoutingContextEvent = { v: 1, op: 'context-commit', sourceEntryId: first.sourceEntryId,
      events: [...events] as FlatContextEvent[] };
    try {
      this.persist?.(record);
    } catch (err) {
      debugLog('context.persist-error', { op: record.op, message: err instanceof Error ? err.message : String(err) });
      return false;
    }
    this.ledger = next;
    this.branchState = 'tracked';
    return true;
  }

  getIncumbent(): Incumbent | undefined {
    return this.ledger.incumbent;
  }

  /**
   * Record the model the router chose outside collecting context, and the
   * work item it served. Written to the branch only when it changed, so a
   * resumed session restores it.
   */
  recordIncumbent(
    served: { registryId: string; thinkingLevel?: string },
    dimension: Dimension,
    sourceEntryId: string,
    workItemId?: string,
  ): void {
    const event: RoutingContextEvent = {
      v: 1,
      op: 'incumbent',
      served: { registryId: served.registryId, ...(served.thinkingLevel ? { thinkingLevel: served.thinkingLevel } : {}) },
      dimension,
      ...(workItemId ? { workItemId } : {}),
      sourceEntryId,
    };
    const next = applyEvent(this.ledger, event);
    if (next === this.ledger) return;
    try {
      this.persist?.(event);
    } catch (err) {
      debugLog('context.persist-error', { op: event.op, message: err instanceof Error ? err.message : String(err) });
      return;
    }
    this.ledger = next;
  }

  /** Pi switched to another model: the next router entry starts without an incumbent. */
  clearIncumbent(): void {
    if (!this.ledger.incumbent) return;
    const { incumbent: _ended, ...rest } = this.ledger;
    this.ledger = rest;
  }

  /** The index for `headEntryId`, built at most once per boundary. */
  legacyIndexFor(headEntryId: string, build: () => LegacyIndex): LegacyIndex {
    if (this.legacyIndex?.headEntryId !== headEntryId) this.legacyIndex = build();
    return this.legacyIndex;
  }

  getEntrySource(): string | undefined {
    return this.entrySource;
  }

  setEntrySource(sourceEntryId: string | undefined): void {
    this.entrySource = sourceEntryId;
  }

  reset(): void {
    this.ledger = emptyLedger();
    this.branchState = 'native-empty';
    this.entrySource = undefined;
    this.readCoverage.clear();
    this.legacyIndex = undefined;
  }
}

/**
 * Runtime extension context & model registry bindings that survive session resets.
 */
export class RuntimeBindings {
  constructor(
    /** Whether Chromium for Playwright is installed; `router/auto` routes only when it is. */
    readonly checkBrowser: () => Promise<PlaywrightCheck> = checkPlaywright,
  ) {}

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
  public readonly intent: IntentState;
  public readonly context = new RoutingContextState();
  private readonly trajectory = new TrajectoryState();

  private sessionGen = 0;
  private history: { entry: string; data: ModelHistory } | undefined;
  private decision: RoutingDecision | undefined;
  private chosenRegistryId: string | undefined;
  private served: ServedInfo | undefined;
  /** Preserve the incumbent while the next provider invocation is in flight. */
  private previousServed: ServedInfo | undefined;
  /** Estimated context tokens of the request being routed. */
  private requestTokens = 0;
  /** Identity of the prompt head (system prompt, tool list) the warm caches were written with. */
  private prefixIdentity: string | undefined;
  /** Per served candidate key: when it last served and the context tokens it sent. */
  private warmCaches = new Map<string, { at: number; tokens: number }>();
  private semiHold: { intentKey: string; model: string } | undefined;
  private notifiedModel: string | undefined;
  /**
   * Session-scoped manual model pin (`provider/id`) set via `/router-manual`.
   * When present the turn restricts scoring to this model,
   * and serves it with no fallback tail (pinned-only). Cleared on every
   * `session_start` reset, so a new session always starts on the auto router.
   */
  private manualModel: string | undefined;
  /**
   * The auto decision in effect just before the pin was engaged. `/router-manual
   * resume` reuses this (chosen model + fallback chain) for the next user entry
   * instead of recomputing. Captured at pin time because a manual turn overwrites
   * `decision`; held while pinned, then scheduled by `resumeManual()` and consumed by
   * `resolveResumeDecision()`. `resumeIntentKey` scopes the one-shot to a single
   * user entry so tool-loop continuations reuse it but the next entry recomputes.
   */
  private resumeSnapshot: RoutingDecision | undefined;
  private resumeIntentKey: string | undefined;
  private accumCost = 0;
  private resolvedThinkingLevel: string | undefined;
  private syncedThinkingLevel: string | undefined;
  private activeSkills: readonly string[] = [];
  private memoizedCandidateExpansion: { key: string; candidates: Candidate[] } | undefined;

  constructor(
    blacklist: BlacklistState = new BlacklistState(),
    intent: IntentState = new IntentState(),
  ) {
    this.blacklist = blacklist;
    this.intent = intent;
  }

  getModelHistory(entry: string): ModelHistory {
    if (this.history?.entry !== entry) this.history = { entry, data: loadModelHistory() };
    return this.history.data;
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
    if (s) this.warmCaches.set(servedKey(s), { at: Date.now(), tokens: this.requestTokens });
  }

  /**
   * Record the request being routed: its serve warms `tokens` of cache. A
   * different prompt head (skills, tools, or system prompt changed) shares no
   * prefix with any earlier request, so every warm cache is forgotten.
   */
  noteRequest(tokens: number, prefixIdentity: string): void {
    if (this.prefixIdentity !== prefixIdentity) this.warmCaches.clear();
    this.prefixIdentity = prefixIdentity;
    this.requestTokens = Math.max(0, tokens);
  }

  /**
   * Tokens each served candidate key's own prompt cache still holds: keys that
   * served within `ttlMs`, with the context they sent. A cached request larger
   * than the current one cannot be its prefix, so it holds nothing.
   */
  warmPrefixTokens(now: number, currentTokens: number, ttlMs: number): Map<string, number> {
    const warm = new Map<string, number>();
    for (const [key, entry] of this.warmCaches) {
      if (now - entry.at < ttlMs && entry.tokens <= currentTokens) warm.set(key, entry.tokens);
    }
    return warm;
  }

  /** Forget every cached prefix: compaction or tree navigation rewrote the history. */
  clearWarmCaches(): void {
    this.warmCaches.clear();
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
   * Leave manual mode and schedule a one-shot reuse of the pre-pin auto decision.
   * Returns whether a pin (or a scheduled snapshot) was active. Clears the pin and,
   * like leaving manual mode generally, discards pin-owned trajectory evidence so
   * auto routing cannot act on it. `resumeSnapshot` is retained (now scheduled) and
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
   * Scheduled only while no pin is active. The first invocation binds the one-shot to
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

  /**
   * Pi's thinking level right after the router last synced it, or undefined
   * when unknown. A later request at another level is a change the router did
   * not write.
   */
  getSyncedThinkingLevel(): string | undefined {
    return this.syncedThinkingLevel;
  }

  setSyncedThinkingLevel(level: string | undefined): void {
    this.syncedThinkingLevel = level;
  }

  getActiveSkillNames(): readonly string[] {
    return this.activeSkills;
  }

  setActiveSkillNames(names: readonly string[]): void {
    this.activeSkills = [...names];
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

  // ─── Direct Intent & Work-Phase Facade ────────────────────────────────

  getCachedIntent(): CachedRoutingIntent | undefined {
    return this.intent.getCachedIntent();
  }

  setCachedIntent(intent: CachedRoutingIntent | undefined): void {
    this.intent.setCachedIntent(intent);
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
   * (blocked preflights from this extension or another) and set a pending
   * escalation from that evidence before the next routing peek.
   */
  flushAndSetUnresolvedTrajectory(): void {
    const decision = this.abandonUnresolvedTrajectoryCalls();
    if (!decision) return;
    this.setPendingTrajectoryEscalation(
      decision,
      this.servedTrajectoryKey(),
      this.getLastDecision()?.dimension,
      false,
    );
  }

  setPendingTrajectoryEscalation(
    decision: StruggleDecision,
    fromModel: string | undefined,
    dimension: Dimension | undefined,
    preOutput: boolean,
  ): void {
    this.trajectory.maybeSetPending(decision, fromModel, dimension, preOutput);
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
    this.history = undefined;
    this.decision = undefined;
    this.chosenRegistryId = undefined;
    this.previousServed = undefined;
    this.requestTokens = 0;
    this.prefixIdentity = undefined;
    this.warmCaches.clear();
    this.semiHold = undefined;
    this.served = undefined;
    this.notifiedModel = undefined;
    this.manualModel = undefined;
    this.resumeSnapshot = undefined;
    this.resumeIntentKey = undefined;
    this.accumCost = 0;
    this.resolvedThinkingLevel = undefined;
    this.syncedThinkingLevel = undefined;
    this.activeSkills = [];
    this.memoizedCandidateExpansion = undefined;

    this.intent.reset();
    this.context.reset();
    this.trajectory.reset();
    // Note: blacklist exclusions are cleared independently via blacklist.clearSessionBlacklist()
  }
}

// ─── Default instances ─────────────────────────────────────────────────

export const defaultRuntimeBindings = new RuntimeBindings();
export const defaultRouterSession = new RouterSession(defaultBlacklistState);
