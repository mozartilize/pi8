import { convertToLlm } from '@earendil-works/pi-coding-agent';

// Pi owns summary formatting. Derive its markers through the public converter.
const sentinel = 'pi8-summary-marker-sentinel';
const [compaction, branch] = convertToLlm([
  { role: 'compactionSummary', summary: sentinel, tokensBefore: 0, timestamp: 0 },
  { role: 'branchSummary', summary: sentinel, fromId: 'pi8-marker', timestamp: 0 },
]);

function markers(message: unknown): [string, string] {
  const content = (message as { content?: Array<{ type: string; text?: string }> })?.content;
  const text = content?.find(block => block.type === 'text')?.text;
  const offset = text?.indexOf(sentinel) ?? -1;
  if (!text || offset <= 0) return ['', ''];
  return [text.slice(0, offset), text.slice(offset + sentinel.length)];
}

export const [COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX] = markers(compaction);
export const [BRANCH_SUMMARY_PREFIX, BRANCH_SUMMARY_SUFFIX] = markers(branch);
