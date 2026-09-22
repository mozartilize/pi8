import { stripThinkingSuffix } from './subagents.js';

export interface SubagentResultRow {
  index?: number;
  agent?: string;
  model?: string;
  finalOutput?: string;
  exitCode?: number;
  error?: string;
  modelAttempts: Array<{ model?: string; success?: boolean; error?: string }>;
  /**
   * Terminal usage for one foreground child. `cost` is pi-subagents'
   * provider-reported billing and is kept only as a cross-check — spend
   * accounting reprices the token counts at registry rates so parent turns
   * and children stay on one comparable basis.
   */
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
  };
}

function parseUsage(value: unknown): SubagentResultRow['usage'] {
  if (!isRecord(value)) return undefined;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    input: num(value.input),
    output: num(value.output),
    cacheRead: num(value.cacheRead),
    cacheWrite: num(value.cacheWrite),
    cost: num(value.cost),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Defensively parse the `details.results` array from a `subagent` tool_result.
 * Unknown or malformed rows and fields are dropped rather than throwing.
 */
export function parseSubagentResultRows(details: unknown): SubagentResultRow[] {
  const container = isRecord(details) ? details : {};
  const values = container.results;
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => {
    if (!isRecord(value)) return [];
    return [
      {
        index: typeof value.index === 'number' ? value.index : undefined,
        agent: typeof value.agent === 'string' ? value.agent : undefined,
        model: typeof value.model === 'string' ? value.model : undefined,
        finalOutput: typeof value.finalOutput === 'string' ? value.finalOutput : undefined,
        exitCode: typeof value.exitCode === 'number' ? value.exitCode : undefined,
        error: typeof value.error === 'string' ? value.error : undefined,
        usage: parseUsage(value.usage),
        modelAttempts: Array.isArray(value.modelAttempts)
          ? value.modelAttempts
              .filter(isRecord)
              .map((item) => ({
                model: typeof item.model === 'string' ? item.model : undefined,
                success: typeof item.success === 'boolean' ? item.success : undefined,
                error: typeof item.error === 'string' ? item.error : undefined,
              }))
          : [],
      },
    ];
  });
}

export function isFailedResult(row: SubagentResultRow): boolean {
  return (typeof row.exitCode === 'number' && row.exitCode !== 0) || typeof row.error === 'string';
}

/**
 * Return the concrete `provider/id` models that failed for one result row,
 * stripping thinking-level suffixes. Empty for successful rows.
 */
export function failedModelsForRow(row: SubagentResultRow): string[] {
  if (!isFailedResult(row)) return [];
  const failed = new Set<string>();
  for (const attempt of row.modelAttempts ?? []) {
    if (typeof attempt.model === 'string' && attempt.success !== true) {
      failed.add(stripThinkingSuffix(attempt.model));
    }
  }
  if (failed.size === 0 && typeof row.model === 'string') {
    failed.add(stripThinkingSuffix(row.model));
  }
  return [...failed];
}

interface TextPartLike {
  type?: unknown;
  text?: unknown;
}

/**
 * Join all observable text from a subagent tool_result for downstream gap
 * detection: event content plus each parsed row's finalOutput and error.
 */
export function collectSubagentResultText(event: {
  content?: unknown;
  details?: unknown;
} | null | undefined): string {
  const parts: string[] = [];
  const ev = event ?? {};
  if (Array.isArray(ev.content)) {
    for (const part of ev.content) {
      const tp = part as TextPartLike;
      if (tp.type === 'text' && typeof tp.text === 'string') parts.push(tp.text);
    }
  }
  for (const row of parseSubagentResultRows(ev.details)) {
    if (typeof row.finalOutput === 'string') parts.push(row.finalOutput);
    if (typeof row.error === 'string') parts.push(row.error);
  }
  return parts.join('\n');
}
