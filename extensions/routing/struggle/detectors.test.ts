import { describe, expect, it } from 'vitest';
import {
  classifyTrajectoryStruggle,
  detectActionObservationRecurrence,
  detectFailurePersistence,
  detectMutationBacktracking,
  detectProgressStagnation,
  type CycleRecord,
  type TrajectorySnapshot,
} from './detectors.js';
import type { ActionFingerprint } from './fingerprints.js';

function action(family: ActionFingerprint['family'], key: string): ActionFingerprint {
  return { family, key };
}

function cycle(
  evidenceId: string,
  progressKind: CycleRecord['progressKind'],
  extra?: Partial<CycleRecord>,
): CycleRecord {
  const [actionKey, observationKey] = evidenceId.split(':');
  return {
    invocation: extra?.invocation ?? 1,
    action: extra?.action ?? action('read', actionKey ?? 'a'),
    observationKey: extra?.observationKey ?? observationKey ?? 'o',
    progressKind,
    evidenceId,
    failureSignature: extra?.failureSignature,
  };
}

function snapshot(partial: Partial<TrajectorySnapshot>): TrajectorySnapshot {
  return {
    cycles: [],
    mutationCount: 0,
    grossDistance: 0,
    netDistance: 0,
    stagnationRun: 0,
    failureCorrections: new Map(),
    ...partial,
  };
}

describe('AOR', () => {
  it('warns on the second equivalent pair and goes severe on the third', () => {
    const two = snapshot({
      cycles: [cycle('a:o', 'none'), cycle('a:o', 'none')],
    });
    expect(detectActionObservationRecurrence(two).severity).toBe('warning');
    const three = snapshot({
      cycles: [cycle('a:o', 'none'), cycle('a:o', 'none'), cycle('a:o', 'none')],
    });
    expect(detectActionObservationRecurrence(three).severity).toBe('severe');
  });

  it('breaks the chain on confirmed progress', () => {
    const cycles = [
      cycle('a:o', 'none'),
      cycle('a:o', 'progress'),
      cycle('a:o', 'none'),
    ];
    expect(detectActionObservationRecurrence(snapshot({ cycles })).severity).toBe('none');
  });
});

describe('failure persistence', () => {
  it('uses correction count, not set overlap', () => {
    expect(
      detectFailurePersistence(snapshot({ failureCorrections: new Map([['F1', 1]]) })).severity,
    ).toBe('warning');
    expect(
      detectFailurePersistence(snapshot({ failureCorrections: new Map([['F1', 2]]) })).severity,
    ).toBe('severe');
  });
});

describe('mutation backtracking', () => {
  it('is unavailable until three mutations have distance', () => {
    expect(
      detectMutationBacktracking(snapshot({ mutationCount: 2, grossDistance: 10, netDistance: 2 })).severity,
    ).toBe('unavailable');
  });

  it('computes B = 1 - N/G', () => {
    const severe = detectMutationBacktracking(
      snapshot({ mutationCount: 3, grossDistance: 200, netDistance: 0 }),
    );
    expect(severe.severity).toBe('severe');
    const warning = detectMutationBacktracking(
      snapshot({ mutationCount: 3, grossDistance: 100, netDistance: 60 }),
    );
    expect(warning.severity).toBe('warning');
  });

  it('is unavailable when file snapshots cannot be trusted', () => {
    expect(
      detectMutationBacktracking(
        snapshot({ mutationCount: 4, grossDistance: 100, netDistance: 0, mbTrusted: false }),
      ).severity,
    ).toBe('unavailable');
  });
});

describe('progress stagnation', () => {
  it('warns at 2 confirmed-no-progress cycles', () => {
    const cycles = [cycle('a:1', 'none'), cycle('b:2', 'none')];
    expect(detectProgressStagnation(snapshot({ cycles, stagnationRun: 2 })).severity).toBe('warning');
  });
});

describe('evidence lattice', () => {
  it('does not escalate two warnings that share evidence', () => {
    const cycles = [cycle('a:o', 'none'), cycle('a:o', 'none')];
    const decision = classifyTrajectoryStruggle(snapshot({ cycles, stagnationRun: 2 }));
    expect(decision.signals.find((s) => s.kind === 'aor')?.severity).toBe('warning');
    expect(decision.signals.find((s) => s.kind === 'stagnation')?.severity).toBe('warning');
    expect(decision.escalate).toBe(false);
  });

  it('escalates AOR severe even without a second family', () => {
    const cycles = [cycle('a:o', 'none'), cycle('a:o', 'none'), cycle('a:o', 'none')];
    expect(classifyTrajectoryStruggle(snapshot({ cycles, stagnationRun: 3 })).escalate).toBe(true);
  });

  it('does not escalate backtracking alone', () => {
    const decision = classifyTrajectoryStruggle(
      snapshot({ mutationCount: 4, grossDistance: 100, netDistance: 0 }),
    );
    expect(decision.signals.find((s) => s.kind === 'backtracking')?.severity).toBe('severe');
    expect(decision.escalate).toBe(false);
  });

  it('escalates backtracking plus an independent warning', () => {
    const decision = classifyTrajectoryStruggle(
      snapshot({
        mutationCount: 4,
        grossDistance: 100,
        netDistance: 0,
        failureCorrections: new Map([['F1', 1]]),
      }),
    );
    expect(decision.escalate).toBe(true);
  });
});
