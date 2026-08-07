import type { DecisionLogEntry } from './decisionlog.js';

export interface ToolGapSummary {
  role: string;
  tool: string;
  observations: number;
  withWorkaround: number;
  lastSeenTs: number;
  strength: number;
}

/**
 * Read-only detector over decision-log entries (v2 substrate).
 *
 * Strength is a bounded confidence proxy combining recurrence and recency.
 */
export function detectToolGaps(entries: readonly DecisionLogEntry[]): ToolGapSummary[] {
  const byKey = new Map<string, ToolGapSummary>();
  const now = Date.now();

  for (const entry of entries) {
    if (entry.cause !== 'self-healing-gap' || !entry.gap?.tool) continue;
    const role = entry.gap.role ?? 'unknown';
    const tool = entry.gap.tool;
    const key = `${role}::${tool}`;
    const current = byKey.get(key) ?? {
      role,
      tool,
      observations: 0,
      withWorkaround: 0,
      lastSeenTs: 0,
      strength: 0,
    };
    current.observations += 1;
    if (entry.gap.workaroundTool) current.withWorkaround += 1;
    current.lastSeenTs = Math.max(current.lastSeenTs, entry.ts ?? 0);
    byKey.set(key, current);
  }

  const out = [...byKey.values()].map((s) => {
    const ageHours = Math.max(0, (now - s.lastSeenTs) / (1000 * 60 * 60));
    const recency = 1 / (1 + ageHours / 24);
    const freq = Math.min(1, s.observations / 5);
    const workaround = s.observations > 0 ? s.withWorkaround / s.observations : 0;
    return {
      ...s,
      strength: Number((0.5 * freq + 0.3 * recency + 0.2 * workaround).toFixed(3)),
    };
  });

  return out.sort((a, b) => b.strength - a.strength || b.observations - a.observations);
}

/**
 * Common English words that a loose regex can wrongly capture as a "tool
 * name" from phrases like "the tool is not available". Excluded from results.
 */
const MISSING_TOOL_STOPWORDS = new Set([
  'tool',
  'the',
  'a',
  'an',
  'is',
  'was',
  'not',
  'named',
  'this',
  'that',
  'it',
  'no',
]);

/**
 * Best-effort extraction of tool names a subagent reported as unavailable,
 * from free-form error text. Read-only heuristic feeding the gap detector; a
 * miss just means no signal, never a thrown error or a blocked spawn.
 *
 * Recognizes the common phrasings pi/subagents surface:
 *  - `tool "X" not available` / `tool X not found` / `tool named X unknown`
 *  - `no tool named X` / `unknown tool: X`
 *  - `does not have access to tool X` / `X tool is not available`
 */
export function extractMissingTools(text: string): string[] {
  if (!text) return [];
  const id = `["'\`]?([a-z0-9_.-]+)["'\`]?`;
  const patterns = [
    new RegExp(`tool(?:\\s+named)?\\s+${id}[^.\\n]{0,80}?(?:not available|not found|unknown|no access)`, 'gi'),
    new RegExp(`(?:no|unknown)\\s+tool(?:\\s+named)?[:\\s]+${id}`, 'gi'),
    new RegExp(`access to (?:the )?tool\\s+${id}`, 'gi'),
    new RegExp(`${id}\\s+tool\\s+(?:is\\s+)?(?:not available|not found|unknown)`, 'gi'),
  ];
  const found = new Set<string>();
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const name = m[1];
      // Guard against captures that are just the surrounding English words
      // ("the tool is not available" must not yield "is"/"the").
      if (name && !MISSING_TOOL_STOPWORDS.has(name)) found.add(name);
    }
  }
  return [...found];
}
