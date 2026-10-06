import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyHiddenTests, cargoTestOracle, summarizeCargoTest, testTailOf } from './cargo-oracle.ts';
import { pytestOracle, summarizePytest } from './pytest-oracle.ts';
import type { SandboxFactory, SecureSandbox } from './sandbox.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pi8-real-oracles-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const put = (path: string, text: string): void => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); };

describe('hidden tests', () => {
  const tests = '#[cfg(test)]\nmod tests {\n    #[test]\n    fn hidden() { assert_eq!(super::two(), 2); }\n}\n';

  it('replaces the test module at the end of a source file, so a test that the candidate wrote cannot remain', () => {
    put('lib.rs', 'pub fn two() -> u32 { 2 }\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn candidate() { assert!(true); }\n}\n');
    applyHiddenTests(dir, [{ path: 'lib.rs', kind: 'rust-tests-to-eof', content: tests }]);
    const text = readFileSync(join(dir, 'lib.rs'), 'utf8');
    expect(text).toContain('fn hidden');
    expect(text).not.toContain('fn candidate');
    expect(text.startsWith('pub fn two()')).toBe(true);
  });

  it('adds the module when the candidate removed it, and writes whole files, and fails when the source file is gone', () => {
    put('lib.rs', 'pub fn two() -> u32 { 2 }\n');
    applyHiddenTests(dir, [{ path: 'lib.rs', kind: 'rust-tests-to-eof', content: tests }, { path: 'tests/new.py', kind: 'file', content: 'x' }]);
    expect(readFileSync(join(dir, 'lib.rs'), 'utf8')).toContain('fn hidden');
    expect(readFileSync(join(dir, 'tests/new.py'), 'utf8')).toBe('x');
    expect(() => applyHiddenTests(dir, [{ path: 'gone.rs', kind: 'rust-tests-to-eof', content: tests }])).toThrow(/missing/);
  });

  it('finds the test module at the end of a source file', () => {
    expect(testTailOf('fn a() {}\n#[cfg(test)]\n#[allow(unused)]\nmod tests {\n}\n')).toContain('mod tests');
    expect(testTailOf('fn a() {}\n')).toBeUndefined();
  });
});

describe('output parsers', () => {
  it('counts cargo results over several test binaries and tells a build failure from an infrastructure failure', () => {
    const ok = 'test result: ok. 5 passed; 0 failed; 0 ignored;\ntest result: FAILED. 2 passed; 1 failed; 0 ignored;';
    expect(summarizeCargoTest(ok)).toMatchObject({ passed: 7, failed: 1, buildFailed: false, infrastructureFailed: false });
    expect(summarizeCargoTest('error[E0425]: cannot find value\nerror: could not compile `x`')).toMatchObject({ buildFailed: true, infrastructureFailed: false });
    expect(summarizeCargoTest('error: failed to download `x`\nerror: could not compile')).toMatchObject({ buildFailed: false, infrastructureFailed: true });
  });

  it('reads the last pytest summary line, and counts errors apart from failures', () => {
    expect(summarizePytest('...\n2 failed, 13 passed, 1 warning in 3.2s')).toMatchObject({ passed: 13, failed: 2, errors: 0 });
    expect(summarizePytest('ERROR a\n1 warning, 4 errors in 2.7s')).toMatchObject({ passed: 0, failed: 0, errors: 4 });
    expect(summarizePytest('psycopg.OperationalError: connection refused\n1 error in 1s').infrastructureFailed).toBe(true);
  });
});

describe('oracle verdicts', () => {
  const fakeFactory = (output: string, timedOut = false): SandboxFactory & { identity: string } => Object.assign(
    async () => ({ kind: 'vm-isolated', run: async () => ({ code: 0, signal: null, stdout: output, stderr: '', timedOut }), destroy: async () => {} }) as unknown as SecureSandbox,
    { identity: 'fake' },
  );
  const artifact = () => { put('a/x.txt', 'x'); return { digest: 'd', path: join(dir, 'a'), regradeable: true, stateKinds: [] as never[] }; };
  const cargo = (output: string, minPassed = 1, timedOut = false) => cargoTestOracle({ taskId: 't', oracleVersion: 'v', hidden: [], cargoArgs: [], minPassed, runIn: fakeFactory(output, timedOut) });
  const python = (output: string, minPassed = 1) => pytestOracle({ taskId: 't', oracleVersion: 'v', hidden: [], pytestArgs: [], minPassed, runIn: fakeFactory(output) });

  it('passes only when no test fails and enough tests ran', async () => {
    expect((await cargo('test result: ok. 3 passed; 0 failed;').evaluate(artifact())).verdict).toBe('pass');
    expect((await cargo('test result: ok. 3 passed; 0 failed;', 4).evaluate(artifact())).verdict).toBe('fail');
    expect((await cargo('test result: FAILED. 2 passed; 1 failed;').evaluate(artifact())).verdict).toBe('fail');
    expect((await python('3 passed in 1s').evaluate(artifact())).verdict).toBe('pass');
    expect((await python('1 failed, 2 passed in 1s').evaluate(artifact())).verdict).toBe('fail');
  });

  it('counts a build error or an import error as a failed solution, and an infrastructure failure or no result as an error', async () => {
    expect((await cargo('error[E0308]: mismatched\nerror: could not compile').evaluate(artifact())).verdict).toBe('fail');
    expect((await python('1 warning, 2 errors in 1s').evaluate(artifact())).verdict).toBe('fail');
    expect((await cargo('error: failed to download crate').evaluate(artifact())).verdict).toBe('error');
    expect((await cargo('nothing').evaluate(artifact())).verdict).toBe('error');
    expect((await cargo('test result: ok. 3 passed; 0 failed;', 1, true).evaluate(artifact())).verdict).toBe('error');
  });
});
