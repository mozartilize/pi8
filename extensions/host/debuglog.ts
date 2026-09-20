/**
 * Lightweight, opt-in debug log with millisecond timing.
 *
 * A TUI owns stdout, so `console.log` is unsafe for extensions — it corrupts
 * the rendered screen. Writing to our own file is the reliable channel (pi
 * itself does the same with ~/.pi/agent/pi-debug.log). This exists to answer
 * "where did the turn's time actually go?" with evidence instead of guesses.
 *
 * OFF by default. Enable via the `debug` key in ~/.pi/agent/pi8/config.json:
 *   config.json { "debug": true }         → per-session log
 *   config.json { "debug": "/path…" }     → that explicit file
 *
 * Tail it live while reproducing:
 *   tail -f <session-dir>/<session>.router-debug.log
 */
import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

import { sessionSidecarPath } from '../sessionpaths.js';

export const DEFAULT_DEBUG_PATH = '/tmp/pi8-debug.log';
/** Sidecar suffix used when writing next to a persisted session file. */
export const DEBUG_SIDECAR_SUFFIX = 'router-debug.log';

/**
 * Explicit path override (tests / forced location). `undefined` = fall through
 * to env + config + session resolution, `null` = forced off, string = forced path.
 */
let explicitPath: string | null | undefined;

/**
 * Value of the `debug` config key, pushed in by the extension at session_start
 * (debuglog stays decoupled from config.ts and avoids per-call file reads).
 */
let configDebug: boolean | string | undefined;

/** Set the config-derived debug setting. Called from the extension. */
export function setConfigDebug(value: boolean | string | undefined): void {
  configDebug = value;
}

type Directive = { mode: 'off' } | { mode: 'on' } | { mode: 'path'; path: string };

/** Normalize a raw env/config value into an on/off/path directive. */
function normalize(raw: string | boolean | undefined): Directive {
  if (raw === undefined || raw === false || raw === '') return { mode: 'off' };
  if (raw === true) return { mode: 'on' };
  const s = String(raw);
  if (s === '0' || s.toLowerCase() === 'false') return { mode: 'off' };
  if (s === '1' || s.toLowerCase() === 'true') return { mode: 'on' };
  return { mode: 'path', path: s };
}

/**
 * Resolve the debug log path (or null when disabled). Recomputed per call
 * — NOT cached — because the session file changes across new/resume/fork.
 *
 * Priority: explicit override (test seam) → config `debug`. A bare "on"
 * (config `true`) lands in the current session's directory when one exists,
 * else the shared /tmp default.
 */
function debugPath(): string | null {
  if (explicitPath === null) return null;
  if (typeof explicitPath === 'string') return explicitPath;

  const directive = normalize(configDebug);

  if (directive.mode === 'off') return null;
  if (directive.mode === 'path') return directive.path;
  return sessionSidecarPath(DEBUG_SIDECAR_SUFFIX) ?? DEFAULT_DEBUG_PATH;
}

export function debugLog(message: string, data?: Record<string, unknown>): void {
  const path = debugPath();
  if (!path) return;
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const suffix = data ? ' ' + JSON.stringify(data) : '';
    appendFileSync(path, `${new Date().toISOString()} ${message}${suffix}\n`, 'utf8');
  } catch {
    // best-effort
  }
}

/** Monotonic-ish elapsed helper. Returns a function giving ms since creation. */
export function startTimer(): () => number {
  const t0 = Date.now();
  return () => Date.now() - t0;
}

/**
 * Test/runtime seam. Pass a path/null to force, or `undefined` to fall back to
 * env + session resolution on next use.
 */
export function setDebugPath(path?: string | null): void {
  explicitPath = path;
}
