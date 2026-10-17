/** Writes the preference profile into config.json as a user edit does. */
import { existsSync, readFileSync } from 'node:fs';
import { getConfigPath } from '../config.js';
import { writeJsonAtomic } from '../json-file.js';

/** Set `preferences` in config.json under `PI8_DIR`. Other keys stay. */
export function writeStoredPreferences(profile: unknown): void {
  const path = getConfigPath();
  const current = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> : {};
  writeJsonAtomic(path, { ...current, preferences: profile });
}
