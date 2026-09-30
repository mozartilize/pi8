/**
 * Extension runtime config loading. In v1 we keep this minimal: read config from
 * ~/.pi/agent/pi8/config.json when present, otherwise use defaults.
 */
import { join } from 'node:path';
import type { AutoRouterConfig, Dimension, ScoreWeights } from './types.js';
import {
  CONFIG_FILE,
  DEFAULT_DIMENSION_WEIGHTS,
  DEFAULT_LOW_CONFIDENCE_THRESHOLD,
  DEFAULT_SWITCH_MARGIN,
} from './constants.js';
import { resolveStoragePath } from './bench/store.js';
import { readJsonCached, writeJsonAtomic } from './json-file.js';

export function getConfigPath(): string {
  return join(resolveStoragePath(), CONFIG_FILE);
}

export interface PersistedConfig {
  artificialAnalysisApiKey?: string;
  sources?: string[];
  dimensionWeights?: Partial<Record<Dimension, { quality: number; cost: number; speed: number }>>;
  switchMargin?: number;
  /**
   * Counterfactual baseline for `/router-report`, as `provider/id`. Absent
   * means the router auto-picks the strongest routable candidate per turn.
   */
  baselineModel?: string;
  /**
   * Advertise this context window for `router/auto` instead of the largest
   * routable model's. A smaller value makes Pi compact earlier, keeping
   * smaller-window (often cheaper) models eligible for longer. Absent =
   * largest routable window.
   */
  routerContextWindow?: number;
  lowConfidenceThreshold?: number;
  /**
   * Show a TUI notification when the router picks a model for a turn or
   * switches models between turns. Default true. Set false to route silently
   * (the footer status widget still updates regardless).
   */
  prompt?: boolean;
  /**
   * Semi-automatic mode: ask before switching away from the previously-served
   * model. Default false. See AutoRouterConfig.semi.
   */
  semi?: boolean;
  /**
   * Allowlist of routable models as `provider/id` patterns, e.g.
   * `["github-copilot/*", "opencode-go/deepseek-v4-pro"]`. Absent or empty
   * means every registry model is routable. See allowlist.ts.
   */
  models?: string[];
  /**
   * Persistent blacklist of `provider/id` patterns (same glob syntax as
   * `models`, e.g. patterns like "github-copilot/*" or "[star]/gemini[star]")
   * that are never routed, across sessions. Distinct from the in-memory,
   * per-session blacklist of concrete models that failed at runtime (see
   * provider.ts); that one is never written here. See allowlist.ts.
   */
  blacklist?: string[];
  /**
   * Debug logging. `true` → per-session timing log next to the session file;
   * a string → that explicit path; `false`/absent → off.
   */
  debug?: boolean | string;
  /**
   * Opt-in literal prefixes for known integrations (e.g. `pi-context`).
   * Non-arrays are rejected; non-string members, empty strings, and entries
   * over 200 chars are dropped. Default `[]`.
   */
  syntheticPrefixes?: string[];
}

const DIMENSIONS: Dimension[] = ['lightweight', 'gather', 'plan', 'implement', 'review'];

const finiteInRange = (
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : fallback;

const stringList = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const values = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return values.length > 0 ? [...new Set(values)] : undefined;
};

const normalizeDimensionWeights = (value: unknown): Record<Dimension, ScoreWeights> => {
  const result = { ...DEFAULT_DIMENSION_WEIGHTS };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [dim, spec] of Object.entries(value)) {
    if (!DIMENSIONS.includes(dim as Dimension)) continue;
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) continue;
    const s = spec as Record<string, unknown>;
    const defaults = DEFAULT_DIMENSION_WEIGHTS[dim as Dimension];
    result[dim as Dimension] = {
      quality: finiteInRange(s.quality, defaults.quality, 0, Number.MAX_VALUE),
      cost: finiteInRange(s.cost, defaults.cost, 0, Number.MAX_VALUE),
      speed: finiteInRange(s.speed, defaults.speed, 0, Number.MAX_VALUE),
    };
  }
  return result;
};

/** Read and parse the raw config file, ignoring corruption. Rejects arrays
 *  and primitives so callers don't need to guard against [] or "string". */
function readPersisted(path: string): PersistedConfig {
  const parsed = readJsonCached(path)?.parsed;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as PersistedConfig;
  }
  return {};
}

export function loadConfig(): AutoRouterConfig {
  const persisted = readPersisted(getConfigPath());

  return {
    artificialAnalysisApiKey:
      typeof persisted.artificialAnalysisApiKey === 'string'
        ? persisted.artificialAnalysisApiKey
        : undefined,
    sources: stringList(persisted.sources) ?? ['artificial-analysis', 'benchlm'],
    dimensionWeights: normalizeDimensionWeights(persisted.dimensionWeights),
    switchMargin: finiteInRange(persisted.switchMargin, DEFAULT_SWITCH_MARGIN, 0, 1),
    baselineModel:
      typeof persisted.baselineModel === 'string' && persisted.baselineModel.trim()
        ? persisted.baselineModel.trim()
        : undefined,
    routerContextWindow:
      typeof persisted.routerContextWindow === 'number' &&
      Number.isFinite(persisted.routerContextWindow) &&
      persisted.routerContextWindow > 0
        ? Math.floor(persisted.routerContextWindow)
        : undefined,
    lowConfidenceThreshold: finiteInRange(
      persisted.lowConfidenceThreshold,
      DEFAULT_LOW_CONFIDENCE_THRESHOLD,
      0,
      1,
    ),
    prompt: typeof persisted.prompt === 'boolean' ? persisted.prompt : true,
    semi: typeof persisted.semi === 'boolean' ? persisted.semi : false,
    models: stringList(persisted.models),
    blacklist: Array.isArray(persisted.blacklist)
      ? (stringList(persisted.blacklist) ?? [])
      : undefined,
    debug:
      typeof persisted.debug === 'boolean' || typeof persisted.debug === 'string'
        ? persisted.debug
        : undefined,
    syntheticPrefixes: stringList(persisted.syntheticPrefixes)?.filter(
      (p) => p.length <= 200,
    ) ?? [],
  };
}

/**
 * Obsolete keys ignored at runtime and dropped on the next write so stale
 * values cannot look like live configuration.
 */
const REMOVED_CONFIG_KEYS = [
  'escalationToken',
  'escalationTool',
  'escalationTtlTurns',
  'assessmentMode',
  'assessmentShadowDeadlineMs',
  'embeddingMinConfidence',
  'embeddingClassifier',
  'embeddingDeadlineMs',
  'collectTools',
  'consultRouter',
  'consultRouterAgent',
  'consultModel',
  'assessmentDeadlineMs',
  'assessmentMaxInputChars',
  'assessorQualityRatio',
] as const;

function withoutRemovedKeys(persisted: PersistedConfig): PersistedConfig {
  const next = { ...persisted } as Record<string, unknown>;
  for (const key of REMOVED_CONFIG_KEYS) delete next[key];
  return next as PersistedConfig;
}

export function saveApiKey(apiKey: string): void {
  const path = getConfigPath();
  // Merge into whatever is on disk rather than re-serialising a fixed field
  // list: an explicit allowlist here silently deleted any config key this
  // function did not know about (e.g. `models`).
  const persisted = readPersisted(path);
  const next: PersistedConfig = { ...withoutRemovedKeys(persisted), artificialAnalysisApiKey: apiKey };
  writeJsonAtomic(path, next, 0o600);
}

/** Overwrite the persisted blacklist pattern list, merging into the config file. */
export function saveBlacklist(patterns: readonly string[]): void {
  const path = getConfigPath();
  const persisted = readPersisted(path);
  const next: PersistedConfig = { ...withoutRemovedKeys(persisted), blacklist: [...patterns] };
  writeJsonAtomic(path, next, 0o600);
}

/** Persist semi-automatic confirmation (`semi` in config.json). */
export function saveSemi(enabled: boolean): void {
  const path = getConfigPath();
  const persisted = readPersisted(path);
  const next: PersistedConfig = { ...withoutRemovedKeys(persisted), semi: enabled };
  writeJsonAtomic(path, next, 0o600);
}
