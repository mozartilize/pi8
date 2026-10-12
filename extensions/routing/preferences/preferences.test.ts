/**
 * Contracts of the v1 preference profile: frozen scenario semantics, strict
 * per-key validation, semantic (never positional) persistence and per-user
 * config isolation.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getConfigPath, loadPreferenceSnapshot, savePreferences } from '../../config.js';
import { FEATURE_INDEX } from '../features/schema.js';
import { compilePreferenceConstraints } from './fit.js';
import { CORE_SCENARIOS_V1, scenarioDelta } from './scenarios.js';
import {
  CORE_PREFERENCE_KEYS,
  compileChoice,
  hasSubstantiveAnswers,
  preferenceProfileDigest,
  validatePreferences,
  type UserRoutingPreferencesV1,
} from './schema.js';

/** Frozen v1 vectors, restated here so a change to the source cannot pass silently. */
const FROZEN_V1: Record<string, { usd: [number, number]; A: number[]; B: number[] }> = {
  settledImplementation: { usd: [0.07, 0.1], A: [0.45, 0.52, 0.3, 0.55, 0.35915, 0.6, 0.55, 1, 0, 0], B: [0.45, 0.62, 0.3, 0.55, 0.333333, 0.6, 0.55, 1, 0, 0] },
  openDesignDecisions: { usd: [0.05, 0.1], A: [0.55, 0.45, 0.3, 0.55, 0.383505, 0.6, 0.6, 1, 0, 0], B: [0.74, 0.45, 0.3, 0.55, 0.333333, 0.6, 0.6, 1, 0, 0] },
  handoffWarmCache: { usd: [0.04, 0.15], A: [0.56, 0.45, 0.4, 0.55, 0.399657, 0.6, 0.65, 1, 0, 0], B: [0.8, 0.45, 0.4, 0.55, 0.303985, 0.6, 0.45, 1, 0, 0] },
  researchTasks: { usd: [0.06, 0.12], A: [0.55, 0.62, 0.4, 0.55, 0.370308, 0.6, 0.55, 1, 0, 0], B: [0.55, 0.44, 0.75, 0.55, 0.320136, 0.6, 0.55, 1, 0, 0] },
  afterRework: { usd: [0.1, 0.1], A: [0.6, 0.6, 0.3, 0.55, 0.333333, 0.6, 0.78, 1, 1, 0], B: [0.6, 0.6, 0.3, 0.55, 0.333333, 0.6, 0.48, 1, 0, 1] },
};

/** The frozen price transform, written out independently of mapping.ts. */
const transform = (usd: number) => Math.min(1, Math.max(0, 1 - Math.log10(usd / 0.00001) / 6));

describe('frozen v1 scenarios', () => {
  it('has exactly the five core keys with the checked-in vectors and prices', () => {
    expect(Object.keys(CORE_SCENARIOS_V1).sort()).toEqual([...CORE_PREFERENCE_KEYS].sort());
    for (const key of CORE_PREFERENCE_KEYS) {
      const scenario = CORE_SCENARIOS_V1[key];
      const frozen = FROZEN_V1[key]!;
      expect([scenario.A.usd, scenario.B.usd]).toEqual(frozen.usd);
      expect([...scenario.A.features]).toEqual(frozen.A);
      expect([...scenario.B.features]).toEqual(frozen.B);
    }
  });

  it('keeps every coordinate in [0,1] and each cost feature equal to the price transform', () => {
    for (const key of CORE_PREFERENCE_KEYS) {
      for (const option of [CORE_SCENARIOS_V1[key].A, CORE_SCENARIOS_V1[key].B]) {
        expect(option.features).toHaveLength(10);
        for (const value of option.features) expect(value >= 0 && value <= 1).toBe(true);
        expect(Math.abs(option.features[FEATURE_INDEX.costDesirability]! - transform(option.usd))).toBeLessThanOrEqual(1e-6);
      }
    }
  });

  it('afterRework differs only in continuity and the two recovery features: A-B = 0.30k + e - m', () => {
    const delta = scenarioDelta('afterRework');
    const expected = new Array(10).fill(0);
    expected[FEATURE_INDEX.continuity] = 0.3;
    expected[FEATURE_INDEX.effortRecoveryFit] = 1;
    expected[FEATURE_INDEX.modelSwitchRecoveryFit] = -1;
    delta.forEach((value, j) => expect(value).toBeCloseTo(expected[j], 12));
    // Neither option carries failure evidence: friction avoidance is 1 on both sides.
    expect(CORE_SCENARIOS_V1.afterRework.A.features[FEATURE_INDEX.frictionAvoidance]).toBe(1);
    expect(CORE_SCENARIOS_V1.afterRework.B.features[FEATURE_INDEX.frictionAvoidance]).toBe(1);
  });
});

describe('answer compilation', () => {
  it('maps semantic values to directions; unsure and skip give no constraint', () => {
    expect(compileChoice('settledImplementation', 'lower_cost')).toBe('A');
    expect(compileChoice('settledImplementation', 'higher_coding_capability')).toBe('B');
    expect(compileChoice('handoffWarmCache', 'keep_warm_incumbent')).toBe('A');
    expect(compileChoice('afterRework', 'switch_model')).toBe('B');
    expect(compileChoice('researchTasks', 'equivalent')).toBe('equivalent');
    expect(compileChoice('researchTasks', 'unsure')).toBeUndefined();
    expect(compileChoice('researchTasks', 'skip')).toBeUndefined();
  });

  it('orients B answers as the negated scenario delta', () => {
    const [constraint] = compilePreferenceConstraints({ version: 1, settledImplementation: 'higher_coding_capability' });
    // lower_cost would require 0.025817*cost - 0.10*agentic >= margin; the B answer reverses it.
    expect(constraint!.delta[FEATURE_INDEX.costDesirability]).toBeCloseTo(-0.025817, 9);
    expect(constraint!.delta[FEATURE_INDEX.agenticFit]).toBeCloseTo(0.1, 12);
  });

  it('counts only named options and equivalent as substantive', () => {
    expect(hasSubstantiveAnswers({ version: 1 })).toBe(false);
    expect(hasSubstantiveAnswers({ version: 1, researchTasks: 'skip', afterRework: 'unsure' })).toBe(false);
    expect(hasSubstantiveAnswers({ version: 1, researchTasks: 'equivalent' })).toBe(true);
    expect(compilePreferenceConstraints({ version: 1, researchTasks: 'skip', afterRework: 'unsure' })).toEqual([]);
  });
});

describe('validatePreferences', () => {
  it('treats an absent object as a valid empty profile', () => {
    expect(validatePreferences(undefined)).toMatchObject({ status: 'valid', profile: { version: 1 }, diagnostics: [] });
  });

  it('accepts each key only with its own enum values', () => {
    const valid = validatePreferences({ version: 1, settledImplementation: 'lower_cost', handoffWarmCache: 'switch_for_capability' });
    expect(valid.status).toBe('valid');
    // `lower_cost` is a legal value of other keys, not of handoffWarmCache.
    const wrongKey = validatePreferences({ version: 1, handoffWarmCache: 'lower_cost' });
    expect(wrongKey.status).toBe('invalid');
    expect(wrongKey.profile).toBeUndefined();
    expect(validatePreferences({ version: 1, afterRework: 'A' }).status).toBe('invalid');
  });

  it('rejects unknown fields, nested answers and unsupported versions without partial application', () => {
    expect(validatePreferences({ version: 1, answers: { q1: 'A' } }).status).toBe('invalid');
    expect(validatePreferences({ version: 1, settledImplementation: 'lower_cost', speed: 'fast' }).profile).toBeUndefined();
    const v2 = validatePreferences({ version: 2, settledImplementation: 'lower_cost' });
    expect(v2.status).toBe('unsupported-version');
    expect(v2.diagnostics[0]).toContain('version');
    expect(validatePreferences({ settledImplementation: 'lower_cost' }).status).toBe('unsupported-version');
    expect(validatePreferences(['lower_cost']).status).toBe('invalid');
  });

  it('gives equal digests to equal profiles regardless of key order, and different digests otherwise', () => {
    const a = preferenceProfileDigest({ version: 1, settledImplementation: 'lower_cost', afterRework: 'switch_model' });
    const b = preferenceProfileDigest({ afterRework: 'switch_model', version: 1, settledImplementation: 'lower_cost' } as UserRoutingPreferencesV1);
    expect(a).toBe(b);
    expect(preferenceProfileDigest({ version: 1, settledImplementation: 'skip' })).not.toBe(preferenceProfileDigest({ version: 1 }));
  });
});

describe('preference persistence', () => {
  let dir: string;
  let previous: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pi8-pref-test-'));
    previous = process.env.PI8_DIR;
    process.env.PI8_DIR = dir;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.PI8_DIR;
    else process.env.PI8_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes one flat semantic object and keeps unrelated and unknown config keys', () => {
    writeFileSync(getConfigPath(), JSON.stringify({ semi: true, models: ['a/*'], futureKey: { x: 1 } }));
    savePreferences({ version: 1, afterRework: 'switch_model', settledImplementation: 'lower_cost', researchTasks: 'skip' });
    const written = JSON.parse(readFileSync(getConfigPath(), 'utf8'));
    expect(written).toMatchObject({ semi: true, models: ['a/*'], futureKey: { x: 1 } });
    expect(written.preferences).toEqual({ version: 1, settledImplementation: 'lower_cost', researchTasks: 'skip', afterRework: 'switch_model' });
    expect(JSON.stringify(written.preferences)).not.toMatch(/"[AB]"/);
    const snapshot = loadPreferenceSnapshot();
    expect(snapshot.status).toBe('valid');
    expect(snapshot.profile).toEqual(written.preferences);
  });

  it('removes the object when the profile is reset to empty', () => {
    savePreferences({ version: 1, afterRework: 'switch_model' });
    savePreferences({ version: 1 });
    expect(JSON.parse(readFileSync(getConfigPath(), 'utf8')).preferences).toBeUndefined();
  });

  it('increases the revision only when the stored profile changes', () => {
    savePreferences({ version: 1, afterRework: 'switch_model' });
    const first = loadPreferenceSnapshot();
    expect(loadPreferenceSnapshot().revision).toBe(first.revision);
    savePreferences({ version: 1, afterRework: 'increase_effort' });
    const second = loadPreferenceSnapshot();
    expect(second.revision).toBeGreaterThan(first.revision);
    expect(second.digest).not.toBe(first.digest);
  });

  it('keeps users with separate PI8_DIR roots isolated', () => {
    savePreferences({ version: 1, settledImplementation: 'lower_cost' });
    const other = mkdtempSync(join(tmpdir(), 'pi8-pref-other-'));
    try {
      process.env.PI8_DIR = other;
      expect(loadPreferenceSnapshot().profile).toEqual({ version: 1 });
      savePreferences({ version: 1, settledImplementation: 'higher_coding_capability' });
      process.env.PI8_DIR = dir;
      expect(loadPreferenceSnapshot().profile).toEqual({ version: 1, settledImplementation: 'lower_cost' });
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('reports an invalid stored profile and exposes no profile to apply', () => {
    writeFileSync(getConfigPath(), JSON.stringify({ preferences: { version: 1, afterRework: 'maybe' } }));
    const snapshot = loadPreferenceSnapshot();
    expect(snapshot.status).toBe('invalid');
    expect(snapshot.profile).toBeUndefined();
    expect(snapshot.diagnostics.join(' ')).toContain('afterRework');
  });
});
