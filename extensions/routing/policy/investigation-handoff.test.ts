import { describe, expect, it } from 'vitest';
import {
  MAX_EVIDENCE_PATHS,
  acceptInvestigationHandoff,
  entryPhase,
  evidencePaths,
  evidenceShape,
  investigationOwed,
  noteInvestigationRead,
  reasoningTarget,
  serveReasoningHandoff,
} from './investigation-handoff.js';
import type { WorkPhaseState } from './work-phase.js';
import type { TerminalAssessment } from '../../types.js';

const terminal = (over: Partial<TerminalAssessment> = {}): TerminalAssessment => ({
  kind: 'gather', complexity: 'routine', scope: 'bounded', compound: false, confidence: 'high', ...over,
});

const state = (over: Partial<WorkPhaseState> = {}): WorkPhaseState => ({
  intentKey: 'intent-a',
  deliverable: 'plan',
  terminal: terminal(),
  terminalBand: 'standard',
  providerInvocation: 2,
  observedMutationTools: 0,
  ...over,
});

const handoff = {
  requester: 'a/cheap',
  target: 'plan' as const,
  minimum: 0.58,
  requirement: 0.58,
  rubric: { alternatives: 3, stakes: 1, spread: 1, knowledge: 1, uncertainty: 1 },
  evidence: { applicable: false, files: 0, directories: 0 },
};

describe('entry phase', () => {
  it.each([
    ['plan', terminal(), 'gather', 'investigation'],
    ['review', terminal(), 'gather', 'investigation'],
    ['implement', terminal({ kind: 'implement', compound: true, confidence: 'high' }), 'gather', 'investigation'],
    ['implement', terminal({ kind: 'implement', compound: true, confidence: 'low' }), 'implement', undefined],
    ['implement', terminal({ kind: 'implement' }), 'implement', undefined],
    ['gather', terminal(), 'gather', undefined],
    ['lightweight', terminal({ kind: 'lightweight' }), 'lightweight', undefined],
  ] as const)('a %s deliverable routes as its investigation until handoff', (deliverable, t, dimension, cause) => {
    const entry = state({ deliverable, terminal: t });
    expect(entryPhase(entry, deliverable, false)).toEqual({ dimension, ...(cause ? { cause } : {}) });
  });

  it('routes the rest of the entry at the handoff target', () => {
    const accepted = acceptInvestigationHandoff(state({ deliverable: 'review' }), { ...handoff, target: 'review' });
    expect(entryPhase(accepted, 'review', false)).toEqual({ dimension: 'review', cause: 'investigation-handoff' });
    const fromGather = acceptInvestigationHandoff(state({ deliverable: 'gather' }), handoff);
    expect(entryPhase(fromGather, 'gather', false)).toEqual({ dimension: 'plan', cause: 'investigation-handoff' });
  });

  it('lets a pinned model serve the deliverable directly', () => {
    expect(entryPhase(state(), 'plan', true)).toEqual({ dimension: 'plan' });
    expect(entryPhase(undefined, 'plan', false)).toEqual({ dimension: 'plan' });
  });

  it('owes an investigation only for plan, review, and confident compound implementation', () => {
    expect(investigationOwed(state({ deliverable: 'gather' }))).toBe(false);
    expect(investigationOwed(undefined)).toBe(false);
    expect(reasoningTarget('review')).toBe('review');
    expect(reasoningTarget('implement')).toBe('plan');
    expect(reasoningTarget('gather')).toBe('plan');
  });
});

describe('handoff boundary', () => {
  it('accepts once and stays pending until an invocation serves it', () => {
    const accepted = acceptInvestigationHandoff(state(), handoff);
    expect(accepted.reasoningHandoff).toMatchObject({ id: 'intent-a', pending: true });
    expect(acceptInvestigationHandoff(accepted, { ...handoff, minimum: 0.85 })).toBe(accepted);
    const owned = serveReasoningHandoff(accepted, 'b/planner');
    expect(owned.reasoningHandoff).toMatchObject({ pending: false, owner: 'b/planner' });
    expect(serveReasoningHandoff(owned, 'c/other')).toBe(owned);
  });
});

describe('evidence', () => {
  it('keeps the most recent reads first, deduplicated and capped, and stops after the handoff', () => {
    let entry = state();
    for (let i = 0; i < MAX_EVIDENCE_PATHS + 5; i += 1) entry = noteInvestigationRead(entry, `/repo/f${i}.ts`);
    entry = noteInvestigationRead(entry, '/repo/f3.ts');
    expect(entry.readPaths).toHaveLength(MAX_EVIDENCE_PATHS);
    expect(entry.readPaths![0]).toBe('/repo/f3.ts');
    expect(entry.readPaths!.filter((p) => p === '/repo/f3.ts')).toHaveLength(1);
    const handed = acceptInvestigationHandoff(entry, handoff);
    expect(noteInvestigationRead(handed, '/repo/late.ts')).toBe(handed);
  });

  it('measures declared files first, then reads, so an empty declaration after reads is still measured', () => {
    const reads = Array.from({ length: 30 }, (_, i) => `/repo/r${i}.ts`);
    const paths = evidencePaths(['/repo/a.ts', '/repo/r0.ts'], reads);
    expect(paths.slice(0, 3)).toEqual(['/repo/a.ts', '/repo/r0.ts', '/repo/r1.ts']);
    expect(paths).toHaveLength(MAX_EVIDENCE_PATHS);
    expect(evidencePaths([], ['/repo/x.ts'])).toEqual(['/repo/x.ts']);
    expect(evidenceShape(evidencePaths([], ['/repo/x.ts'])).applicable).toBe(true);
  });

  it('counts files and directories, and is not applicable without files', () => {
    expect(evidenceShape(['/repo/a/x.ts', '/repo/a/y.ts', '/repo/b/z.ts']))
      .toEqual({ applicable: true, files: 3, directories: 2 });
    expect(evidenceShape([])).toEqual({ applicable: false, files: 0, directories: 0 });
  });
});
