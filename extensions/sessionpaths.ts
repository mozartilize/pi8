/**
 * Per-session log path resolution.
 *
 * Pi persists each session to `<sessionDir>/<timestamp>_<sessionId>.jsonl`
 * (via `ctx.sessionManager.getSessionFile()`). We write our decision and debug
 * logs as *sidecars* next to that file so each session gets its own logs and
 * they are trivial to correlate with the transcript:
 *
 *   <dir>/2026-08-01T04-30-00_abc123.jsonl                 ← pi session
 *   <dir>/2026-08-01T04-30-00_abc123.router-decisions.jsonl ← our decisions
 *   <dir>/2026-08-01T04-30-00_abc123.router-debug.log       ← our debug log
 *
 * The extension sets the current session file on session_start / turn_start.
 * When there is no persisted session (ephemeral), sidecar resolution returns
 * undefined and callers fall back to the shared ~/.pi/agent/pi8 store.
 */

let currentSessionFile: string | undefined;

/**
 * Record the active session's file path. Called from the extension with
 * `ctx.sessionManager.getSessionFile()`; pass undefined for ephemeral sessions.
 */
export function setSessionFile(file: string | undefined): void {
  currentSessionFile = file || undefined;
}

export function getSessionFile(): string | undefined {
  return currentSessionFile;
}

/**
 * Derive a sidecar path next to the current session file by swapping the
 * `.jsonl` extension for `.<suffix>`. Returns undefined when no session file is
 * set (ephemeral session) so callers can fall back to a shared location.
 */
export function sessionSidecarPath(suffix: string): string | undefined {
  if (!currentSessionFile) return undefined;
  const base = currentSessionFile.replace(/\.jsonl$/i, '');
  return `${base}.${suffix}`;
}
