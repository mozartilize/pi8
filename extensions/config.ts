/**
 * Extension runtime config loading. In v1 we keep this minimal: read config from
 * ~/.pi/agent/pi8/config.json when present, otherwise use defaults.
 */
import { join } from 'node:path';
import type { AutoRouterConfig, Dimension, ScoreWeights } from './types.js';
import {
  CONFIG_FILE,
  DEFAULT_ASSESSMENT_DEADLINE_MS,
  DEFAULT_ASSESSMENT_MAX_INPUT_CHARS,
  DEFAULT_ASSESSOR_QUALITY_RATIO,
  DEFAULT_DEPTH_ESCALATION_TOKENS,
  DEFAULT_DIMENSION_WEIGHTS,
  DEFAULT_EMBEDDING_MIN_CONFIDENCE,
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
  consultRouter?: boolean;
  consultRouterAgent?: boolean;
  consultModel?: string;
  /** End-to-end assessment budget in ms (default 1500). */
  assessmentDeadlineMs?: number;
  /** Assembled assessment input cap in characters (default 6000). */
  assessmentMaxInputChars?: number;
  /** Assessor intelligence floor as a ratio of the best routable (default 0.5). */
  assessorQualityRatio?: number;
  escalationTool?: boolean;
  escalationTtlTurns?: number;
  /**
   * Automatic one-tier raise for lightweight/gather dimensions once the live
   * context exceeds `depthEscalationTokens` (default true).
   */
  depthEscalation?: boolean;
  /** Token threshold for depth escalation (default 32768). */
  depthEscalationTokens?: number;
  /**
   * Show a TUI notification when the router picks a model for a turn or
   * switches models between turns. Default true. Set false to route silently
   * (the footer status widget still updates regardless).
   */
  prompt?: boolean;
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
  /**
   * Enable the local multilingual embedding classifier for prompts where the
   * keyword classifier has no categorical evidence (non-English, ambiguous).
   * Blends up only; never overrides keyword downward. Default false.
   */
  embeddingClassifier?: boolean;
  /** Max ms for model load + inference. Default 5000. */
  embeddingDeadlineMs?: number;
  /**
   * Minimum embedding-classifier confidence (top-two margin) for its verdict
   * to influence routing. Below it the embedding abstains and the keyword
   * result stands. Default 0.15.
   */
  embeddingMinConfidence?: number;
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

const positiveInteger = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;

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

  const consultRouter =
    typeof persisted.consultRouter === 'boolean'
      ? persisted.consultRouter
      : typeof persisted.consultRouterAgent === 'boolean'
        ? persisted.consultRouterAgent
        : true;

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
    consultRouter,
    consultModel:
      typeof persisted.consultModel === 'string' && persisted.consultModel.trim()
        ? persisted.consultModel
        : undefined,
    assessmentDeadlineMs: positiveInteger(
      persisted.assessmentDeadlineMs,
      DEFAULT_ASSESSMENT_DEADLINE_MS,
    ),
    assessmentMaxInputChars: positiveInteger(
      persisted.assessmentMaxInputChars,
      DEFAULT_ASSESSMENT_MAX_INPUT_CHARS,
    ),
    assessorQualityRatio: finiteInRange(
      persisted.assessorQualityRatio,
      DEFAULT_ASSESSOR_QUALITY_RATIO,
      0,
      1,
    ),
    depthEscalation: typeof persisted.depthEscalation === 'boolean' ? persisted.depthEscalation : true,
    depthEscalationTokens: positiveInteger(
      persisted.depthEscalationTokens,
      DEFAULT_DEPTH_ESCALATION_TOKENS,
    ),
    escalationTool: typeof persisted.escalationTool === 'boolean' ? persisted.escalationTool : true,
    escalationTtlTurns: positiveInteger(persisted.escalationTtlTurns, 4),
    prompt: typeof persisted.prompt === 'boolean' ? persisted.prompt : true,
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
    embeddingClassifier:
      typeof persisted.embeddingClassifier === 'boolean'
        ? persisted.embeddingClassifier
        : false,
    embeddingDeadlineMs: positiveInteger(persisted.embeddingDeadlineMs, 5000),
    embeddingMinConfidence: finiteInRange(
      persisted.embeddingMinConfidence,
      DEFAULT_EMBEDDING_MIN_CONFIDENCE,
      0,
      1,
    ),
  };
}

/**
 * Obsolete keys ignored at runtime and dropped on the next write so stale
 * values cannot look like live configuration.
 */
const REMOVED_CONFIG_KEYS = [
  'escalationToken',
  'assessmentMode',
  'assessmentShadowDeadlineMs',
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
