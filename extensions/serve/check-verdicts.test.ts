import { describe, expect, it } from 'vitest';
import type { WorkPhaseState } from '../routing/policy/work-phase.js';
import { factsLog } from '../routing/policy/change-facts.js';
import { routingDecision } from '../test-support/router-fixtures.js';
import { checkVerdict, observeCheckVerdict } from './check-verdicts.js';
import { RouterSession } from './router-session-state.js';

const shell = (command: string, text: string, isError = false) => ({
  toolName: 'bash', toolCallId: 'c', input: { command }, content: [{ type: 'text', text }], isError,
});

describe('checkVerdict', () => {
  it('reads a verifier run as pass, fail, or timeout', () => {
    expect(checkVerdict(shell('npm test', '# pass 17\n# fail 0'), 1)).toBe('pass');
    expect(checkVerdict(shell('npm test', 'not ok 3 - cancel frees its slot', true), 1)).toBe('fail');
    // A reported failure counts even when the command exits 0.
    expect(checkVerdict(shell('npx vitest run', 'Tests  1 failed | 4 passed'), 1)).toBe('fail');
    expect(checkVerdict(shell('npm test', 'ok 1\n\nCommand timed out after 60 seconds', true), 1)).toBe('timeout');
  });

  it('ignores a result that is not a verifier run', () => {
    expect(checkVerdict(shell('ls src', 'queue.ts'), 1)).toBeUndefined();
    expect(checkVerdict({ toolName: 'read', toolCallId: 'r', input: { path: 'a.ts' }, content: [] }, 1)).toBeUndefined();
  });
});

describe('observeCheckVerdict', () => {
  function entrySession(state: Partial<WorkPhaseState> = {}): RouterSession {
    const session = new RouterSession();
    session.commitWorkPhaseState({ intentKey: 'entry', providerInvocation: 1, observedMutationTools: 0, ...state });
    session.setLastDecision({ ...routingDecision(['a/model']), intentKey: 'entry' });
    return session;
  }

  it('keeps the last verdict before the handoff and counts the runs after it', () => {
    const session = entrySession();
    observeCheckVerdict(shell('npm test', 'fail', true), session);
    observeCheckVerdict(shell('npm test', 'ok'), session);
    expect(session.getWorkPhaseState()?.checkVerdicts).toEqual({ beforeHandoff: 'pass', runsAfterHandoff: 0 });
    session.commitWorkPhaseState({ ...session.getWorkPhaseState()!, changeFacts: { log: factsLog('implement', undefined, {}) } });
    observeCheckVerdict(shell('npm test', 'not ok', true), session);
    observeCheckVerdict(shell('npm test', 'ok 1\nCommand timed out after 30 seconds', true), session);
    expect(session.getWorkPhaseState()?.checkVerdicts).toEqual({ beforeHandoff: 'pass', afterHandoff: 'timeout', runsAfterHandoff: 2 });
  });

  it('records nothing for an entry that the last decision does not serve', () => {
    const session = entrySession();
    session.setLastDecision({ ...routingDecision(['a/model']), intentKey: 'other' });
    observeCheckVerdict(shell('npm test', 'ok'), session);
    expect(session.getWorkPhaseState()?.checkVerdicts).toBeUndefined();
  });
});
