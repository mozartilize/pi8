/**
 * Pure severity calculation from a trajectory snapshot.
 *
 * AOR counts equivalent (action, observation) pairs, not max similarity.
 * PS ignores `unknown` cycles so unverified mutations do not look like stalls.
 *
 * Independence is checked by evidence-id overlap, which is a deliberately
 * narrow test: it collapses two detectors that cite literally the same ids,
 * not two detectors reading the same underlying cycle through different
 * lenses. Families namespace their ids differently (`fail:<signature>` vs
 * `<action-key>:<observation-key>`), so FP and PS can both fire on one
 * failing verifier loop and count as two warnings. That is intended — they
 * measure different properties — but it is overlap rejection, not general
 * correlation rejection, and reading it as the latter overstates the
 * guarantee. Stronger correlation rejection would need shared cycle
 * provenance on the evidence ids themselves.
 */
import type { StruggleDecision, StruggleSeverity, StruggleSignal } from './types.js';
import type { ActionFingerprint } from './fingerprints.js';

export const AOR_WINDOW = 6;
export const AOR_WARNING = 2;
export const AOR_SEVERE = 3;
export const FP_WARNING = 1;
export const FP_SEVERE = 2;
export const MB_MIN_MUTATIONS = 3;
export const MB_WARNING = 0.35;
export const MB_SEVERE = 0.6;
export const PS_WARNING = 2;
export const PS_SEVERE = 3;

export interface CycleRecord {
  invocation: number;
  action: ActionFingerprint;
  observationKey: string;
  observationVerified?: boolean;
  progressKind: import('./types.js').ProgressKind;
  failureSignature?: string;
  evidenceId: string;
}

export interface TrajectorySnapshot {
  cycles: readonly CycleRecord[];
  mutationCount: number;
  grossDistance: number;
  netDistance: number;
  stagnationRun: number;
  /** False when initial-to-current file content could not be reconstructed. */
  mbTrusted?: boolean;
  /** Failure signature → distinct corrective attempts that left it alive. */
  failureCorrections: ReadonlyMap<string, number>;
}

function severityValue(severity: StruggleSeverity): number {
  if (severity === 'severe') return 1;
  if (severity === 'warning') return 0.5;
  return 0;
}

function signal(
  kind: StruggleSignal['kind'],
  severity: StruggleSeverity,
  evidenceIds: string[],
): StruggleSignal {
  return { kind, severity, evidenceIds, evidenceCount: evidenceIds.length };
}

export function detectActionObservationRecurrence(snapshot: TrajectorySnapshot): StruggleSignal {
  const window = snapshot.cycles.slice(-AOR_WINDOW);
  const last = window[window.length - 1];
  if (!last) return signal('aor', 'none', []);
  // Path-only mutation fingerprints collide across distinct successful edits.
  // Unverified mutations stay unknown; they are not "no progress".
  if (last.observationVerified === false || last.action.equivalenceVerified === false
    || (last.action.family === 'mutation' && last.action.mutationVerified !== true)) {
    return signal('aor', 'none', []);
  }
  let count = 0;
  for (let i = window.length - 1; i >= 0; i -= 1) {
    const cycle = window[i];
    if (cycle.progressKind === 'progress' || cycle.observationVerified === false
      || cycle.action.equivalenceVerified === false) break;
    if (cycle.action.family === 'mutation' && cycle.action.mutationVerified !== true) continue;
    if (cycle.action.key === last.action.key && cycle.observationKey === last.observationKey) {
      count += 1;
    }
  }
  const evidence = count >= AOR_WARNING ? [last.evidenceId] : [];
  if (count >= AOR_SEVERE) return signal('aor', 'severe', evidence);
  if (count >= AOR_WARNING) return signal('aor', 'warning', evidence);
  return signal('aor', 'none', []);
}

export function detectFailurePersistence(snapshot: TrajectorySnapshot): StruggleSignal {
  let maxCorrections = 0;
  let evidence: string[] = [];
  for (const [signature, corrections] of snapshot.failureCorrections) {
    if (corrections > maxCorrections) {
      maxCorrections = corrections;
      evidence = [`fail:${signature}`];
    }
  }
  if (maxCorrections >= FP_SEVERE) return signal('failure-persistence', 'severe', evidence);
  if (maxCorrections >= FP_WARNING) return signal('failure-persistence', 'warning', evidence);
  return signal('failure-persistence', 'none', []);
}

export function detectMutationBacktracking(snapshot: TrajectorySnapshot): StruggleSignal {
  if (snapshot.mbTrusted === false) {
    return signal('backtracking', 'unavailable', []);
  }
  if (snapshot.mutationCount < MB_MIN_MUTATIONS || snapshot.grossDistance <= 0) {
    return signal('backtracking', 'unavailable', []);
  }
  const ratio = 1 - snapshot.netDistance / snapshot.grossDistance;
  const evidence = ['mb'];
  if (ratio >= MB_SEVERE) return signal('backtracking', 'severe', evidence);
  if (ratio >= MB_WARNING) return signal('backtracking', 'warning', evidence);
  return signal('backtracking', 'none', []);
}

export function detectProgressStagnation(snapshot: TrajectorySnapshot): StruggleSignal {
  const run = snapshot.cycles.slice(-snapshot.stagnationRun);
  const evidence = run.map((cycle) => cycle.evidenceId);
  if (snapshot.stagnationRun >= PS_SEVERE) return signal('stagnation', 'severe', evidence);
  if (snapshot.stagnationRun >= PS_WARNING) return signal('stagnation', 'warning', evidence);
  return signal('stagnation', 'none', []);
}

function sharesEvidence(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const other = new Set(b);
  return a.some((id) => other.has(id));
}

function independentWarningCount(signals: readonly StruggleSignal[]): number {
  const active = signals.filter(
    (item) => item.severity === 'warning' || item.severity === 'severe',
  );
  const kept: StruggleSignal[] = [];
  for (const item of active) {
    const redundant = kept.some((prior) => sharesEvidence(item.evidenceIds, prior.evidenceIds));
    if (!redundant) kept.push(item);
  }
  return kept.length;
}

export function classifyTrajectoryStruggle(snapshot: TrajectorySnapshot): StruggleDecision {
  const aor = detectActionObservationRecurrence(snapshot);
  const fp = detectFailurePersistence(snapshot);
  const mb = detectMutationBacktracking(snapshot);
  const ps = detectProgressStagnation(snapshot);
  const signals = [aor, fp, mb, ps];

  const severeImmediate =
    aor.severity === 'severe' || fp.severity === 'severe' || ps.severity === 'severe';
  const warnings = independentWarningCount(signals);
  const backtrackingOnly =
    (mb.severity === 'severe' || mb.severity === 'warning')
    && aor.severity === 'none'
    && fp.severity === 'none'
    && ps.severity === 'none';

  const tfi = 1
    - (1 - severityValue(aor.severity))
    * (1 - severityValue(fp.severity))
    * (1 - severityValue(mb.severity))
    * (1 - severityValue(ps.severity));

  return {
    escalate: severeImmediate || (!backtrackingOnly && warnings >= 2),
    tfi,
    signals,
  };
}
