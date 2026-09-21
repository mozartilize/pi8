/**
 * Intent-scoped trajectory friction. Tool cycles accumulate until the intent
 * key changes; provider invocations must not reset it.
 */
import type { Dimension } from '../../types.js';
import type {
  PendingTrajectoryEscalation,
  ProgressKind,
  StruggleDecision,
} from './types.js';
import {
  classifyTrajectoryStruggle,
  type CycleRecord,
  type TrajectorySnapshot,
} from './detectors.js';
import {
  cycleFromToolResult,
  isVerifier,
  lineDistance,
  applyReplacement,
  type ObservedCycle,
  type ToolCycleInput,
} from './fingerprints.js';

const MAX_CYCLES = 8;
const MAX_EVIDENCE = 256;
const MAX_FAILURES = 32;
const MAX_BATCH = 32;
const MAX_SEEN = 128;

export class TrajectoryState {
  private intentKey: string | undefined;
  private cycles: CycleRecord[] = [];
  private evidenceFrontier = new Set<string>();
  private activeFailures = new Set<string>();
  private failureCorrections = new Map<string, number>();
  private failureLastVerifier = new Map<string, number>();
  private lastMutationInvocation = -1;
  private mutationCount = 0;
  private grossDistance = 0;
  private fileBaseline = new Map<string, string>();
  private fileCurrent = new Map<string, string>();
  private mbTrusted = true;
  private stagnationRun = 0;
  private pending: PendingTrajectoryEscalation | undefined;
  private lastEscalateFingerprint: string | undefined;
  private pendingCalls: Array<{ toolCallId: string; toolName: string; input?: unknown }> = [];
  private pendingResults = new Map<string, ToolCycleInput>();
  private completedIds = new Set<string>();

  reset(): void {
    this.intentKey = undefined;
    this.cycles = [];
    this.evidenceFrontier.clear();
    this.activeFailures.clear();
    this.failureCorrections.clear();
    this.failureLastVerifier.clear();
    this.lastMutationInvocation = -1;
    this.mutationCount = 0;
    this.grossDistance = 0;
    this.fileBaseline.clear();
    this.fileCurrent.clear();
    this.mbTrusted = true;
    this.stagnationRun = 0;
    this.pending = undefined;
    this.lastEscalateFingerprint = undefined;
    this.pendingCalls = [];
    this.pendingResults.clear();
    this.completedIds.clear();
  }

  bindIntent(intentKey: string): void {
    if (this.intentKey === intentKey) return;
    this.reset();
    this.intentKey = intentKey;
  }

  snapshot(): TrajectorySnapshot {
    let netDistance = 0;
    if (this.mbTrusted) {
      for (const [path, current] of this.fileCurrent) {
        const baseline = this.fileBaseline.get(path) ?? current;
        const distance = lineDistance(baseline, current);
        netDistance += distance.added + distance.deleted;
      }
    }
    return {
      cycles: this.cycles,
      mutationCount: this.mutationCount,
      grossDistance: this.grossDistance,
      netDistance,
      stagnationRun: this.stagnationRun,
      failureCorrections: this.failureCorrections,
      mbTrusted: this.mbTrusted,
    };
  }

  observeToolResult(event: ToolCycleInput, invocation: number): StruggleDecision | undefined {
    if (this.completedIds.has(event.toolCallId)) {
      return undefined;
    }
    const inBatch = this.pendingCalls.some((call) => call.toolCallId === event.toolCallId);
    if (inBatch) {
      if (!this.pendingResults.has(event.toolCallId)) {
        this.pendingResults.set(event.toolCallId, event);
      }
      if (!this.pendingCalls.every((call) => this.pendingResults.has(call.toolCallId))) {
        return undefined;
      }
      return this.flushBatch(invocation);
    }
    this.rememberCompleted(event.toolCallId);
    const observed = cycleFromToolResult(event, invocation);
    this.applyCycle(observed);
    return classifyTrajectoryStruggle(this.snapshot());
  }

  noteToolCall(toolName: string, toolCallId: string, input?: unknown): StruggleDecision | undefined {
    if (this.completedIds.has(toolCallId)) return undefined;
    if (this.pendingCalls.some((call) => call.toolCallId === toolCallId)) return undefined;
    let flushed: StruggleDecision | undefined;
    if (this.pendingResults.size > 0) {
      // Results already arrived for the previous batch. A new call means that
      // batch is closed; missing siblings were blocked preflights (ours or
      // another extension's). The caller must arm from the returned
      // decision — cycles are applied here, but pending escalation is not.
      flushed = this.abandonUnresolvedCalls();
    }
    this.pendingCalls.push({ toolCallId, toolName, input });
    if (this.pendingCalls.length > MAX_BATCH) this.pendingCalls.shift();
    return flushed;
  }

  abandonUnresolvedCalls(): StruggleDecision | undefined {
    if (this.pendingCalls.length === 0) return undefined;
    if (this.pendingResults.size > 0) {
      return this.flushBatch(this.lastMutationInvocation < 0 ? 0 : this.lastMutationInvocation);
    }
    this.pendingCalls = [];
    this.pendingResults.clear();
    return undefined;
  }

  peekPending(): PendingTrajectoryEscalation | undefined {
    return this.pending;
  }

  setPending(pending: PendingTrajectoryEscalation | undefined): void {
    this.pending = pending;
  }

  consumePending(): PendingTrajectoryEscalation | undefined {
    const pending = this.pending;
    this.pending = undefined;
    return pending;
  }

  maybeArmPending(
    decision: StruggleDecision,
    fromModel: string | undefined,
    dimension: Dimension | undefined,
    preOutput: boolean,
  ): void {
    if (!fromModel || !dimension) return;
    if (!decision.escalate) {
      this.pending = undefined;
      this.lastEscalateFingerprint = undefined;
      return;
    }
    const fingerprint = decision.signals
      .map((signal) => `${signal.kind}:${signal.severity}:${signal.evidenceIds.join(',')}`)
      .join('|');
    if (fingerprint === this.lastEscalateFingerprint) return;
    this.lastEscalateFingerprint = fingerprint;
    this.pending = {
      fromModel,
      dimension,
      signals: decision.signals.filter((signal) => signal.severity === 'warning' || signal.severity === 'severe'),
      tfi: decision.tfi,
      preOutput,
    };
  }

  private rememberCompleted(toolCallId: string): void {
    this.completedIds.add(toolCallId);
    if (this.completedIds.size > MAX_SEEN) {
      const first = this.completedIds.values().next().value;
      if (first) this.completedIds.delete(first);
    }
  }

  private flushBatch(invocation: number): StruggleDecision {
    for (const call of this.pendingCalls) {
      const event = this.pendingResults.get(call.toolCallId);
      if (!event) continue;
      this.rememberCompleted(call.toolCallId);
      this.applyCycle(cycleFromToolResult({
        ...event,
        toolName: call.toolName,
        toolCallId: call.toolCallId,
        input: event.input ?? call.input,
      }, invocation));
    }
    this.pendingCalls = [];
    this.pendingResults.clear();
    return classifyTrajectoryStruggle(this.snapshot());
  }

  private applyCycle(observed: ObservedCycle): void {
    this.trackFileSnapshot(observed);
    const progressKind = this.classifyProgress(observed);
    if (observed.action.family === 'mutation' && observed.progressHint.isError !== true) {
      this.mutationCount += 1;
      this.lastMutationInvocation = observed.invocation;
      this.applyMutationDisplacement(observed);
    }

    if (isVerifier(observed.action)) {
      this.updateFailures(observed);
    }

    if (progressKind === 'progress') {
      this.stagnationRun = 0;
      this.evidenceFrontier.add(observed.evidenceId);
    } else if (progressKind === 'none') {
      this.stagnationRun += 1;
    } else if (
      observed.action.family === 'read'
      || observed.action.family === 'search'
      || observed.action.commandClass === 'inspect'
    ) {
      this.evidenceFrontier.add(observed.evidenceId);
    }

    this.cycles.push({
      invocation: observed.invocation,
      action: observed.action,
      observationKey: observed.observationKey,
      progressKind,
      failureSignature: observed.progressHint.failureSignature,
      evidenceId: observed.evidenceId,
    });
    if (this.cycles.length > MAX_CYCLES) this.cycles.shift();
    if (this.evidenceFrontier.size > MAX_EVIDENCE) {
      const first = this.evidenceFrontier.values().next().value;
      if (first) this.evidenceFrontier.delete(first);
    }
  }

  private trackFileSnapshot(observed: ObservedCycle): void {
    const path = observed.action.path ?? observed.progressHint.mutationPath;
    const body = observed.progressHint.fileBody;
    if (!path || !body) return;
    if (observed.action.family === 'read' && !this.fileBaseline.has(path)) {
      this.fileBaseline.set(path, body);
      this.fileCurrent.set(path, body);
    }
  }

  private applyMutationDisplacement(observed: ObservedCycle): void {
    const path = observed.progressHint.mutationPath ?? observed.action.path;
    if (!path) {
      this.mbTrusted = false;
      return;
    }
    const next = this.nextFileBody(path, observed);
    if (next == null) {
      this.mbTrusted = false;
      return;
    }
    const prev = this.fileCurrent.get(path);
    if (prev == null) {
      this.fileBaseline.set(path, next);
      this.fileCurrent.set(path, next);
      return;
    }
    const step = lineDistance(prev, next);
    this.grossDistance += step.added + step.deleted;
    this.fileCurrent.set(path, next);
  }

  private nextFileBody(path: string, observed: ObservedCycle): string | undefined {
    if (observed.progressHint.fileBody != null) return observed.progressHint.fileBody;
    const oldText = observed.progressHint.mutationOldText;
    const newText = observed.progressHint.mutationNewText;
    if (oldText == null || newText == null) return undefined;
    const current = this.fileCurrent.get(path);
    if (current == null) return undefined;
    return applyReplacement(current, oldText, newText);
  }

  private classifyProgress(observed: ObservedCycle): ProgressKind {
    if (observed.action.family === 'mutation') return 'unknown';
    if (
      observed.action.family === 'read'
      || observed.action.family === 'search'
      || observed.action.commandClass === 'inspect'
    ) {
      return this.evidenceFrontier.has(observed.evidenceId) ? 'none' : 'progress';
    }
    if (isVerifier(observed.action)) {
      const signature = observed.progressHint.failureSignature;
      if (!observed.progressHint.isError && !signature && this.activeFailures.size > 0) {
        return 'progress';
      }
      if (signature && this.activeFailures.size > 0 && !this.activeFailures.has(signature)) {
        return 'progress';
      }
      if (signature || observed.progressHint.isError) return 'none';
      return 'unknown';
    }
    return 'unknown';
  }

  private updateFailures(observed: ObservedCycle): void {
    const signature = observed.progressHint.failureSignature;
    if (!observed.progressHint.isError && !signature) {
      this.activeFailures.clear();
      this.failureCorrections.clear();
      this.failureLastVerifier.clear();
      return;
    }
    if (!signature) return;

    for (const existing of [...this.activeFailures]) {
      if (existing !== signature) {
        this.activeFailures.delete(existing);
        this.failureCorrections.delete(existing);
        this.failureLastVerifier.delete(existing);
      }
    }

    const lastVerifier = this.failureLastVerifier.get(signature) ?? -1;
    if (
      this.activeFailures.has(signature)
      && this.lastMutationInvocation > lastVerifier
      && this.lastMutationInvocation < observed.invocation
    ) {
      const next = (this.failureCorrections.get(signature) ?? 0) + 1;
      this.failureCorrections.set(signature, next);
    }
    this.activeFailures.add(signature);
    this.failureLastVerifier.set(signature, observed.invocation);
    if (this.failureCorrections.size > MAX_FAILURES) {
      const first = this.failureCorrections.keys().next().value;
      if (first) this.failureCorrections.delete(first);
    }
  }
}
