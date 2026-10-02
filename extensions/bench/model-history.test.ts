import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendModelEvent, compliancePenalties, loadModelHistory, modelEntryId, reputationKey, sharedPrefixCredits } from './model-history.js';
import { createTempRouterDir } from '../test-support/temp-router-dir.js';
import { modelEventSession, resetModelEventSession, setDecisionLogBase } from '../host/decisionlog.js';
import { setSessionFile } from '../sessionpaths.js';

function withTempRouterDir(run: (dir: string) => void): void {
  const tmp = createTempRouterDir();
  try { run(tmp.path); } finally { tmp.cleanup(); }
}

const now = 2_000_000_000_000;
function collectedForTwoWeeks(): void {
  vi.mocked(Date.now).mockReturnValue(now - 14 * 86_400_000);
  appendModelEvent({ kind: 'served', model: 'p/seed', entry: modelEntryId('s', 'seed') });
  vi.mocked(Date.now).mockReturnValue(now);
}
const prefix = 'a'.repeat(64);
describe('global model history', () => {
  beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(now); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('uses distinct entry namespaces for ephemeral sessions sharing one log', () => {
    setDecisionLogBase(undefined);
    setSessionFile(undefined);
    const first = modelEventSession();
    resetModelEventSession();
    const second = modelEventSession();
    expect(first).not.toBe(second);
    expect(modelEntryId(first, 'same request')).not.toBe(modelEntryId(second, 'same request'));
  });

  it('collects one entry across retries and keeps providers together for compliance', () => withTempRouterDir((dir) => {
    const entry = modelEntryId('session', 'request');
    for (const model of ['p/claude-opus-4.8:high', 'q/claude-opus-4-8:max']) {
      appendModelEvent({ kind: 'served', model, entry });
      appendModelEvent({ kind: 'reminder', model, entry, reminder: 'completion' });
      appendModelEvent({ kind: 'ignored', model, entry, reminder: 'completion' });
    }
    const stats = loadModelHistory().stats.get(reputationKey('p/claude-opus-4.8'))!;
    expect(stats).toEqual({ entries: 1, remindedEntries: 1, reminders: 1, followed: 0, ignored: 1 });
    const text = readFileSync(join(dir, 'model-events.jsonl'), 'utf8');
    expect(text).not.toContain('request');
    expect(text).not.toContain(dir);
  }));

  it('does not blame the original model when another model receives the continuation', () => withTempRouterDir(() => {
    const entry = modelEntryId('s', 'e');
    appendModelEvent({ kind: 'reminder', model: 'p/a', entry, reminder: 'context' });
    appendModelEvent({ kind: 'ignored', model: 'p/b', entry, reminder: 'context' });
    expect(loadModelHistory().stats.get('a')?.ignored).toBe(0);
    expect(loadModelHistory().stats.get('b')?.ignored).toBe(0);
  }));

  it('keeps unanswered or interrupted reminder episodes out of the ignore denominator', () => withTempRouterDir(() => {
    collectedForTwoWeeks();
    for (let i = 0; i < 30; i++) {
      const entry = modelEntryId('s', String(i));
      appendModelEvent({ kind: 'served', model: 'p/a', entry });
      appendModelEvent({ kind: 'reminder', model: 'p/a', entry, reminder: 'completion' });
    }
    const history = loadModelHistory();
    expect(compliancePenalties(history, undefined, 0.15).size).toBe(0);
    expect(compliancePenalties(history, { reminder: 0, ignored: 1 }, 0.15).get('a')).toBe(0);
  }));

  it('needs enough measured outcomes and caps penalties even with many ignored reminders', () => withTempRouterDir(() => {
    collectedForTwoWeeks();
    for (let i = 0; i < 35; i++) {
      const entry = modelEntryId('s', String(i));
      appendModelEvent({ kind: 'served', model: 'p/a', entry });
      appendModelEvent({ kind: 'reminder', model: 'p/a', entry, reminder: 'completion' });
      appendModelEvent({ kind: 'ignored', model: 'p/a', entry, reminder: 'completion' });
      if (i === 8) expect(compliancePenalties(loadModelHistory(), { reminder: 0.1, ignored: 0.3 }, 0.15).get('a')).toBe(0);
    }
    expect(compliancePenalties(loadModelHistory(), { reminder: 0.1, ignored: 0.3 }, 0.15).get('a')).toBe(0.15);
  }));

  it('keeps global preferences inactive during the first two weeks', () => withTempRouterDir(() => {
    for (let i = 0; i < 35; i++) {
      const entry = modelEntryId('s', String(i));
      appendModelEvent({ kind: 'served', model: 'p/a:high', entry, session: 'other', prefix, prefixTokens: 2000 });
      appendModelEvent({ kind: 'reminder', model: 'p/a:high', entry, reminder: 'context' });
      appendModelEvent({ kind: 'ignored', model: 'p/a:high', entry, reminder: 'context' });
    }
    const history = loadModelHistory();
    expect(compliancePenalties(history, { reminder: 1, ignored: 1 }, 0.15).size).toBe(0);
    expect(sharedPrefixCredits(history, prefix, 1000, 'own').size).toBe(0);
  }));

  it('decays counts, ignores obsolete rules and old or malformed records', () => withTempRouterDir((dir) => {
    const base = { kind: 'served', model: 'p/a', entry: modelEntryId('s', 'e'), version: 1 };
    const records = [
      { ...base, at: now - 30 * 86_400_000 },
      { ...base, entry: modelEntryId('s', 'old'), at: now - 91 * 86_400_000 },
      { ...base, entry: modelEntryId('s', 'other-rule'), version: 0, at: now },
    ];
    writeFileSync(join(dir, 'model-events.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n{broken');
    expect(loadModelHistory().stats.get('a')?.entries).toBe(0.5);
  }));

  it('credits only a recent identical prompt head from another session at the same provider and effort', () => withTempRouterDir(() => {
    collectedForTwoWeeks();
    appendModelEvent({ kind: 'served', model: 'p/a:high', entry: modelEntryId('other', 'e'), session: 'other', prefix, prefixTokens: 2000 });
    const history = loadModelHistory();
    expect(sharedPrefixCredits(history, prefix, 1000, 'own', now).get('p/a:high')).toBe(400);
    expect(sharedPrefixCredits(history, prefix, 1000, 'own', now + 600_000).get('p/a:high')).toBe(300);
    expect(sharedPrefixCredits(history, prefix, 1000, 'own', now + 3_600_001).size).toBe(0);
    expect(sharedPrefixCredits(history, 'b'.repeat(64), 1000, 'own').size).toBe(0);
    expect(sharedPrefixCredits(history, prefix, 1000, 'other').size).toBe(0);
    expect(sharedPrefixCredits(history, prefix, 1000, 'own').has('q/a:high')).toBe(false);
    appendModelEvent({ kind: 'served', model: 'p/no-owner:high', entry: modelEntryId('s', 'unowned'), prefix, prefixTokens: 2000 });
    expect(sharedPrefixCredits(loadModelHistory(), prefix, 1000, 'own').has('p/no-owner:high')).toBe(false);
  }));

  it('ignores incomplete writes without losing complete records', () => withTempRouterDir((dir) => {
    appendModelEvent({ kind: 'served', model: 'p/a', entry: modelEntryId('s', 'e') });
    appendFileSync(join(dir, 'model-events.jsonl'), '{');
    expect(loadModelHistory().stats.get('a')?.entries).toBe(1);
  }));

  it('fails open on an unwritable path', () => withTempRouterDir((dir) => {
    const blocker = join(dir, 'blocker'); writeFileSync(blocker, 'file');
    expect(() => appendModelEvent({ kind: 'served', model: 'p/a', entry: modelEntryId('s', 'e') }, join(blocker, 'sub'))).not.toThrow();
    expect(loadModelHistory(join(blocker, 'sub')).stats.size).toBe(0);
  }));
});
