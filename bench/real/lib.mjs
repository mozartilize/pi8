// Shared code of the real-repository bench: source trees, hidden tests, and the guest settings.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultEvalDir } from '../../eval/evidence-store.ts';
import { runCargoTest, testTailOf } from '../../eval/cargo-oracle.ts';
import { runPytest } from '../../eval/pytest-oracle.ts';

export const evalDir = defaultEvalDir();
export const root = join(evalDir, 'real-bench');

/** Per repository: the clone, an optional lock file, and the warm-cache checkpoint of the VM. */
export const REPOS = {
  saleor: { dir: join(root, 'sources', 'saleor'), lang: 'python', image: 'saleor-dev:latest', checkpoint: join(evalDir, 'checkpoints', 'saleor-test.qcow2') },
  tantivy: { lang: 'rust', image: 'rust-dev:latest', dir: join(root, 'sources', 'tantivy'), lockfile: join(root, 'tantivy.Cargo.lock'), checkpoint: join(evalDir, 'checkpoints', 'tantivy-test.qcow2') },
  wealthfolio: { lang: 'rust', image: 'rust-dev:latest', dir: join(root, 'sources', 'wealthfolio'), checkpoint: join(evalDir, 'checkpoints', 'wealthfolio-test.qcow2') },
};

/** The guest of a run: the warm cache, only the crate registry hosts, and a Git that accepts a mounted directory. */
export const CRATE_HOSTS = ['index.crates.io', 'static.crates.io', 'crates.io'];
export const guestEnv = {
  GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*',
};
export const sandboxOptions = (repo, extra = {}) => ({
  image: REPOS[repo].image,
  // A Rust run may fetch the few crates that differ from the cache. A Python run has everything in the image.
  network: REPOS[repo].lang === 'rust' ? { allowedHosts: CRATE_HOSTS } : 'none',
  memory: '4G', cpus: 4, scratchOnDisk: true, checkpoint: REPOS[repo].checkpoint, env: { ...guestEnv, PYTHONDONTWRITEBYTECODE: '1' }, ...extra,
});

export const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });

/** A tree of the source at a revision, with a new Git history of one commit. The fix is not in it. */
export function makeTree(repo, sha, destination) {
  const { dir, lockfile } = REPOS[repo];
  mkdirSync(destination, { recursive: true });
  execFileSync('sh', ['-c', `git -C '${dir}' archive ${sha} | tar -x -C '${destination}'`]);
  if (lockfile && !existsSync(join(destination, 'Cargo.lock'))) copyFileSync(lockfile, join(destination, 'Cargo.lock'));
  const run = (args) => execFileSync('git', ['-C', destination, '-c', 'user.name=bench', '-c', 'user.email=bench@example.invalid', ...args], { stdio: 'ignore' });
  run(['init', '-q', '-b', 'main']);
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'base']);
}

const TEST_PATH = /(^|\/)(tests?|__tests__)\/|(^|\/)tests?\.rs$|_tests?\.rs$/;
const PY_TEST_PATH = /(^|\/)tests?\/|(^|\/)test_[^/]+\.py$|(^|\/)conftest\.py$/;
const show = (dir, sha, path) => { try { return git(dir, ['show', `${sha}:${path}`]); } catch { return undefined; } };

/** The hidden tests of a fix: test files, and the test modules of source files. Everything else is source. */
export function hiddenTestsFor(repo, base, fix) {
  const { dir } = REPOS[repo];
  const changed = git(dir, ['diff', '--name-status', base, fix]).trim().split('\n').filter(Boolean).map((line) => line.split('\t'));
  const hidden = [];
  const source = [];
  const other = [];
  if (REPOS[repo].lang === 'python') {
    for (const [status, path] of changed) {
      if (!path.endsWith('.py') || /(^|\/)migrations\//.test(path)) { other.push(path); continue; }
      if (PY_TEST_PATH.test(path)) { if (status !== 'D') hidden.push({ path, kind: 'file', content: show(dir, fix, path) }); }
      else source.push(path);
    }
    return { hidden, source, other };
  }
  for (const [status, path] of changed) {
    if (!path.endsWith('.rs')) { other.push(path); continue; }
    if (status === 'D') { source.push(path); continue; }
    const fixed = show(dir, fix, path);
    if (TEST_PATH.test(path)) { hidden.push({ path, kind: 'file', content: fixed }); continue; }
    const tail = testTailOf(fixed);
    const baseTail = testTailOf(show(dir, base, path) ?? '');
    if (tail !== undefined && tail !== baseTail) hidden.push({ path, kind: 'rust-tests-to-eof', content: tail });
    // A source file with a test module: the rest of the file is the fix, unless only the module changed.
    const withoutTail = (text) => (testTailOf(text) === undefined ? text : text.slice(0, text.length - testTailOf(text).length));
    if (withoutTail(fixed) !== withoutTail(show(dir, base, path) ?? '')) source.push(path);
  }
  return { hidden, source, other };
}

export const writeJson = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); };
export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

const modulePathOf = (rel) => rel.replace(/\/mod$/, '').replace(/^(lib|main)$/, '').replaceAll('/', '::');

/**
 * The test filter of a hidden library test file. A file that another source file mounts with
 * `#[path = "name.rs"] mod x;` is the module `<that file's module>::x`. Any other file is the module
 * of its own path.
 */
function moduleFilterOf(dir, fixSha, crateDir, rel) {
  const name = `${rel.split('/').at(-1)}.rs`;
  let found;
  try {
    found = git(dir, ['grep', '-n', '-A1', `path = "${name}"`, fixSha, '--', `${crateDir === '.' ? '' : `${crateDir}/`}src`]);
  } catch {
    found = '';
  }
  const lines = found.split('\n');
  for (let i = 0; i < lines.length - 1; i += 1) {
    const declaring = /^[^:]+:(.+?)-?:?\d+[:-]/.exec(lines[i]);
    const file = /^[^:]+:(.+\.rs):\d+:/.exec(lines[i])?.[1];
    const mod = /^[^:]+:.+\.rs-\d+-(?:pub(?:\([^)]*\))? )?mod (\w+);/.exec(lines[i + 1])?.[1];
    void declaring;
    if (file && mod) {
      const within = file.replace(`${crateDir === '.' ? '' : `${crateDir}/`}src/`, '').replace(/\.rs$/, '');
      return `${modulePathOf(within)}::${mod}`.replace(/^::/, '');
    }
  }
  return modulePathOf(rel);
}

const packageNameAt = (dir, sha, crateDir) => /^name\s*=\s*"([^"]+)"/m.exec(git(dir, ['show', `${sha}:${crateDir}/Cargo.toml`]))?.[1];

/**
 * The `cargo test` arguments that run the hidden tests of one package. A library test module
 * gets a filter. An integration test file gets `--test`. A package with both runs the whole
 * library test set, because one filter would also apply to the integration test.
 */
export function cargoArgsFor(repo, fixSha, hidden) {
  const { dir } = REPOS[repo];
  if (REPOS[repo].lang === 'python') return hidden.filter((h) => /(^|\/)test_[^/]+\.py$/.test(h.path)).map((h) => h.path);
  const packages = new Map();
  for (const test of hidden) {
    const match = /^(.*?)\/(src|tests)\/(.+)\.rs$/.exec(test.path) ?? (repo === 'tantivy' && /^(src)\/(.+)\.rs$/.exec(test.path) ? ['', '', 'src', /^src\/(.+)\.rs$/.exec(test.path)[1]] : undefined);
    if (!match) throw new Error(`no package for ${test.path}`);
    const [, crateDir, kind, rel] = match;
    const pkg = packageNameAt(dir, fixSha, crateDir || '.');
    const entry = packages.get(pkg) ?? { lib: new Set(), tests: new Set() };
    if (kind === 'tests') entry.tests.add(rel.split('/')[0]);
    else entry.lib.add(moduleFilterOf(dir, fixSha, crateDir || '.', rel));
    packages.set(pkg, entry);
  }
  if (packages.size !== 1) throw new Error(`the hidden tests span ${packages.size} packages`);
  const [[pkg, { lib, tests }]] = [...packages];
  const args = ['-p', pkg];
  if (lib.size > 0) args.push('--lib');
  for (const name of [...tests].sort()) args.push('--test', name);
  if (lib.size > 0 && tests.size === 0) {
    const list = [...lib];
    let prefix = list[0];
    for (const item of list) while (!item.startsWith(prefix)) prefix = prefix.slice(0, -1);
    const filter = prefix.replace(/:+$/, '');
    if (filter) args.push(filter);
  }
  return args;
}

/** Run the hidden tests of a task in the tree. The result has the same shape for both languages. */
export async function runTests(repo, factory, directory, args, timeoutMs) {
  if (REPOS[repo].lang === 'python') {
    const run = await runPytest(factory, directory, args, timeoutMs);
    const { passed, failed, errors, infrastructureFailed } = run.summary;
    return { passed, failed, broken: errors > 0, infrastructureFailed, timedOut: run.timedOut, tail: run.tail };
  }
  const run = await runCargoTest(factory, directory, args, timeoutMs);
  const { passed, failed, buildFailed, infrastructureFailed } = run.summary;
  return { passed, failed, broken: buildFailed, infrastructureFailed, timedOut: run.timedOut, tail: run.tail };
}
