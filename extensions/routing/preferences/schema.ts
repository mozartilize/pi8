/**
 * Per-user routing preference profile, persisted flat in `config.json` under
 * `preferences`. One `version` discriminator and five optional semantic enum
 * fields. Positional A/B codes are never persisted.
 */
import { digestOf } from '../digest.js';

export const PREFERENCES_VERSION = 1 as const;

export type NonDecision = 'equivalent' | 'unsure' | 'skip';
export const NON_DECISIONS: readonly NonDecision[] = ['equivalent', 'unsure', 'skip'];

export interface UserRoutingPreferencesV1 {
  version: 1;
  settledImplementation?: 'lower_cost' | 'higher_coding_capability' | NonDecision;
  openDesignDecisions?: 'lower_cost' | 'higher_reasoning_capability' | NonDecision;
  handoffWarmCache?: 'keep_warm_incumbent' | 'switch_for_capability' | NonDecision;
  researchTasks?: 'lower_cost' | 'higher_research_capability' | NonDecision;
  afterRework?: 'increase_effort' | 'switch_model' | NonDecision;
}

export type PreferenceKey = Exclude<keyof UserRoutingPreferencesV1, 'version'>;
export type PreferenceValue<K extends PreferenceKey> = NonNullable<UserRoutingPreferencesV1[K]>;

export const CORE_PREFERENCE_KEYS = [
  'settledImplementation',
  'openDesignDecisions',
  'handoffWarmCache',
  'researchTasks',
  'afterRework',
] as const satisfies readonly PreferenceKey[];

/** The semantic enum of each scenario option. The UI may show A/B; config never stores it. */
export const SCENARIO_OPTIONS = {
  settledImplementation: { A: 'lower_cost', B: 'higher_coding_capability' },
  openDesignDecisions: { A: 'lower_cost', B: 'higher_reasoning_capability' },
  handoffWarmCache: { A: 'keep_warm_incumbent', B: 'switch_for_capability' },
  researchTasks: { A: 'lower_cost', B: 'higher_research_capability' },
  afterRework: { A: 'increase_effort', B: 'switch_model' },
} as const satisfies { [K in PreferenceKey]: { A: string; B: string } };

export const allowedValues = (key: PreferenceKey): readonly string[] =>
  [SCENARIO_OPTIONS[key].A, SCENARIO_OPTIONS[key].B, ...NON_DECISIONS];

export const isPreferenceKey = (value: string): value is PreferenceKey =>
  (CORE_PREFERENCE_KEYS as readonly string[]).includes(value);

export function isAllowedValue<K extends PreferenceKey>(key: K, value: unknown): value is PreferenceValue<K> {
  return typeof value === 'string' && allowedValues(key).includes(value);
}

export type ChoiceDirection = 'A' | 'B' | 'equivalent';

/** In-memory direction of a stored answer. `unsure` and `skip` give no constraint. */
export function compileChoice<K extends PreferenceKey>(key: K, choice: PreferenceValue<K>): ChoiceDirection | undefined {
  if (choice === 'equivalent') return 'equivalent';
  if (choice === 'unsure' || choice === 'skip') return undefined;
  if (choice === SCENARIO_OPTIONS[key].A) return 'A';
  if (choice === SCENARIO_OPTIONS[key].B) return 'B';
  throw new Error(`invalid preference value for ${key}: ${String(choice)}`);
}

export const emptyPreferences = (): UserRoutingPreferencesV1 => ({ version: PREFERENCES_VERSION });

/** Answers that add an LP constraint: a named option or `equivalent`. */
export function hasSubstantiveAnswers(profile: UserRoutingPreferencesV1): boolean {
  return CORE_PREFERENCE_KEYS.some((key) => {
    const value = profile[key];
    return value !== undefined && value !== 'unsure' && value !== 'skip';
  });
}

/** Fixed key order, unanswered fields omitted. */
export function canonicalPreferences(profile: UserRoutingPreferencesV1): UserRoutingPreferencesV1 {
  const result: UserRoutingPreferencesV1 = { version: PREFERENCES_VERSION };
  for (const key of CORE_PREFERENCE_KEYS) {
    const value = profile[key];
    if (value !== undefined) (result as unknown as Record<string, unknown>)[key] = value;
  }
  return result;
}

export const preferenceProfileDigest = (profile: UserRoutingPreferencesV1): string =>
  digestOf(canonicalPreferences(profile));

export type PreferenceProfileStatus = 'valid' | 'invalid' | 'unsupported-version';

export interface ValidatedPreferences {
  status: PreferenceProfileStatus;
  /** The validated profile. Present only when `status` is `valid`. */
  profile?: UserRoutingPreferencesV1;
  /** Digest of the stored request: the canonical profile when valid, else the raw value. */
  digest: string;
  diagnostics: string[];
}

/**
 * Validate the raw `config.preferences` value. Each key accepts only its own
 * enum. An absent value is a valid empty profile. A value that does not
 * validate is never partly applied.
 */
export function validatePreferences(raw: unknown): ValidatedPreferences {
  if (raw === undefined) {
    const profile = emptyPreferences();
    return { status: 'valid', profile, digest: preferenceProfileDigest(profile), diagnostics: [] };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { status: 'invalid', digest: digestOf({ invalid: raw ?? null }), diagnostics: ['preferences must be an object'] };
  }
  const record = raw as Record<string, unknown>;
  if (record.version !== PREFERENCES_VERSION) {
    return {
      status: 'unsupported-version',
      digest: digestOf({ invalid: record }),
      diagnostics: [`preferences.version ${JSON.stringify(record.version ?? null)} is not supported; expected ${PREFERENCES_VERSION}`],
    };
  }
  const diagnostics: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (key === 'version') continue;
    if (!isPreferenceKey(key)) {
      diagnostics.push(`preferences.${key} is not a preference field`);
      continue;
    }
    if (value === undefined) continue;
    if (!isAllowedValue(key, value)) {
      diagnostics.push(`preferences.${key} must be one of ${allowedValues(key).join(', ')}`);
    }
  }
  if (diagnostics.length > 0) return { status: 'invalid', digest: digestOf({ invalid: record }), diagnostics };
  const profile = canonicalPreferences(record as unknown as UserRoutingPreferencesV1);
  return { status: 'valid', profile, digest: preferenceProfileDigest(profile), diagnostics: [] };
}
