/**
 * Unit tests for model self-escalation (M4b).
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestEscalation, applyEscalation, resetEscalation, clearActiveEscalation, appendRouteUpGuidance, ROUTE_UP_INLINE_GUIDANCE, registerRouteUpTool } from './escalation.js';
import { setDecisionLogBase, readRecentEntries } from './decisionlog.js';
import { setDebugPath } from './debuglog.js';
import { setLastServed, setLastDecision, resetRouterSession } from './router-session-state.js';
import { ROUTER_PROVIDER_ID, AUTO_MODEL_ID } from './types.js';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

describe('appendRouteUpGuidance', () => {
  it('appends the guidance to an existing system prompt', () => {
    const out = appendRouteUpGuidance('You are a helpful assistant.');
    expect(out.startsWith('You are a helpful assistant.')).toBe(true);
    expect(out).toContain('[router/auto]');
    expect(out).toContain('route_up');
  });

  it('returns the guidance alone when there is no system prompt', () => {
    expect(appendRouteUpGuidance(undefined)).toBe(ROUTE_UP_INLINE_GUIDANCE);
    expect(appendRouteUpGuidance('')).toBe(ROUTE_UP_INLINE_GUIDANCE);
  });

  it('is idempotent — never double-injects', () => {
    const once = appendRouteUpGuidance('base');
    expect(appendRouteUpGuidance(once)).toBe(once);
  });
});

describe('clearActiveEscalation', () => {
  it('drops a pending override so it never reaches a later turn', () => {
    resetEscalation();
    expect(requestEscalation('review', 'needs depth', 4).ok).toBe(true);

    clearActiveEscalation();

    expect(applyEscalation('gather')).toBeUndefined();
  });

  it('is a no-op when nothing is pending', () => {
    resetEscalation();
    expect(() => clearActiveEscalation()).not.toThrow();
    expect(applyEscalation('gather')).toBeUndefined();
  });

  it('preserves the cooldown so a model cannot immediately re-request', () => {
    resetEscalation();
    expect(requestEscalation('review', 'needs depth', 4).ok).toBe(true);

    clearActiveEscalation();

    // Superseding the active request must not also reset rate limiting.
    const retry = requestEscalation('plan', 'again', 4);
    expect(retry.ok).toBe(false);
    expect(retry.message).toContain('rate-limited');
  });
});

describe('requestEscalation', () => {
  beforeEach(() => {
    resetEscalation();
  });

  it('records the override and decrements TTL', () => {
    const req = requestEscalation('plan', 'needs architecture thinking', 3);
    expect(req.ok).toBe(true);

    const first = applyEscalation('gather');
    expect(first?.dimension).toBe('plan');
    expect(first?.cause).toBe('model-escalation');

    const second = applyEscalation('gather');
    expect(second?.dimension).toBe('plan');

    const third = applyEscalation('gather');
    expect(third?.dimension).toBe('plan');

    // After 3 turns the override is exhausted.
    const fourth = applyEscalation('gather');
    expect(fourth).toBeUndefined();
  });

  it('ignores weaker requests when already escalated higher', () => {
    requestEscalation('plan', 'architecture', 2);
    const req = requestEscalation('implement', 'coding too', 2);
    expect(req.ok).toBe(false);
    const applied = applyEscalation('gather');
    expect(applied?.dimension).toBe('plan');
  });

  it('rejects invalid dimensions', () => {
    const req = requestEscalation('invalid' as any, 'reason', 2);
    expect(req.ok).toBe(false);
  });

  it('rate-limits repeated escalation requests', () => {
    vi.useFakeTimers();
    try {
      expect(requestEscalation('implement', 'first request', 2).ok).toBe(true);
      const repeated = requestEscalation('plan', 'repeat request', 2);
      expect(repeated.ok).toBe(false);
      expect(repeated.message).toMatch(/rate-limited/i);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('applyEscalation', () => {
  beforeEach(() => {
    resetEscalation();
    resetRouterSession();
  });

  it('keeps a model-level escalation actionable at the top dimension', () => {
    setLastServed({ registryId: 'cheap/model', viaFallback: false, accumulatedCost: 0 });
    expect(requestEscalation('plan', 'underpowered', 1).ok).toBe(true);
    expect(applyEscalation('plan')).toMatchObject({
      dimension: 'plan',
      cause: 'capability-escalation',
      fromModel: 'cheap/model',
    });
  });

  it('returns undefined when heuristic already matches or exceeds the request', () => {
    requestEscalation('gather', 'read deeper', 2);
    const applied = applyEscalation('implement');
    expect(applied).toBeUndefined();
  });

  it('expires by absolute TTL', () => {
    vi.useFakeTimers();
    try {
      resetEscalation({ ttlMs: 1 });
      requestEscalation('plan', 'needs design work', 10);
      vi.advanceTimersByTime(2);
      const applied = applyEscalation('gather');
      expect(applied).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('route_up tool execute (notify + debug + decision log)', () => {
  let dir: string;
  let debugFile: string;
  let prevEnv: string | undefined;
  let toolDef: any;
  let notifications: Array<[string, string | undefined]>;

  function mountTool() {
    const pi = { registerTool: (def: unknown) => { toolDef = def; } } as unknown as ExtensionAPI;
    registerRouteUpTool(pi);
  }
  const ctx = () => ({
    model: { provider: ROUTER_PROVIDER_ID, id: AUTO_MODEL_ID },
    ui: { notify: (m: string, t?: string) => notifications.push([m, t]) },
  } as unknown as ExtensionContext);

  beforeEach(() => {
    resetEscalation();
    resetRouterSession();
    dir = mkdtempSync(join(tmpdir(), 'ar-esc-exec-'));
    debugFile = join(dir, 'debug.log');
    prevEnv = process.env.PI8_DIR;
    process.env.PI8_DIR = dir;
    setDecisionLogBase(dir);
    setDebugPath(debugFile);
    notifications = [];
    mountTool();
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.PI8_DIR;
    else process.env.PI8_DIR = prevEnv;
    setDecisionLogBase(undefined);
    setDebugPath(undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it('notifies, debug-logs, and decision-logs an accepted route_up call', async () => {
    setLastServed({ registryId: 'beta/second', viaFallback: false, accumulatedCost: 0 });
    setLastDecision({ dimension: 'gather', chosen: 'beta/second' } as any);

    const res = await toolDef.execute('id1', { dimension: 'plan', reason: 'needs architecture work' }, undefined, undefined, ctx());
    expect(res.details.ok).toBe(true);

    // Notification
    expect(notifications.length).toBe(1);
    expect(notifications[0][0]).toMatch(/route_up → plan/);

    // Debug log
    expect(existsSync(debugFile)).toBe(true);
    expect(readFileSync(debugFile, 'utf8')).toMatch(/escalation\.request.*"ok":true/);

    // Decision log
    const entries = readRecentEntries(10, dir);
    const esc = entries.find((e) => e.reason.startsWith('route_up requested'));
    expect(esc).toBeTruthy();
    expect(esc!.cause).toBe('model-escalation');
    expect(esc!.routedUp).toBe(true);
    expect(esc!.dimension).toBe('plan');
    expect(esc!.served).toBe('beta/second');
    expect(esc!.escalation?.requestedDimension).toBe('plan');
    expect(esc!.escalation?.heuristicDimension).toBe('gather');
  });

  it('logs a same-dimension top-tier request as a capability repick', async () => {
    setLastServed({ registryId: 'beta/second', viaFallback: false, accumulatedCost: 0 });
    setLastDecision({ dimension: 'plan', chosen: 'beta/second' } as any);

    const res = await toolDef.execute(
      'id-top',
      { dimension: 'plan', reason: 'needs a stronger architecture model' },
      undefined,
      undefined,
      ctx(),
    );
    expect(res.details.ok).toBe(true);

    const esc = readRecentEntries(1, dir)[0];
    expect(esc.cause).toBe('capability-escalation');
    expect(esc.routedUp).toBe(false);
    expect(esc.dimension).toBe('plan');
    expect(esc.escalation).toEqual({
      requestedDimension: 'plan',
      heuristicDimension: 'plan',
      reason: 'needs a stronger architecture model',
    });
  });

  it('debug-logs but does not notify or decision-log a rejected (weaker) call', async () => {
    // Already escalated to plan; a weaker request is ignored.
    requestEscalation('plan', 'architecture', 4);
    const res = await toolDef.execute('id2', { dimension: 'gather', reason: 'small lookup' }, undefined, undefined, ctx());
    expect(res.details.ok).toBe(false);

    expect(notifications.length).toBe(0);
    expect(readFileSync(debugFile, 'utf8')).toMatch(/escalation\.request.*"ok":false/);
    const entries = readRecentEntries(10, dir);
    expect(entries.some((e) => e.reason.startsWith('route_up requested'))).toBe(false);
  });

  it('does not notify when prompt is disabled in config', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ prompt: false }), 'utf8');

    const res = await toolDef.execute('id3', { dimension: 'plan', reason: 'deep work' }, undefined, undefined, ctx());
    expect(res.details.ok).toBe(true);
    expect(notifications.length).toBe(0);
    // Still recorded in debug + decision log regardless of the prompt setting.
    expect(readFileSync(debugFile, 'utf8')).toMatch(/escalation\.request.*"ok":true/);
    expect(readRecentEntries(10, dir).some((e) => e.reason.startsWith('route_up requested'))).toBe(true);
  });

  it('declines cleanly with zero side effects when the session model is not router/auto', async () => {
    const nonRouterCtx = {
      model: { provider: 'github-copilot', id: 'gpt-5.4' },
      ui: { notify: (m: string, t?: string) => notifications.push([m, t]) },
    } as unknown as ExtensionContext;

    const res = await toolDef.execute(
      'id-not-active',
      { dimension: 'plan', reason: 'needs architecture work' },
      undefined,
      undefined,
      nonRouterCtx,
    );

    // Declines without accepting the escalation.
    expect(res.details.ok).toBe(false);
    expect(res.content[0].text).toMatch(/not router\/auto/);

    // Zero side effects: no notification, no debug log, no decision log entry,
    // and no global escalation state left behind for a later router/auto turn
    // to pick up.
    expect(notifications.length).toBe(0);
    expect(existsSync(debugFile)).toBe(false);
    expect(readRecentEntries(10, dir)).toHaveLength(0);
    expect(applyEscalation('gather')).toBeUndefined();
  });
});
