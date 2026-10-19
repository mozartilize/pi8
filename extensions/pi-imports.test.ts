import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Pi's non-bundled extension loader (used by hosts that embed Pi, such as
 * pi-web) maps Pi packages through jiti aliases. An alias also matches as a
 * prefix, so `@earendil-works/pi-ai/utils/x` resolves to
 * `.../pi-ai/dist/compat.js/utils/x` and the extension fails to load. Source
 * files must import Pi packages only through the specifiers below.
 */
const ALIASED_PI_SPECIFIERS = new Set([
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-tui',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-ai/compat',
  '@earendil-works/pi-ai/oauth',
  '@earendil-works/pi-ai/providers/all',
]);

const root = dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'test-support' ? [] : sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('Pi package imports', () => {
  it('every Pi package specifier is one that the extension loader aliases', () => {
    const files = [...sourceFiles(root), join(root, '..', 'index.ts')];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/(?:from|import)\s*\(?\s*['"](@(?:earendil-works|mariozechner)\/[^'"]+)['"]/g)) {
        expect(ALIASED_PI_SPECIFIERS, `${relative(root, file)} imports ${match[1]}`).toContain(match[1]);
      }
    }
  });
});
