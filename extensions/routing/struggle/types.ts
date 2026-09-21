/**
 * Trajectory-friction types. Severity is structural, not a probability.
 * `unavailable` means the detector lacked the evidence it needs — never treat
 * that as "measured and fine".
 */
export type StruggleSeverity = 'none' | 'warning' | 'severe' | 'unavailable';

export type StruggleKind = 'aor' | 'failure-persistence' | 'backtracking' | 'stagnation' | 'reasoning-loop';

export interface StruggleSignal {
  kind: StruggleKind;
  severity: StruggleSeverity;
  /** Stable ids used to reject correlated double-counting. */
  evidenceIds: string[];
  evidenceCount: number;
}

export interface StruggleDecision {
  escalate: boolean;
  tfi: number;
  signals: StruggleSignal[];
}

export interface PendingTrajectoryEscalation {
  fromModel: string;
  dimension: import('../../types.js').Dimension;
  signals: StruggleSignal[];
  tfi: number;
  preOutput: boolean;
}

export type ProgressKind = 'progress' | 'none' | 'unknown';
