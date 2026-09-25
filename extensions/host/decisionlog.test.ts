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
  appendAssessmentMetric,
  appendSubagentGapSignal,
  readRecentEntries,
  setDecisionLogBase,
  DECISION_LOG_FILE,
} from './decisionlog.js';
import { ASSESSMENT_PROMPT_VERSION } from '../routing/consult/assessment-prompt.js';
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
    expect(entry.escalation).toBeUndefined();
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
    expect(entry.escalation).toBeUndefined();
    expect(entry.contextPressure.usageRatio).toBe(0.71);
    expect(entry.candidateDiagnostics).toEqual([
      { candidateKey: 'cheap/model', excludedReason: 'promoted' },
      { candidateKey: 'weak/model', excludedReason: 'below-task-floor' },
    ]);
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

describe('assessment telemetry', () => {
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

  it('writes routedDown, fallbackReason and provenance counts additively', () => {
    appendDecision(
      decision({
        routedDown: true,
        fallbackReason: 'expiry',
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
    expect(entry.fallbackReason).toBe('expiry');
    expect(entry.provenance).toEqual({
      user: 3,
      'compaction-summary': 1,
      'branch-summary': 0,
      'synthetic-known': 0,
      assistant: 4,
      'tool-result': 7,
    });
    // Nothing pre-existing changed meaning.
    expect(entry.cause).toBe('heuristic');
    expect(entry.routedUp).toBe(false);
  });

  it('stamps the prompt version when an assessment ran', () => {
    appendDecision(
      decision({
        assessment: {
          kind: 'lightweight',
          complexity: 'trivial',
          scope: 'bounded',
          compound: false,
          confidence: 'high',
          reasoning: 'bounded extraction',
          model: 'test/assessor',
          ms: 420,
          usage: { input: 900, output: 30 },
          costUsd: 0.00042,
        },
      }),
      served(),
      dir,
    );

    const entry = readLastEntry(dir);
    expect(entry.assessmentPromptVersion).toBe(ASSESSMENT_PROMPT_VERSION);
    expect((entry.assessment as { confidence?: string })?.confidence).toBe('high');
    expect((entry.assessment as { costUsd?: number })?.costUsd).toBeCloseTo(0.00042, 8);
  });

  it('omits assessment fields entirely when none ran', () => {
    appendDecision(decision({}), served(), dir);
    const entry = readLastEntry(dir);
    expect(entry.assessment).toBeUndefined();
    expect(entry.assessmentPromptVersion).toBeUndefined();
  });
});

describe('appendAssessmentMetric', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ar-decisionlog-'));
  });
  afterEach(() => {
    setSessionFile(undefined);
    setDecisionLogBase(undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a joinable counterfactual record without touching decisions', () => {
    appendAssessmentMetric(
      {
        intentKey: '3:1717:abc12345:0',
        heuristicDimension: 'gather',
        counterfactualDimension: 'lightweight',
        assessment: {
          kind: 'lightweight',
          complexity: 'trivial',
          scope: 'bounded',
          compound: false,
          confidence: 'high',
          reasoning: 'bounded extraction',
          model: 'test/assessor',
          ms: 380,
          usage: { input: 800, output: 24 },
          costUsd: 0.0003,
        },
      },
      dir,
    );

    const entry = JSON.parse(readFileSync(join(dir, DECISION_LOG_FILE), 'utf8').trim());
    expect(entry.kind).toBe('assessment-metric');
    expect(entry.intentKey).toBe('3:1717:abc12345:0');
    expect(entry.heuristicDimension).toBe('gather');
    expect(entry.counterfactualDimension).toBe('lightweight');
    expect(entry.dimensionDelta).toBe(-1);
    expect(entry.assessmentPromptVersion).toBe(ASSESSMENT_PROMPT_VERSION);
  });

  it('records a positive delta for an upward counterfactual', () => {
    appendAssessmentMetric(
      {
        intentKey: 'k2',
        heuristicDimension: 'lightweight',
        counterfactualDimension: 'gather',
        assessment: {
          kind: 'gather',
          complexity: 'routine',
          scope: 'open-ended',
          compound: false,
          confidence: 'high',
          reasoning: 'broader scope',
          model: 'test/assessor',
          ms: 300,
          usage: { input: 500, output: 10 },
          costUsd: 0.0001,
        },
      },
      dir,
    );
    const entry = JSON.parse(readFileSync(join(dir, DECISION_LOG_FILE), 'utf8').trim());
    expect(entry.dimensionDelta).toBe(1);
  });

  it('records an unavailable assessment with its fallbackReason', () => {
    appendAssessmentMetric(
      { intentKey: 'k', heuristicDimension: 'gather', fallbackReason: 'expiry' },
      dir,
    );
    const entry = JSON.parse(readFileSync(join(dir, DECISION_LOG_FILE), 'utf8').trim());
    expect(entry.kind).toBe('assessment-metric');
    expect(entry.fallbackReason).toBe('expiry');
    expect(entry.assessment).toBeUndefined();
    // The version stamp is written regardless of verdict availability.
    expect(entry.assessmentPromptVersion).toBe(ASSESSMENT_PROMPT_VERSION);
  });

  it('never throws when the log path is unwritable', () => {
    // A regular file in place of a directory fails with ENOTDIR immediately;
    // /proc/nonexistent is avoided because filesystem calls under /proc can
    // block indefinitely on some kernels.
    const blocker = join(dir, 'blocker.txt');
    writeFileSync(blocker, 'x', 'utf8');
    expect(() =>
      appendAssessmentMetric({ intentKey: 'k', heuristicDimension: 'gather' }, join(blocker, 'sub')),
    ).not.toThrow();
  });
});

