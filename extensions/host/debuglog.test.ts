/**
 * Debug logger tests. Verify it is off by default, writes timestamped lines
 * when enabled, and never throws.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { debugLog, setDebugPath, startTimer, DEFAULT_DEBUG_PATH, setConfigDebug } from './debuglog.js';

/** True when a log line lands on the default path under the current config. */
const probeLog = (): boolean => {
  rmSync(DEFAULT_DEBUG_PATH, { force: true });
  debugLog('probe', {});
  return existsSync(DEFAULT_DEBUG_PATH);
};

afterEach(() => {
  setDebugPath(undefined);
  setConfigDebug(undefined);
  rmSync(DEFAULT_DEBUG_PATH, { force: true });
});

describe('debuglog', () => {
  it('is disabled unless configured', () => {
    setDebugPath(null);
    // A disabled log is a no-op: nothing written, and it must not throw.
    expect(() => debugLog('nope', { a: 1 })).not.toThrow();
    expect(probeLog()).toBe(false);
  });

  it('writes timestamped lines with JSON payload when enabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ar-dbg-'));
    const path = join(dir, 'debug.log');
    try {
      setDebugPath(path);
      debugLog('turn.start', { registryModels: 35 });
      debugLog('attempt.auth', { candidate: 'github-copilot/x', ms: 12, outcome: 'ok' });
      const lines = readFileSync(path, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(2);
      // ISO timestamp prefix.
      expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z turn\.start \{"registryModels":35\}$/);
      expect(lines[1]).toContain('"candidate":"github-copilot/x"');
      expect(lines[1]).toContain('"outcome":"ok"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Expected behavior change: the PI_AUTO_ROUTER_DEBUG env var was removed —
  // the `debug` config key is now the only enable switch (see debuglog.ts).
  it('config `debug: true` resolves to the default /tmp path', () => {
    setDebugPath(undefined);
    setConfigDebug(true);
    expect(DEFAULT_DEBUG_PATH).toBe('/tmp/pi8-debug.log');
    expect(probeLog()).toBe(true);
  });

  it('startTimer returns elapsed milliseconds', async () => {
    const t = startTimer();
    await new Promise((r) => setTimeout(r, 10));
    expect(t()).toBeGreaterThanOrEqual(8);
  });

  it('is enabled by config `debug: true`', () => {
    setDebugPath(undefined);
    setConfigDebug(true);
    expect(probeLog()).toBe(true);
  });

  it('config `debug: false` keeps it disabled', () => {
    setDebugPath(undefined);
    setConfigDebug(false);
    expect(probeLog()).toBe(false);
  });

  it('config `debug: "/path"` writes to that explicit file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ar-dbg-'));
    const path = join(dir, 'cfg.log');
    try {
      setDebugPath(undefined);
      setConfigDebug(path);
      debugLog('from-config', { a: 1 });
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, 'utf8')).toContain('from-config');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates missing parent directories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ar-dbg-'));
    const path = join(dir, 'nested', 'deep', 'debug.log');
    try {
      setDebugPath(path);
      debugLog('x', {});
      expect(existsSync(path)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
