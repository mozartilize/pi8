/**
 * Per-session log path resolution tests.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { setSessionFile, getSessionFile, sessionSidecarPath } from './sessionpaths.js';
import { appendDecision } from './decisionlog.js';
import { setDecisionLogBase } from './decisionlog.js';
import { debugLog, setDebugPath, setConfigDebug } from './debuglog.js';
import type { RoutingDecision } from './types.js';

afterEach(() => {
  setSessionFile(undefined);
  setDecisionLogBase(undefined);
  setDebugPath(undefined);
  setConfigDebug(undefined);
});

describe('sessionpaths', () => {
  it('round-trips the session file', () => {
    setSessionFile('/x/y/2026_abc.jsonl');
    expect(getSessionFile()).toBe('/x/y/2026_abc.jsonl');
  });

  it('treats empty string as no session', () => {
    setSessionFile('');
    expect(getSessionFile()).toBeUndefined();
    expect(sessionSidecarPath('router-debug.log')).toBeUndefined();
  });

  it('swaps the .jsonl extension for the sidecar suffix', () => {
    setSessionFile('/s/dir/2026-08-01T04-30-00_abc123.jsonl');
    expect(sessionSidecarPath('router-decisions.jsonl')).toBe(
      '/s/dir/2026-08-01T04-30-00_abc123.router-decisions.jsonl',
    );
    expect(sessionSidecarPath('router-debug.log')).toBe(
      '/s/dir/2026-08-01T04-30-00_abc123.router-debug.log',
    );
  });

  it('returns undefined when no session file is set', () => {
    setSessionFile(undefined);
    expect(sessionSidecarPath('router-debug.log')).toBeUndefined();
  });
});

const DECISION: RoutingDecision = {
  dimension: 'gather',
  chosen: 'a/b',
  reason: 'x',
  confidence: 1,
  routedUp: false,
  routedDown: false,
  cause: 'heuristic',
  fallbackChain: ['a/b'],
};

describe('per-session log routing', () => {
  it('decision log writes a sidecar next to the session file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ar-sess-'));
    try {
      const sessionFile = join(dir, '2026-08-01T04-30-00_abc123.jsonl');
      setSessionFile(sessionFile);
      appendDecision(DECISION, { registryId: 'a/b', viaFallback: false, accumulatedCost: 0 });
      const sidecar = join(dir, '2026-08-01T04-30-00_abc123.router-decisions.jsonl');
      expect(existsSync(sidecar)).toBe(true);
      expect(readFileSync(sidecar, 'utf8')).toContain('"served":"a/b"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Expected behavior change: the PI_AUTO_ROUTER_DEBUG env var was removed —
  // the `debug` config key is now the only enable switch (see debuglog.ts).
  it('debug log (config `debug: true`) writes into the session dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ar-sess-'));
    try {
      const sessionFile = join(dir, '2026-08-01T04-30-00_abc123.jsonl');
      setSessionFile(sessionFile);
      setConfigDebug(true);
      setDebugPath(undefined); // fall through to config + session resolution
      debugLog('turn.start', { registryModels: 3 });
      const sidecar = join(dir, '2026-08-01T04-30-00_abc123.router-debug.log');
      expect(existsSync(sidecar)).toBe(true);
      expect(readFileSync(sidecar, 'utf8')).toContain('turn.start');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('config `debug: "<path>"` writes to the explicit file, not the session sidecar', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ar-sess-'));
    try {
      const explicit = join(dir, 'explicit.log');
      setSessionFile(join(dir, 'sess_abc.jsonl'));
      setConfigDebug(explicit);
      setDebugPath(undefined);
      debugLog('x', {});
      expect(existsSync(explicit)).toBe(true);
      expect(existsSync(join(dir, 'sess_abc.router-debug.log'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
