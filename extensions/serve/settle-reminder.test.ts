import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempRouterDir } from '../test-support/temp-router-dir.js';
import { createEntryEvidence } from './entry-evidence.js';
import { observeContextGrounding } from './context-grounding.js';
import type { AgentBeforeSettleEvent } from '@earendil-works/pi-coding-agent';
import { appendWorkLifecycleSignal } from '../host/decisionlog.js';
import type { WorkPhaseState } from '../routing/policy/work-phase.js';
import { ROUTER_SETTLE_PREFIX } from '../routing/policy/continuation.js';
import { RouterSession } from './router-session-state.js';
import { CONTEXT_SETTLE_TEXT, logSettleOutcomes, settleReminder } from './settle-reminder.js';

vi.mock('../host/decisionlog.js', () => ({ appendWorkLifecycleSignal: vi.fn(), appendContextHandoffSignal: vi.fn() }));
const logged = vi.mocked(appendWorkLifecycleSignal);
const actions = () => logged.mock.calls.map(([signal]) => [signal.action, signal.reminder]);
beforeEach(() => logged.mockClear());

function ready(over: Partial<WorkPhaseState> = {}): RouterSession {
  const session = new RouterSession();
  session.commitWorkPhaseState({
    intentKey: 'entry', providerInvocation: 1, observedMutationTools: 0,
    status: 'triage', deliverable: 'gather', ...over,
  });
  return session;
}

// Pi checks continuation again after the handlers add their entries.
function settle(
  outcome: AgentBeforeSettleEvent['outcome'] = 'completed',
  entries: AgentBeforeSettleEvent['entries'] = [],
) {
  return { outcome, entries, context: { canContinue: false } } as unknown as
    Pick<AgentBeforeSettleEvent, 'outcome' | 'entries'>;
}

function reminder(result: Awaited<ReturnType<typeof settleReminder>>) {
  const message = result?.entries?.at(-1);
  return message && 'content' in message ? message.content : undefined;
}

describe('settle reminder', () => {
  it('lets a triage answer settle without a handoff or a second selector pass', async () => {
    const session = ready();
    const state = session.getWorkPhaseState();
    expect(await settleReminder(settle(), session)).toBeUndefined();
    expect(session.getWorkPhaseState()).toBe(state);
    expect(logged).not.toHaveBeenCalled();
  });

  it('reminds once after a refused action and retains earlier handlers\' drafts', async () => {
    const draft = { type: 'custom_message', customType: 'other', content: 'x', display: false } as const;
    const session = ready({ contextDenials: 1 });
    const result = await settleReminder(settle('completed', [draft]), session);
    expect(result?.continue).toBe(true);
    expect(result?.entries).toHaveLength(2);
    expect(result?.entries?.[0]).toBe(draft);
    expect(result?.entries?.[1]).toMatchObject({ type: 'custom_message', customType: 'pi8-settle', display: false });
    expect(reminder(result)).toBe(`${ROUTER_SETTLE_PREFIX}\n${CONTEXT_SETTLE_TEXT}`);
    expect(session.getWorkPhaseState()?.contextSettleReminded).toBe(true);
    expect(await settleReminder(settle(), session)).toBeUndefined();
    expect(actions()).toEqual([['settle-reminder', 'context']]);
  });

  it.each(['implement', 'plan', 'review'] as const)('does not require a completion declaration after served %s', async (deliverable) => {
    const session = ready({ status: 'served', deliverable, observedMutationTools: 2,
      contract: { status: 'executed' } as WorkPhaseState['contract'] });
    expect(await settleReminder(settle(), session)).toBeUndefined();
    expect(logged).not.toHaveBeenCalled();
  });

  it('does nothing after an error or an abort', async () => {
    for (const outcome of ['error', 'aborted'] as const) {
      const session = ready({ contextDenials: 1 });
      expect(await settleReminder(settle(outcome), session)).toBeUndefined();
      expect(session.getWorkPhaseState()?.contextSettleReminded).toBeUndefined();
    }
  });
});

describe('source-evidence settlement', () => {
  async function withSource(check: (session: RouterSession, cwd: string) => Promise<void>) {
    const temp = createTempRouterDir();
    try {
      writeFileSync(join(temp.path, 'source.ts'), 'one\ntwo\nthree\nfour');
      const session = ready({ evidence: createEntryEvidence({ key: 'entry', promptText: '@source.ts' }, 0, temp.path),
        sourceEvidencePending: true });
      await check(session, temp.path);
    } finally { temp.cleanup(); }
  }
  const read = (session: RouterSession, cwd: string, text: string, offset?: number) => observeContextGrounding({
    toolName: 'read', input: { path: 'source.ts', ...(offset ? { offset } : {}) }, content: [{ type: 'text', text }],
  } as never, { cwd } as never, session);

  it('repairs an unread or partially read explicit source in the same entry without a handoff', async () => {
    await withSource(async (session, cwd) => {
      const before = session.getWorkPhaseState()!;
      await read(session, cwd, 'one\ntwo', 1);
      const repair = await settleReminder(settle(), session);
      expect(repair?.continue).toBe(true);
      expect(reminder(repair)).toContain('Read the referenced source in full');
      expect(session.getWorkPhaseState()).toMatchObject({ intentKey: before.intentKey, status: 'triage', sourceSettleAttempts: 1 });
      expect(session.getWorkPhaseState()!.evidence).toBe(before.evidence);
      await read(session, cwd, 'three\nfour', 3);
      expect(await settleReminder(settle(), session)).toBeUndefined();
      expect(session.getWorkPhaseState()!.handoffKey).toBeUndefined();
    });
  });

  it('rechecks a satisfied source after an external edit and stops repair after the bounded attempts', async () => {
    await withSource(async (session, cwd) => {
      await read(session, cwd, 'one\ntwo\nthree\nfour');
      expect(await settleReminder(settle(), session)).toBeUndefined();
      writeFileSync(join(cwd, 'source.ts'), 'other');
      expect((await settleReminder(settle(), session))?.continue).toBe(true);
      const exhausted = await settleReminder(settle(), session);
      expect(exhausted?.continue).toBe(true);
      expect(reminder(exhausted)).toContain('Tell the user this limitation');
      expect(session.getWorkPhaseState()).toMatchObject({ status: 'clarification-only', sourceSettleAttempts: 2 });
      expect(await settleReminder(settle(), session)).toBeUndefined();
    });
  });

  it('does not continue after a needs-user declaration even when the source stays pending', async () => {
    await withSource(async (session) => {
      session.commitWorkPhaseState({ ...session.getWorkPhaseState()!, status: 'clarification-only', contextNeedsUser: true });
      expect(await settleReminder(settle(), session)).toBeUndefined();
    });
  });
});

describe('settle outcomes', () => {
  it('records ready and needs-user declarations as followed', () => {
    for (const declared of [{ handoffKey: 'k' }, { contextNeedsUser: true }]) {
      logged.mockClear();
      logSettleOutcomes(ready({ contextSettleReminded: true, ...declared }));
      expect(actions()).toEqual([['settle-followed', 'context']]);
    }
  });

  it('records an ignored reminder once per entry', async () => {
    const session = ready({ status: 'clarification-only', contextSettleReminded: true });
    logSettleOutcomes(session);
    logSettleOutcomes(session);
    expect(actions()).toEqual([['settle-ignored', 'context']]);
  });

  it('logs nothing for an entry without a reminder', () => {
    logSettleOutcomes(ready());
    expect(logged).not.toHaveBeenCalled();
  });
});
