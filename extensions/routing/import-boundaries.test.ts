import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Module boundaries of the router. Each rule names the modules a file may
 * import, so a dependency that crosses a boundary fails here before it can
 * couple two domains.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const sources = (dir: string): string[] =>
  readdirSync(join(root, dir))
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => join(dir, name));

/** Every module specifier of a source file, resolved against `extensions/` when relative. */
function imports(file: string): string[] {
  const text = readFileSync(join(root, file), 'utf8');
  const specifiers = [...text.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)].map((match) => match[1]!);
  return specifiers.map((specifier) => specifier.startsWith('.')
    ? relative(root, resolve(join(root, dirname(file)), specifier))
    : specifier);
}

describe('router import boundaries', () => {
  it('feature domains do not import the optimizer, the serving layer or the host', () => {
    for (const file of sources('routing/features')) {
      for (const target of imports(file)) {
        expect(target, `${file} imports ${target}`).not.toMatch(/^(routing\/optimization|serve|host)\//);
      }
    }
  });

  it('the boundary check sees relative imports', () => {
    expect(imports('routing/features/candidate.ts')).toContain('routing/features/economics.js');
  });
});
