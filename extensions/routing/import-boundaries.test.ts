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
  const specifiers = [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1]!);
  return specifiers.map((specifier) => specifier.startsWith('.')
    ? relative(root, resolve(join(root, dirname(file)), specifier))
    : specifier);
}

// Each entry lists the feature dependencies of one domain. Shared contracts
// and numerical helpers carry no domain policy. New files require an owner.
const featureDependencies: Record<string, readonly string[]> = {
  'actions.ts': ['state'],
  'benchmark.ts': [],
  'benchmark-output.ts': ['benchmark', 'mapping'],
  'cache.ts': ['actions', 'mapping', 'state'],
  'candidate.ts': ['actions', 'benchmark-output', 'continuity', 'latency', 'mapping', 'model', 'recovery', 'schema', 'spend', 'state', 'task-demand'],
  'continuity.ts': ['actions', 'schema', 'state'],
  'difficulty.ts': ['mapping', 'state'],
  'latency.ts': ['benchmark-output', 'mapping', 'schema'],
  'mapping.ts': [],
  'model.ts': ['actions', 'benchmark', 'mapping', 'schema', 'state', 'task-demand'],
  'recovery.ts': ['actions', 'schema', 'state'],
  'schema.ts': [],
  'spend.ts': ['actions', 'benchmark-output', 'cache', 'mapping', 'schema', 'state'],
  'state.ts': [],
  'task-demand.ts': ['mapping', 'state'],
};
const externalDependencies: Record<string, readonly string[]> = {
  'actions.ts': ['@earendil-works/pi-ai', 'routing/score/scorer.js'],
  'cache.ts': ['@earendil-works/pi-ai', 'routing/score/scorer.js'],
  'candidate.ts': ['types.js', 'routing/score/scorer.js'],
  'benchmark-output.ts': ['types.js'],
  'difficulty.ts': ['types.js', 'routing/policy/entry-routing-state.js'],
  'latency.ts': ['types.js'],
  'model.ts': ['types.js', 'bench/store.js'],
  'schema.ts': ['routing/digest.js'],
  'spend.ts': ['@earendil-works/pi-ai'],
  'state.ts': ['@earendil-works/pi-ai', 'types.js', 'routing/score/scorer.js'],
  'task-demand.ts': ['types.js'],
};

describe('router import boundaries', () => {
  it('each feature domain imports only its declared dependencies', () => {
    for (const file of sources('routing/features')) {
      const name = file.slice('routing/features/'.length);
      expect(featureDependencies, `declare the domain dependencies of ${file}`).toHaveProperty(name);
      const allowed = [
        ...featureDependencies[name]!.map((dependency) => `routing/features/${dependency}.js`),
        ...(externalDependencies[name] ?? []),
      ];
      for (const target of imports(file)) expect(allowed, `${file} imports ${target}`).toContain(target);
    }
  });

  it('feature domains do not import the optimizer, the serving layer or the host', () => {
    for (const file of sources('routing/features')) {
      for (const target of imports(file)) {
        expect(target, `${file} imports ${target}`).not.toMatch(/^(routing\/optimization|serve|host)\//);
      }
    }
  });

  it('the selection orchestrator reaches feature formulas only through candidate evaluation', () => {
    const allowed = ['candidate', 'actions', 'state', 'schema'].map((name) => `routing/features/${name}.js`);
    for (const target of imports('routing/optimization/select.ts').filter((target) => target.startsWith('routing/features/'))) {
      expect(allowed, `routing/optimization/select.ts imports ${target}`).toContain(target);
    }
  });

  it('the numerical optimizer imports only the LP adapter and Node built-ins', () => {
    for (const file of ['routing/optimization/minimax.ts', 'routing/optimization/lp.ts']) {
      for (const target of imports(file)) {
        expect(target, `${file} imports ${target}`).toMatch(/^(routing\/optimization\/(lp|minimax)\.js|node:.*)$/);
      }
    }
  });

  it('the boundary check sees relative imports', () => {
    expect(imports('routing/features/candidate.ts')).toContain('routing/features/spend.js');
  });
});
