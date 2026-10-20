/** Full-file read coverage belongs to one entry and one content version. */
import type { ExtensionContext, ToolResultEvent } from '@earendil-works/pi-coding-agent';
import { basename, isAbsolute, relative, sep } from 'node:path';
import { resolveToolPath } from '../routing/policy/execution-contract.js';
import {
  contentLineCount, fingerprintFile, matchedLineRanges, readLineRange, ReadCoverage, resultText,
} from '../routing/context/grounding.js';
import { latestGenuineUserEntry, readBranch } from '../routing/context/persistence.js';
import type { RouterSession } from './router-session-state.js';
import { refreshSourceEvidence } from './entry-evidence.js';

export function insideCwd(cwd: string, path: string): { abs: string; rel: string } | undefined {
  const abs = resolveToolPath(cwd, path.trim());
  const rel = relative(cwd, abs);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return { abs, rel: rel.split(sep).join('/') };
}

export function currentSourceEntry(
  ctx: Pick<ExtensionContext, 'sessionManager'> | undefined,
  session: RouterSession,
): string | undefined {
  return session.getWorkPhaseState()?.sourceEntryId
    ?? latestGenuineUserEntry(readBranch(ctx?.sessionManager))
    ?? session.getCachedIntent()?.key;
}

/** Arguments select possible paths; only the returned file lines establish read coverage. */
export async function observeContextGrounding(
  event: Pick<ToolResultEvent, 'toolName' | 'input' | 'content' | 'details' | 'isError'>,
  ctx: Pick<ExtensionContext, 'cwd' | 'sessionManager'>,
  session: RouterSession,
): Promise<void> {
  try {
    const evidence = session.getWorkPhaseState()?.evidence;
    if (event.isError || !ctx.cwd || !evidence || evidence.routingEpoch !== session.getRoutingEpoch()) return;
    const stillCurrent = () => session.getWorkPhaseState()?.evidence === evidence
      && evidence.routingEpoch === session.getRoutingEpoch()
      && (latestGenuineUserEntry(readBranch(ctx.sessionManager)) ?? evidence.entryId) === evidence.entryId;
    if (!stillCurrent()) return;
    const raw = (event.input as { path?: unknown } | undefined)?.path;
    const blocks = Array.isArray(event.content) ? event.content : [];
    const text = blocks.filter((b): b is { type: 'text'; text: string } =>
      b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
    const native = ['read', 'write', 'edit'].includes(event.toolName);
    const haystack = `${JSON.stringify(event.input ?? null)}\n${text}`;
    const paths = native && typeof raw === 'string' ? [raw]
      : evidence.referencedPaths.filter((path) => haystack.includes(basename(path)));
    for (const candidate of [...new Set(paths)].slice(0, 24)) {
      const path = insideCwd(ctx.cwd, candidate);
      if (!path || !evidence.referencedPaths.includes(path.rel)) continue;
      const file = await fingerprintFile(path.abs);
      if (!stillCurrent()) return;
      if (!file) continue;
      if (event.toolName === 'edit' || event.toolName === 'write') {
        // A write cannot establish that an unread source was inspected.
        if (evidence.observedFiles.has(path.rel)) evidence.observedFiles.set(path.rel, { sha256: file.sha256 });
        continue;
      }
      const ranges = event.toolName === 'read'
        ? [readLineRange(event.input as { offset?: unknown }, event.details, resultText(event.content), file.text)]
        : matchedLineRanges(text, file.text);
      let coverage = evidence.readCoverage.get(path.rel);
      if (coverage?.sha256 !== file.sha256) {
        coverage = new ReadCoverage(file.sha256, contentLineCount(file.text));
        evidence.readCoverage.set(path.rel, coverage);
      }
      for (const range of ranges) {
        if (range && coverage.add(range)) evidence.observedFiles.set(path.rel, { sha256: file.sha256 });
      }
    }
    await refreshSourceEvidence(session);
  } catch {
    // A failed observation leaves the source obligation pending.
  }
}
