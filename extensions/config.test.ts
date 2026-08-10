/**
 * Config persistence tests, focused on the blacklist: it must round-trip
 * through the config file, merge (not clobber) other keys, and never be
 * confused with the in-memory session blacklist that lives in provider.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, saveBlacklist, saveApiKey, getConfigPath } from './config.js';
import {
  DEFAULT_DEPTH_ESCALATION_TOKENS,
  DEFAULT_DIMENSION_WEIGHTS,
  DEFAULT_LOW_CONFIDENCE_THRESHOLD,
  DEFAULT_SWITCH_MARGIN,
} from './constants.js';

let dir: string;
let prevEnv: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi8-config-test-'));
  prevEnv = process.env.PI8_DIR;
  process.env.PI8_DIR = dir;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.PI8_DIR;
  else process.env.PI8_DIR = prevEnv;
  rmSync(dir, { recursive: true, force: true });
});

describe('saveBlacklist', () => {
  it('is absent from config by default', () => {
    expect(loadConfig().blacklist).toBeUndefined();
  });

  it('persists patterns to the config file and loadConfig reflects them', () => {
    saveBlacklist(['github-copilot/*', '*/gemini*']);
    expect(loadConfig().blacklist).toEqual(['github-copilot/*', '*/gemini*']);
  });

  it('is durable across separate loadConfig calls (simulating a new session)', () => {
    saveBlacklist(['opencode-go/deepseek-v4-pro']);
    // A fresh call re-reads from disk each time — nothing is cached in-module.
    expect(loadConfig().blacklist).toEqual(['opencode-go/deepseek-v4-pro']);
    expect(loadConfig().blacklist).toEqual(['opencode-go/deepseek-v4-pro']);
  });

  it('overwrites the previous blacklist rather than appending', () => {
    saveBlacklist(['a/*']);
    saveBlacklist(['b/*']);
    expect(loadConfig().blacklist).toEqual(['b/*']);
  });

  it('merges into the config file without clobbering unrelated keys', () => {
    saveApiKey('test-key-123');
    saveBlacklist(['github-copilot/*']);
    const config = loadConfig();
    expect(config.artificialAnalysisApiKey).toBe('test-key-123');
    expect(config.blacklist).toEqual(['github-copilot/*']);
  });

  it('does not touch the models allowlist key', () => {
    const raw = () => JSON.parse(readFileSync(getConfigPath(), 'utf8')) as Record<string, unknown>;
    saveBlacklist(['github-copilot/*']);
    expect(raw().models).toBeUndefined();
  });

  it('clears the persisted blacklist with an empty array', () => {
    saveBlacklist(['github-copilot/*']);
    saveBlacklist([]);
    expect(loadConfig().blacklist).toEqual([]);
  });
});

describe('consult router option', () => {
  it('defaults consultRouter to true when absent', () => {
    expect(loadConfig().consultRouter).toBe(true);
  });

  it.each(['consultRouter', 'consultRouterAgent'] as const)(
    'respects an explicit false for %s (legacy input alias still works)',
    (key) => {
      writeFileSync(getConfigPath(), JSON.stringify({ [key]: false }), 'utf8');
      expect(loadConfig().consultRouter).toBe(false);
    },
  );
});

describe('prompt option', () => {
  it('defaults to true when absent', () => {
    expect(loadConfig().prompt).toBe(true);
  });

  it('respects an explicit false in the config file', () => {
    writeFileSync(getConfigPath(), JSON.stringify({ prompt: false }), 'utf8');
    expect(loadConfig().prompt).toBe(false);
  });
});

it('drops malformed values and clamps routing policy to documented defaults', () => {
  writeFileSync(
    getConfigPath(),
    JSON.stringify({
      sources: ['artificial-analysis', 7, ''],
      switchMargin: 'large',
      lowConfidenceThreshold: -1,
      depthEscalationTokens: 0,
      escalationTtlTurns: 'infinite',
      models: ['alpha/*', 9, '  '],
      blacklist: [null, '*/broken'],
      dimensionWeights: {
        implement: { quality: 0.7, cost: -3, speed: 'fast' },
        unknown: { quality: 1, cost: 0, speed: 0 },
      },
    }),
    'utf8',
  );

  const config = loadConfig();
  expect(config.switchMargin).toBe(DEFAULT_SWITCH_MARGIN);
  expect(config.lowConfidenceThreshold).toBe(DEFAULT_LOW_CONFIDENCE_THRESHOLD);
  expect(config.depthEscalationTokens).toBe(DEFAULT_DEPTH_ESCALATION_TOKENS);
  expect(config.escalationTtlTurns).toBe(4);
  expect(config.models).toEqual(['alpha/*']);
  expect(config.blacklist).toEqual(['*/broken']);
  expect(config.dimensionWeights.implement).toEqual({
    quality: 0.7,
    cost: DEFAULT_DIMENSION_WEIGHTS.implement.cost,
    speed: DEFAULT_DIMENSION_WEIGHTS.implement.speed,
  });
});

describe('depth escalation config', () => {
  it('defaults to enabled with the standard threshold', () => {
    const config = loadConfig();
    expect(config.depthEscalation).toBe(true);
    expect(config.depthEscalationTokens).toBe(32768);
  });

  it('honours opt-out and a custom threshold', () => {
    writeFileSync(
      getConfigPath(),
      JSON.stringify({ depthEscalation: false, depthEscalationTokens: 4096 }),
      'utf8',
    );
    const config = loadConfig();
    expect(config.depthEscalation).toBe(false);
    expect(config.depthEscalationTokens).toBe(4096);
  });
});

describe('malformed config values are normalized to defaults', () => {
  it('rejects a top-level array as config', () => {
    writeFileSync(getConfigPath(), '[]', 'utf8');
    // Must return the default config, not treat the array as an object.
    const config = loadConfig();
    expect(config.sources).toEqual(['artificial-analysis', 'benchlm']);
  });

  it('rejects a top-level string as config', () => {
    writeFileSync(getConfigPath(), '"nonsense"', 'utf8');
    const config = loadConfig();
    expect(config.switchMargin).toBe(DEFAULT_SWITCH_MARGIN);
  });

  it('rejects a top-level number as config', () => {
    writeFileSync(getConfigPath(), '42', 'utf8');
    const config = loadConfig();
    expect(config.lowConfidenceThreshold).toBe(DEFAULT_LOW_CONFIDENCE_THRESHOLD);
  });

  it('drops a non-string consultModel', () => {
    writeFileSync(getConfigPath(), JSON.stringify({ consultModel: 123 }), 'utf8');
    expect(loadConfig().consultModel).toBeUndefined();
  });

  it('drops an empty-string consultModel', () => {
    writeFileSync(getConfigPath(), JSON.stringify({ consultModel: '' }), 'utf8');
    expect(loadConfig().consultModel).toBeUndefined();
  });

  it('drops a whitespace-only consultModel', () => {
    writeFileSync(getConfigPath(), JSON.stringify({ consultModel: '   ' }), 'utf8');
    expect(loadConfig().consultModel).toBeUndefined();
  });

  it('drops an object consultModel', () => {
    writeFileSync(getConfigPath(), JSON.stringify({ consultModel: { provider: 'x', id: 'y' } }), 'utf8');
    expect(loadConfig().consultModel).toBeUndefined();
  });

  it('coerces a non-boolean depthEscalation to true (default on)', () => {
    writeFileSync(getConfigPath(), JSON.stringify({ depthEscalation: 'yes' }), 'utf8');
    expect(loadConfig().depthEscalation).toBe(true);
  });

  it('coerces a numeric depthEscalation to true (default on)', () => {
    writeFileSync(getConfigPath(), JSON.stringify({ depthEscalation: 1 }), 'utf8');
    expect(loadConfig().depthEscalation).toBe(true);
  });

  it('coerces a non-boolean escalationTool to true (default on)', () => {
    writeFileSync(getConfigPath(), JSON.stringify({ escalationTool: 'off' }), 'utf8');
    expect(loadConfig().escalationTool).toBe(true);
  });

  it('coerces a non-boolean prompt to true (default on)', () => {
    writeFileSync(getConfigPath(), JSON.stringify({ prompt: { enabled: false } }), 'utf8');
    expect(loadConfig().prompt).toBe(true);
  });

  it('drops a non-string/non-boolean debug value', () => {
    writeFileSync(getConfigPath(), JSON.stringify({ debug: 42 }), 'utf8');
    expect(loadConfig().debug).toBeUndefined();
  });

  it('drops a null debug value', () => {
    writeFileSync(getConfigPath(), JSON.stringify({ debug: null }), 'utf8');
    expect(loadConfig().debug).toBeUndefined();
  });

  it('preserves a string debug value', () => {
    writeFileSync(getConfigPath(), JSON.stringify({ debug: 'extensions/router/*' }), 'utf8');
    expect(loadConfig().debug).toBe('extensions/router/*');
  });

  it('drops a non-string artificialAnalysisApiKey', () => {
    writeFileSync(getConfigPath(), JSON.stringify({ artificialAnalysisApiKey: 777 }), 'utf8');
    expect(loadConfig().artificialAnalysisApiKey).toBeUndefined();
  });

  it('preserves a valid artificialAnalysisApiKey', () => {
    writeFileSync(getConfigPath(), JSON.stringify({ artificialAnalysisApiKey: 'sk-abc123' }), 'utf8');
    expect(loadConfig().artificialAnalysisApiKey).toBe('sk-abc123');
  });
});

describe('assessment config', () => {
  it('defaults assessmentMode to shadow', () => {
    writeFileSync(getConfigPath(), JSON.stringify({}), 'utf8');
    expect(loadConfig().assessmentMode).toBe('shadow');
  });

  it('accepts an explicit active mode', () => {
    writeFileSync(getConfigPath(), JSON.stringify({ assessmentMode: 'active' }), 'utf8');
    expect(loadConfig().assessmentMode).toBe('active');
  });

  it('rejects an unknown mode and falls back to shadow', () => {
    writeFileSync(getConfigPath(), JSON.stringify({ assessmentMode: 'aggressive' }), 'utf8');
    expect(loadConfig().assessmentMode).toBe('shadow');
  });

  it('defaults the assessment deadline, input cap and assessor floor', () => {
    writeFileSync(getConfigPath(), JSON.stringify({}), 'utf8');
    const config = loadConfig();
    expect(config.assessmentDeadlineMs).toBe(1500);
    expect(config.assessmentShadowDeadlineMs).toBe(12000);
    expect(config.assessmentMaxInputChars).toBe(6000);
    expect(config.assessorQualityRatio).toBe(0.5);
  });

  it('honours a shadow deadline override', () => {
    writeFileSync(getConfigPath(), JSON.stringify({ assessmentShadowDeadlineMs: 8000 }), 'utf8');
    expect(loadConfig().assessmentShadowDeadlineMs).toBe(8000);
  });

  it('clamps a nonsense assessor ratio back to the default', () => {
    writeFileSync(getConfigPath(), JSON.stringify({ assessorQualityRatio: 4 }), 'utf8');
    expect(loadConfig().assessorQualityRatio).toBe(0.5);
  });
});

describe('syntheticPrefixes', () => {
  it('defaults to an empty array when absent', () => {
    writeFileSync(getConfigPath(), JSON.stringify({}), 'utf8');
    expect(loadConfig().syntheticPrefixes).toEqual([]);
  });

  it('rejects a non-array value and falls back to []', () => {
    writeFileSync(
      getConfigPath(),
      JSON.stringify({ syntheticPrefixes: 'not-an-array' }),
      'utf8',
    );
    expect(loadConfig().syntheticPrefixes).toEqual([]);
  });

  it('drops non-string members and empty strings', () => {
    writeFileSync(
      getConfigPath(),
      JSON.stringify({ syntheticPrefixes: ['[pi-context]', 42, '', '  ', 'valid'] }),
      'utf8',
    );
    // 42 dropped (non-string), empty string dropped, whitespace trimmed and dropped if empty.
    expect(loadConfig().syntheticPrefixes).toEqual(['[pi-context]', 'valid']);
  });

  it('drops entries over 200 chars', () => {
    const long = 'x'.repeat(201);
    writeFileSync(
      getConfigPath(),
      JSON.stringify({ syntheticPrefixes: [long, 'ok'] }),
      'utf8',
    );
    expect(loadConfig().syntheticPrefixes).toEqual(['ok']);
  });
});

describe('legacy escalationToken migration', () => {
  it('exposes no escalationToken for a legacy config', () => {
    writeFileSync(
      getConfigPath(),
      JSON.stringify({ escalationToken: '!up', models: ['alpha/*'] }),
      'utf8',
    );

    expect('escalationToken' in loadConfig()).toBe(false);
  });

  it('strips the legacy key on the next config write and preserves unrelated keys', () => {
    writeFileSync(
      getConfigPath(),
      JSON.stringify({ escalationToken: '!up', models: ['alpha/*'] }),
      'utf8',
    );

    saveBlacklist(['*/broken']);

    const raw = JSON.parse(readFileSync(getConfigPath(), 'utf8')) as Record<string, unknown>;
    expect(raw.escalationToken).toBeUndefined();
    expect(raw.models).toEqual(['alpha/*']);
    expect(raw.blacklist).toEqual(['*/broken']);
  });
});
