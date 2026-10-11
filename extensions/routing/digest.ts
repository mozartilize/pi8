import { createHash } from 'node:crypto';

/**
 * JSON with object keys sorted at every depth, so two equal values give the
 * same text regardless of property order. `undefined` object fields are
 * omitted, as `JSON.stringify` omits them.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

export const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex');

/** sha256 of the canonical JSON of a value. */
export const digestOf = (value: unknown): string => sha256Hex(canonicalJson(value));
