import { describe, it, expect } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempRouterDir } from './temp-router-dir.js';

describe('createTempRouterDir', () => {
  it('restores PI8_DIR and deletes its directory', () => {
    const before = process.env.PI8_DIR;
    const temp = createTempRouterDir();
    expect(process.env.PI8_DIR).toBe(temp.path);
    writeFileSync(join(temp.path, 'config.json'), '{}');
    temp.cleanup();
    expect(existsSync(temp.path)).toBe(false);
    expect(process.env.PI8_DIR).toBe(before);
  });
});
