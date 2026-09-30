/**
 * Decision-log (M4 substrate) tests.
 *
 * The log must: survive corrupt/empty state, capture real fallbacks with their
 * rank, and never throw into the routing path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  appendDecision,
  appendSubagentGapSignal,
  appendSubagentSpend,
  appendExecutionContractSignal,
  appendInvestigationHandoffSignal,
  readRecentEntries,
  setDecisionLogBase,
  DECISION_LOG_FILE,
  DECISION_LOG_SCHEMA_VERSION,
} from './decisionlog.js';
import { setSessionFile } from '../sessionpaths.js';
import type { RoutingDecision } from '../types.js';

const DECISION: RoutingDecision = {
  dimension: 'implement',
  chosen: 'anthropic/claude-opus-4-6',
  reason: 'scored 0.789',
  confidence: 1.0,
  routedUp: false,
  routedDown: false,
  cause: 'heuristic',
  fallbackChain: ['anthropic/claude-opus-4-6', 'openai/gpt-5', 'deepseek/deepseek-v3'],
};

describe('decision log', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ar-decisionlog-'));
  });
  afterEach(() => {
    delete process.env.PI8_DIR;
    setSessionFile(undefined);
    setDecisionLogBase(undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips usage totals and baseline spend fields', () => {
    const decision: RoutingDecision = {
      ...DECISION,
      usage: { inputTokens: 100, outputTokens: 20, cacheRead: 5, cacheWrite: 0 },
      baseline: { registryId: 'openai/gpt-5', source: 'auto', cost: { input: 10, output: 50 } },
      spend: { routedCost: 0.002, baselineCost: 2.0 },
    };
    appendDecision(
      decision,
      { registryId: decision.chosen, viaFallback: false, accumulatedCost: 0.01 },
      dir,
    );
    const path = join(dir, DECISION_LOG_FILE);
    const entry = JSON.parse(readFileSync(path, 'utf8').trim().split('\n')[0]);
    expect(entry.usage).toEqual({ inputTokens: 100, outputTokens: 20, cacheRead: 5, cacheWrite: 0 });
    expect(entry.baselineModel).toBe('openai/gpt-5');
    expect(entry.baselineSource).toBe('auto');
    expect(entry.routedCost).toBe(0.002);
    expect(entry.baselineCost).toBe(2.0);
  });

  it('round-trips trajectory friction and incomplete spend', () => {
    const decision: RoutingDecision = {
      ...DECISION,
      cause: 'trajectory-escalation',
      trajectoryFriction: {
        tfi: 1,
        signals: [{ kind: 'aor', severity: 'severe', evidenceCount: 1 }],
        fromModel: 'test/weak:low',
        preOutput: false,
      },
      spend: { routedCost: 0.01, baselineCost: 1, incomplete: true },
    };
    appendDecision(
      decision,
      { registryId: 'test/strong', viaFallback: true, accumulatedCost: 0.01 },
      dir,
    );
    const path = join(dir, DECISION_LOG_FILE);
    const entry = JSON.parse(readFileSync(path, 'utf8').trim().split('\n')[0]);
    expect(entry.cause).toBe('trajectory-escalation');
    expect(entry.trajectoryFriction.fromModel).toBe('test/weak:low');
    expect(entry.spendIncomplete).toBe(true);
  });

  it('appends a JSONL line with the served model and no fallback', () => {
    appendDecision(
      DECISION,
      { registryId: DECISION.chosen, viaFallback: false, accumulatedCost: 0.01 },
      dir,
    );
    const path = join(dir, DECISION_LOG_FILE);
    expect(existsSync(path)).toBe(true);
    const entry = JSON.parse(readFileSync(path, 'utf8').trim().split('\n')[0]);
    expect(entry.served).toBe(DECISION.chosen);
    expect(entry.viaFallback).toBe(false);
    expect(entry.fallbackRank).toBeUndefined();
  });

  it('preserves a no-data cause in the JSONL entry', () => {
    appendDecision(
      { ...DECISION, cause: 'no-data', reason: 'scored 0.123 [no benchmark quality data]' },
      { registryId: DECISION.chosen, viaFallback: false, accumulatedCost: 0.01 },
      dir,
    );
    const entry = JSON.parse(readFileSync(join(dir, DECISION_LOG_FILE), 'utf8').trim());
    expect(entry.cause).toBe('no-data');
    expect(entry.reason).toMatch(/no benchmark quality data/);
  });

  it('captures a real fallback with its chain rank', () => {
    appendDecision(
      DECISION,
      { registryId: 'openai/gpt-5', viaFallback: true, fallbackRank: 2, accumulatedCost: 0.02 },
      dir,
    );
    const entry = JSON.parse(readFileSync(join(dir, DECISION_LOG_FILE), 'utf8').trim());
    expect(entry.served).toBe('openai/gpt-5');
    expect(entry.viaFallback).toBe(true);
    expect(entry.fallbackRank).toBe(2);
    expect(entry.chosen).toBe('anthropic/claude-opus-4-6');
  });

  it('readRecentEntries returns entries newest-last and respects limit', () => {
    for (let i = 0; i < 5; i++) {
      appendDecision(
        { ...DECISION, chosen: `m${i}` },
        { registryId: `m${i}`, viaFallback: false, accumulatedCost: i },
        dir,
      );
    }
    const recent = readRecentEntries(3, dir);
    expect(recent).toHaveLength(3);
    expect(recent[recent.length - 1].served).toBe('m4');
  });

  it('skips malformed JSONL lines while retaining valid entries', () => {
    appendFileSync(
      join(dir, DECISION_LOG_FILE),
      '{not-json}\n' + JSON.stringify({ ...DECISION, served: 'valid/model', viaFallback: false }) + '\n',
      'utf8',
    );
    const entries = readRecentEntries(10, dir);
    expect(entries).toHaveLength(1);
    expect(entries[0].served).toBe('valid/model');
  });

  it('returns [] when no log exists', () => {
    expect(readRecentEntries(10, dir)).toEqual([]);
  });

  it('uses PI8_DIR for the shared fallback log', () => {
    process.env.PI8_DIR = dir;
    setSessionFile(undefined);
    setDecisionLogBase(undefined);

    appendDecision(DECISION, {
      registryId: DECISION.chosen,
      viaFallback: false,
      accumulatedCost: 0,
    });

    expect(existsSync(join(dir, DECISION_LOG_FILE))).toBe(true);
  });

  it('preserves context-pressure and candidate diagnostic metadata', () => {
    const decision: RoutingDecision = {
      ...DECISION,
      cause: 'router-consult',
      contextPressure: {
        usageRatio: 0.71,
        threshold: 0.6,
        suggestion: 'offload planning',
      },
      candidateDiagnostics: [
        { candidateKey: 'cheap/model', excludedReason: 'promoted' },
        { candidateKey: 'weak/model', excludedReason: 'below-task-floor' },
      ],
    };
    appendDecision(
      decision,
      { registryId: DECISION.chosen, viaFallback: false, accumulatedCost: 0.01 },
      dir,
    );
    const entry = JSON.parse(readFileSync(join(dir, DECISION_LOG_FILE), 'utf8').trim());
    expect(entry.contextPressure.usageRatio).toBe(0.71);
    expect(entry.candidateDiagnostics).toEqual([
      { candidateKey: 'cheap/model', excludedReason: 'promoted' },
      { candidateKey: 'weak/model', excludedReason: 'below-task-floor' },
    ]);
  });

  it('stamps every record kind with the schema version it was written under', () => {
    appendDecision(DECISION, { registryId: DECISION.chosen, viaFallback: false, accumulatedCost: 0 }, dir);
    appendSubagentGapSignal({ tool: 'bash' }, dir);
    appendSubagentSpend({
      model: 'a/b',
      routerOwned: true,
      usage: { inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0 },
    }, dir);
    appendExecutionContractSignal({ intentKey: 'k', served: 'a/b', action: 'nudge' }, dir);
    appendInvestigationHandoffSignal({ intentKey: 'k', served: 'a/b', action: 'nudge' }, dir);

    const records = readRecentEntries(10, dir);
    expect(records).toHaveLength(5);
    expect(records.every((record) => record.schemaVersion === DECISION_LOG_SCHEMA_VERSION)).toBe(true);
  });

  it('carries the classifier confidence on routing decisions only', () => {
    appendDecision(DECISION, { registryId: DECISION.chosen, viaFallback: false, accumulatedCost: 0 }, dir);
    appendSubagentGapSignal({ tool: 'bash' }, dir);
    appendSubagentSpend({
      model: 'a/b',
      routerOwned: true,
      usage: { inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0 },
    }, dir);
    appendExecutionContractSignal({ intentKey: 'k', served: 'a/b', action: 'nudge' }, dir);
    appendInvestigationHandoffSignal({ intentKey: 'k', served: 'a/b', action: 'nudge' }, dir);

    const [decision, ...others] = readRecentEntries(10, dir);
    expect(decision!.confidence).toBe(DECISION.confidence);
    expect(others).toHaveLength(4);
    expect(others.every((record) => !('confidence' in record))).toBe(true);
  });

  it('reads an unversioned record as written', () => {
    writeFileSync(join(dir, DECISION_LOG_FILE), JSON.stringify({ ts: 1, dimension: 'plan', chosen: 'a/b' }) + '\n');
    expect(readRecentEntries(10, dir)[0]).toEqual({ ts: 1, dimension: 'plan', chosen: 'a/b' });
  });

  it('appends dedicated subagent tool-gap events', () => {
    appendSubagentGapSignal({ role: 'worker', tool: 'ctx_search', model: 'openai/gpt-5' }, dir);
    const entry = JSON.parse(readFileSync(join(dir, DECISION_LOG_FILE), 'utf8').trim());
    expect(entry.cause).toBe('self-healing-gap');
    expect(entry.gap.role).toBe('worker');
    expect(entry.gap.tool).toBe('ctx_search');
    expect(entry.served).toBe('openai/gpt-5');
  });
});

describe('decision log provenance', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ar-decisionlog-'));
  });
  afterEach(() => {
    setSessionFile(undefined);
    setDecisionLogBase(undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  const served = (over: Partial<Parameters<typeof appendDecision>[1]> = {}) => ({
    registryId: DECISION.chosen,
    viaFallback: false,
    accumulatedCost: 0.01,
    ...over,
  });

  const decision = (over: Partial<RoutingDecision> = {}): RoutingDecision => ({
    ...DECISION,
    ...over,
  });

  const readLastEntry = (base: string): Record<string, unknown> => {
    const path = join(base, DECISION_LOG_FILE);
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
  };

  it('writes routedDown and provenance counts additively', () => {
    appendDecision(
      decision({
        routedDown: true,
        provenanceCounts: {
          user: 3,
          'compaction-summary': 1,
          'branch-summary': 0,
          'synthetic-known': 0,
          assistant: 4,
          'tool-result': 7,
        },
      }),
      served(),
      dir,
    );

    const entry = readLastEntry(dir);
    expect(entry.routedDown).toBe(true);
    expect(entry.provenance).toEqual({
      user: 3,
      'compaction-summary': 1,
      'branch-summary': 0,
      'synthetic-known': 0,
      assistant: 4,
      'tool-result': 7,
    });
    expect(entry.cause).toBe('heuristic');
    expect(entry.routedUp).toBe(false);
  });
});

