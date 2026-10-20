import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { extractPromptAnchors } from '../routing/context/anchors.js';
import { fingerprintFile, GROUNDING_MAX_BYTES, ReadCoverage } from '../routing/context/grounding.js';
import { latestGenuineUserEntry, readBranch, type BranchReader } from '../routing/context/persistence.js';
import type { RouterSession } from './router-session-state.js';
import type { SourceEvidenceCounts } from '../types.js';

export interface EntryEvidenceState {
  entryId: string;
  routingEpoch: number;
  cwd: string;
  referencedPaths: string[];
  observedFiles: Map<string, { sha256: string }>;
  readCoverage: Map<string, ReadCoverage>;
}

/** Only explicit references in the current genuine entry create source obligations. */
export function createEntryEvidence(
  turn: { key: string; promptText: string },
  routingEpoch: number,
  cwd: string,
  sessionManager?: BranchReader,
): EntryEvidenceState {
  return {
    entryId: latestGenuineUserEntry(readBranch(sessionManager), turn) ?? turn.key,
    routingEpoch,
    cwd,
    referencedPaths: extractPromptAnchors(turn.promptText, { cwd })
      .filter((anchor) => anchor.kind === 'path' && anchor.mention === 'at').map((anchor) => anchor.value),
    observedFiles: new Map(),
    readCoverage: new Map(),
  };
}

export interface SourceEvidenceStatus extends SourceEvidenceCounts {
  unmet: string[];
}

export function sourceEvidenceCounts(status: SourceEvidenceStatus): SourceEvidenceCounts {
  return { required: status.required, fresh: status.fresh, partial: status.partial, oversized: status.oversized };
}

/** Missing files and directory scopes owe no full-file read. Unreadable files remain unmet. */
export async function sourceEvidenceStatus(evidence: EntryEvidenceState): Promise<SourceEvidenceStatus> {
  const result: SourceEvidenceStatus = { required: evidence.referencedPaths.length, fresh: 0, partial: 0, oversized: 0, unmet: [] };
  for (const path of evidence.referencedPaths) {
    const abs = join(evidence.cwd, path);
    let info;
    try {
      info = await stat(abs);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
    }
    if (info?.isDirectory()) continue;
    if (info?.isFile() && info.size > GROUNDING_MAX_BYTES) {
      result.oversized += 1;
      continue;
    }
    const file = await fingerprintFile(abs);
    if (file && evidence.observedFiles.get(path)?.sha256 === file.sha256) {
      result.fresh += 1;
    } else {
      result.unmet.push(path);
      if (file && evidence.readCoverage.get(path)?.sha256 === file.sha256) result.partial += 1;
    }
  }
  return result;
}

/** Publish only while the same entry and routing epoch still own the evidence. */
export async function refreshSourceEvidence(session: RouterSession): Promise<SourceEvidenceStatus | undefined> {
  const state = session.getWorkPhaseState();
  const evidence = state?.evidence;
  if (!evidence) return undefined;
  const status = await sourceEvidenceStatus(evidence);
  const live = session.getWorkPhaseState();
  if (live?.evidence !== evidence || session.getRoutingEpoch() !== evidence.routingEpoch) return undefined;
  const pending = status.unmet.length > 0;
  if (live.sourceEvidencePending !== pending) session.commitWorkPhaseState({ ...live, sourceEvidencePending: pending });
  return status;
}
