import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

/**
 * Vitest setup file: every test file starts with `PI8_DIR` pointing at its
 * own temp directory, so a test that forgets the seam writes there and not
 * into the user's real ~/.pi/agent/pi8/ (decision log, store, config).
 */
const dir = mkdtempSync(join(tmpdir(), 'pi8-suite-'));
process.env.PI8_DIR = dir;

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
