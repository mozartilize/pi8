/** Read-only session-tree provenance. It cannot restore routing authority. */
export const SELECTION_ENTRY_TYPE = 'pi8-model-selection-v1';

export interface BranchEntryLike {
  type: string;
  id: string;
  parentId?: string | null;
  customType?: string;
  data?: unknown;
  message?: { role?: string; content?: unknown; timestamp?: unknown };
  provider?: string;
  modelId?: string;
}
export interface BranchReader {
  getBranch?: (fromId?: string) => readonly unknown[];
  getLeafId?: () => string | null;
}

export function readBranch(reader: BranchReader | undefined, fromId?: string): readonly unknown[] | undefined {
  try {
    if (typeof reader?.getBranch !== 'function') return undefined;
    return fromId == null ? reader.getBranch() : reader.getBranch(fromId);
  } catch { return undefined; }
}

export function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((block) => block && typeof block === 'object' && block.type === 'text')
    .map((block) => String(block.text ?? '')).join('\n');
}

/** Match by exact genuine-user timestamp, then prompt text, then the newest user entry. */
export function latestGenuineUserEntry(branch: readonly unknown[] | undefined, turn: { key?: string; promptText?: string } = {}): string | undefined {
  const entries = (branch ?? []).filter((raw): raw is BranchEntryLike => raw != null && typeof raw === 'object'
    && typeof (raw as BranchEntryLike).id === 'string' && (raw as BranchEntryLike).type === 'message'
    && (raw as BranchEntryLike).message?.role === 'user');
  const timestamp = turn.key ? Number(turn.key.split(':')[1]) : Number.NaN;
  if (Number.isFinite(timestamp)) {
    const byTime = entries.findLast((entry) => entry.message?.timestamp === timestamp);
    if (byTime) return byTime.id;
  }
  if (turn.promptText) {
    const byText = entries.findLast((entry) => messageText(entry.message?.content).trim() === turn.promptText);
    if (byText) return byText.id;
  }
  return entries.at(-1)?.id;
}
