import { describe, expect, it } from 'vitest';
import {
  ACQUISITION_DENIAL_LIMIT,
  MAX_EVIDENCE_PATHS,
  acceptContextHandoff,
  acquisitionAllows,
  acquisitionRestricted,
  contextOwed,
  owedContext,
  countDenial,
  entryPhase,
  evidencePaths,
  evidenceShape,
  noteContextRead,
  serveContextHandoff,
} from './context-acquisition.js';
import type { WorkPhaseState } from './work-phase.js';
import type { TerminalAssessment } from '../../types.js';

const terminal = (over: Partial<TerminalAssessment> = {}): TerminalAssessment => ({
  kind: 'gather', complexity: 'routine', scope: 'bounded', ...over,
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

const reasoning = {
  requester: 'a/cheap',
  target: 'plan' as const,
  minimum: 0.58,
  requirement: 0.58,
  rubric: { alternatives: 3, stakes: 1, spread: 1, knowledge: 1, uncertainty: 1 },
  evidence: { applicable: false, files: 0, directories: 0 },
};

describe('entry phase', () => {
  it.each([
    ['plan', {}, 'gather', 'investigation'],
    ['review', {}, 'gather', 'investigation'],
    ['implement', { contextReasons: ['referenced-artifact'], contextSatisfied: false }, 'gather', 'investigation'],
    ['implement', { contextReasons: ['carried-open-context'], contextSatisfied: false }, 'gather', 'investigation'],
    ['implement', { contextReasons: ['referenced-artifact'], contextSatisfied: true }, 'gather', 'investigation'],
    ['implement', { contextReasons: [], contextSatisfied: true }, 'gather', 'investigation'],
    ['implement', {}, 'gather', 'investigation'],
    ['gather', { contextReasons: ['referenced-artifact'], contextSatisfied: false }, 'gather', 'investigation'],
    ['lightweight', { contextReasons: ['referenced-artifact'], contextSatisfied: false }, 'gather', 'investigation'],
  ] as const)('a %s deliverable with %j routes as its acquisition until handoff', (deliverable, over, dimension, cause) => {
    const entry = state({ deliverable, ...over } as Partial<WorkPhaseState>);
    expect(entryPhase(entry, deliverable)).toEqual({ dimension, ...(cause ? { cause } : {}) });
  });

  it('routes the rest of the entry at the accepted deliverable', () => {
    const toReview = acceptContextHandoff(state({ deliverable: 'review' }), {
      deliverable: 'review', key: 'k', reasoning: { ...reasoning, target: 'review' },
    });
    expect(entryPhase(toReview, 'review')).toEqual({ dimension: 'review', cause: 'investigation-handoff' });
    const toImplement = acceptContextHandoff(
      state({ deliverable: 'implement', contextReasons: ['referenced-artifact'], contextSatisfied: false, contextStatus: 'acquiring' }),
      { deliverable: 'implement', key: 'k' },
    );
    expect(entryPhase(toImplement, 'implement')).toEqual({ dimension: 'implement', cause: 'investigation-handoff' });
    expect(entryPhase(serveContextHandoff(toImplement, 'b/x'), 'implement'))
      .toEqual({ dimension: 'implement', cause: 'investigation-handoff' });
  });

  it('keeps a clarification-only entry in the restricted phase whatever it owes', () => {
    const entry = state({ deliverable: 'implement', contextStatus: 'clarification-only' });
    expect(contextOwed(entry)).toBe(false);
    expect(entryPhase(entry, 'implement')).toEqual({ dimension: 'gather', cause: 'investigation' });
  });

  it('lists every reason an entry owes', () => {
    expect(owedContext(state({ deliverable: 'review', contextReasons: ['referenced-artifact'], contextSatisfied: false })))
      .toEqual(['reasoning-prep', 'referenced-artifact']);
    expect(owedContext(state({ deliverable: 'gather' }))).toEqual([]);
    expect(owedContext(undefined)).toEqual([]);
  });
});

describe('handoff boundary', () => {
  it('accepts once and stays pending until an invocation serves it', () => {
    const accepted = acceptContextHandoff(state({ contextStatus: 'acquiring' }), { deliverable: 'plan', key: 'k', reasoning });
    expect(accepted).toMatchObject({ contextStatus: 'ready-pending', handoffKey: 'k' });
    expect(accepted.reasoningHandoff).toMatchObject({ id: 'intent-a', pending: true });
    expect(acceptContextHandoff(accepted, { deliverable: 'review', key: 'other' })).toBe(accepted);
    const owned = serveContextHandoff(accepted, 'b/planner');
    expect(owned.contextStatus).toBe('served');
    expect(owned.reasoningHandoff).toMatchObject({ pending: false, owner: 'b/planner' });
    expect(serveContextHandoff(owned, 'c/other')).toBe(owned);
  });
});

describe('restricted tools', () => {
  it('allows only exact trusted readers, the question tool, the handoff, and routing_context', () => {
    for (const tool of ['read', 'grep', 'find', 'ls', 'tilth_read', 'tilth_search', 'ask_user_question', 'hand_off_context']) {
      expect(acquisitionAllows('acquiring', tool)).toBe(true);
    }
    for (const tool of ['edit', 'write', 'bash', 'ctx_execute', 'ctx_execute_file', 'subagent', 'commit_execution', 'read_file', 'mcp']) {
      expect(acquisitionAllows('acquiring', tool)).toBe(false);
    }
    expect(acquisitionAllows('acquiring', 'routing_context')).toBe(true);
    expect(acquisitionAllows('clarification-only', 'read')).toBe(false);
    expect(acquisitionAllows('clarification-only', 'hand_off_context')).toBe(false);
    expect(acquisitionAllows('acquiring', 'ffgrep')).toBe(false);
    expect(acquisitionAllows('acquiring', 'reopen_work')).toBe(false);
    expect(acquisitionAllows('ready-pending', 'reopen_work')).toBe(true);
  });

  it('restricts until a model serves the next phase', () => {
    expect(acquisitionRestricted(state({ contextStatus: 'acquiring' }))).toBe(true);
    expect(acquisitionRestricted(state({ contextStatus: 'clarification-only' }))).toBe(true);
    expect(acquisitionRestricted(state({ contextStatus: 'ready-pending' }))).toBe(true);
    expect(acquisitionRestricted(state({ contextStatus: 'served' }))).toBe(false);
    expect(acquisitionRestricted(state())).toBe(false);
  });

  it('counts refusals once per invocation and ends acquisition at the limit', () => {
    let entry = state({ contextStatus: 'acquiring', providerInvocation: 1 });
    entry = countDenial(entry);
    expect(countDenial(entry)).toBe(entry);
    expect(entry).toMatchObject({ contextDenials: 1, contextStatus: 'acquiring' });
    for (let i = 2; i <= ACQUISITION_DENIAL_LIMIT; i += 1) entry = countDenial({ ...entry, providerInvocation: i });
    expect(entry.contextStatus).toBe('clarification-only');
    const ready = state({ contextStatus: 'ready-pending' });
    expect(countDenial(ready)).toBe(ready);
  });
});

describe('evidence', () => {
  it('keeps the most recent reads first, deduplicated and capped, and stops after the handoff', () => {
    let entry = state();
    for (let i = 0; i < MAX_EVIDENCE_PATHS + 5; i += 1) entry = noteContextRead(entry, `/repo/f${i}.ts`);
    entry = noteContextRead(entry, '/repo/f3.ts');
    expect(entry.readPaths).toHaveLength(MAX_EVIDENCE_PATHS);
    expect(entry.readPaths![0]).toBe('/repo/f3.ts');
    expect(entry.readPaths!.filter((p) => p === '/repo/f3.ts')).toHaveLength(1);
    const handed = acceptContextHandoff(entry, { deliverable: 'plan', key: 'k', reasoning });
    expect(noteContextRead(handed, '/repo/late.ts')).toBe(handed);
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
