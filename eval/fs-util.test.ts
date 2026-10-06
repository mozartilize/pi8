import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyTreeSafely } from './fs-util.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pi8-fsutil-test-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('copyTreeSafely', () => {
  it('keeps files and links inside the tree, and drops other entries', () => {
    const source = join(dir, 'source');
    mkdirSync(join(source, 'a', 'b'), { recursive: true });
    mkdirSync(join(source, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(source, 'a', 'file.txt'), 'content');
    symlinkSync('file.txt', join(source, 'a', 'inside'));
    symlinkSync('../a/file.txt', join(source, 'a', 'b', 'up-inside'));
    symlinkSync('/etc/passwd', join(source, 'absolute'));
    symlinkSync('../../outside', join(source, 'a', 'escape'));
    symlinkSync('..', join(source, 'a', 'parent'));
    execFileSync('mkfifo', [join(source, 'pipe')]);
    const destination = join(dir, 'destination');
    const { dropped } = copyTreeSafely(source, destination, ['node_modules']);
    expect(readFileSync(join(destination, 'a', 'file.txt'), 'utf8')).toBe('content');
    expect(readlinkSync(join(destination, 'a', 'inside'))).toBe('file.txt');
    expect(readlinkSync(join(destination, 'a', 'b', 'up-inside'))).toBe('../a/file.txt');
    // A link to the tree root stays inside the tree.
    expect(readlinkSync(join(destination, 'a', 'parent'))).toBe('..');
    expect(dropped.sort()).toEqual(['a/escape', 'absolute', 'pipe']);
    expect(() => lstatSync(join(destination, 'node_modules'))).toThrow();
  });
});
