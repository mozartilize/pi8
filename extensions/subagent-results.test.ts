import { describe, expect, it } from 'vitest';

import {
  collectSubagentResultText,
  failedModelsForRow,
  parseSubagentResultRows,
} from './subagent-results.js';

describe('parseSubagentResultRows', () => {
  it('returns [] for non-row details', () => {
    expect(parseSubagentResultRows(undefined)).toEqual([]);
    expect(parseSubagentResultRows(null)).toEqual([]);
    expect(parseSubagentResultRows({})).toEqual([]);
    expect(parseSubagentResultRows({ results: 'not-an-array' })).toEqual([]);
  });

  it('parses a minimal row', () => {
    const rows = parseSubagentResultRows({
      results: [{ index: 0, agent: 'worker', model: 'provider/fast', exitCode: 0 }],
    });
    expect(rows).toEqual([
      {
        index: 0,
        agent: 'worker',
        model: 'provider/fast',
        finalOutput: undefined,
        exitCode: 0,
        error: undefined,
        modelAttempts: [],
      },
    ]);
  });

  it('parses failed modelAttempts', () => {
    const rows = parseSubagentResultRows({
      results: [
        {
          index: 0,
          exitCode: 1,
          modelAttempts: [
            { model: 'provider/fast:high', success: false },
            { model: 'provider/fast:high', success: false },
          ],
        },
      ],
    });
    expect(rows[0]?.modelAttempts).toEqual([
      { model: 'provider/fast:high', success: false },
      { model: 'provider/fast:high', success: false },
    ]);
  });
});

describe('failedModelsForRow', () => {
  it('returns [] for a successful row', () => {
    expect(
      failedModelsForRow({
        index: 0,
        exitCode: 0,
        model: 'provider/fast',
        modelAttempts: [{ model: 'provider/fast', success: false }],
      }),
    ).toEqual([]);
  });

  it('deduplicates failed attempted models and strips thinking suffixes', () => {
    const row = {
      index: 2,
      exitCode: 1,
      model: 'alpha/fallback:high',
      error: 'spawn failed',
      modelAttempts: [
        { model: 'alpha/first:max', success: false },
        { model: 'alpha/first:max', success: false },
        { model: 'alpha/fallback:high', success: false },
      ],
    };
    expect(failedModelsForRow(row)).toEqual(['alpha/first', 'alpha/fallback']);
  });

  it('falls back to the row model when attempts are absent', () => {
    expect(
      failedModelsForRow({
        index: 0,
        exitCode: 1,
        model: 'provider/fast:high',
        modelAttempts: [],
      }),
    ).toEqual(['provider/fast']);
  });
});

describe('collectSubagentResultText', () => {
  it('collects content, child final output, and child errors for observability', () => {
    const text = collectSubagentResultText({
      content: [{ type: 'text', text: 'summary' }],
      details: {
        results: [
          { finalOutput: 'missing tool: web_search', error: 'tool unavailable' },
        ],
      },
    });
    expect(text).toContain('summary');
    expect(text).toContain('missing tool: web_search');
    expect(text).toContain('tool unavailable');
  });

  it('tolerates malformed inputs', () => {
    expect(collectSubagentResultText(null as unknown as any)).toBe('');
    expect(collectSubagentResultText({ content: 'not-an-array' } as any)).toBe('');
  });
});
