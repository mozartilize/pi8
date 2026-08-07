import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Isolate one test from the user's real `~/.pi/agent/pi8/` directory:
 * point `PI8_DIR` at a fresh temp directory and return a
 * `cleanup()` that removes it and restores the previous env value.
 */
export function createTempRouterDir(): { path: string; cleanup(): void } {
  const previous = process.env.PI8_DIR;
  const path = mkdtempSync(join(tmpdir(), 'pi8-test-'));
  process.env.PI8_DIR = path;
  return {
    path,
    cleanup() {
      if (previous === undefined) delete process.env.PI8_DIR;
      else process.env.PI8_DIR = previous;
      rmSync(path, { recursive: true, force: true });
    },
  };
}
