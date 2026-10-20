/** Supported explicit source references, normalized without file access. */
import { isAbsolute, posix, relative, sep } from 'node:path';
import { resolveToolPath } from '../policy/execution-contract.js';

const MAX_SCANNED_CHARS = 20_000;
const MAX_REFERENCES = 32;
const MAX_PATH_CHARS = 512;
const AT_MENTION = /(?:^|\s)@([^\s`<>|]+)/gu;

function normalize(raw: string, cwd?: string): string | undefined {
  const cleaned = raw.trim().replace(/^[(\[{<'"]+/u, '').replace(/[.,;:!?)\]}>'"]+$/u, '').replace(/:\d+(?::\d+)?$/u, '');
  if (!cleaned || cleaned.includes('://')) return undefined;
  let path: string;
  if (cwd) {
    path = relative(cwd, resolveToolPath(cwd, cleaned)).split(sep).join('/');
    if (path === '' || isAbsolute(path)) return undefined;
  } else {
    if (cleaned.startsWith('/') || cleaned.startsWith('~')) return undefined;
    path = posix.normalize(cleaned);
  }
  path = path.replace(/^\.\//u, '').replace(/\/+$/u, '');
  if (path === '' || path === '.' || path === '..' || path.startsWith('../') || path.length > MAX_PATH_CHARS) return undefined;
  return path;
}

export function referencedSourcePaths(prompt: string, cwd?: string): string[] {
  const paths = new Set<string>();
  for (const match of prompt.slice(0, MAX_SCANNED_CHARS).matchAll(AT_MENTION)) {
    const path = normalize(match[1]!, cwd);
    if (path) paths.add(path);
    if (paths.size >= MAX_REFERENCES) break;
  }
  return [...paths];
}
