/**
 * The information the router had at one routing boundary, before it chose the
 * next model. Logged with each accepted handoff and plan so that later
 * analysis can test which signals separate a weaker model's verified failure
 * from a verified pass. No field changes routing. Counts and codes only.
 */
import type { Dimension } from '../../types.js';
import type { CheckStrength, CheckVerdict, CheckVerdicts, FactCodes, FactsLog } from './change-facts.js';

export const DECISION_EVIDENCE_VERSION = 1;

export interface DecisionEvidenceV1 {
  version: typeof DECISION_EVIDENCE_VERSION;
  dimension: Dimension;
  declaredFacts: FactCodes;

  files?: number;
  directories?: number;
  existingLines?: number;
  fixCommits?: number;
  filenameFanIn?: number;
  coveringTestNames?: number;

  scoutFiles?: number;
  scoutRequests?: number;
  /** Reads of part of a file before the handoff. */
  partialReadCount?: number;
  /** Warning and severe trajectory signals at the boundary. */
  trajectorySignals?: Array<{ kind: string; severity: 'warning' | 'severe'; evidenceCount: number }>;

  /** The strongest current receipt. Undefined when no check ran. */
  checkStrength?: CheckStrength;
  lastCheckVerdict?: CheckVerdict;
}

const STRENGTH_ORDER: readonly CheckStrength[] = ['none', 'partial', 'contract'];

function strongestCurrent(checks: CheckVerdicts | undefined): CheckStrength | undefined {
  const receipts = checks?.receipts;
  if (!receipts?.length) return undefined;
  const current = receipts.filter((receipt) => receipt.freshness === 'current').map((receipt) => receipt.strength);
  return current.length === 0 ? 'none' : current.reduce((a, b) => STRENGTH_ORDER.indexOf(b) > STRENGTH_ORDER.indexOf(a) ? b : a);
}

export function decisionEvidence(
  dimension: Dimension,
  facts: FactsLog,
  checks?: CheckVerdicts,
  observed: Pick<DecisionEvidenceV1, 'partialReadCount' | 'trajectorySignals'> = {},
): DecisionEvidenceV1 {
  const { measured } = facts;
  const strength = strongestCurrent(checks);
  const lastCheck = checks?.afterHandoff ?? checks?.beforeHandoff;
  return {
    version: DECISION_EVIDENCE_VERSION,
    dimension,
    declaredFacts: facts.declared,
    ...(measured.files !== undefined ? { files: measured.files } : {}),
    ...(measured.directories !== undefined ? { directories: measured.directories } : {}),
    ...(measured.existingLines !== undefined ? { existingLines: measured.existingLines } : {}),
    ...(measured.fixCommits !== undefined ? { fixCommits: measured.fixCommits } : {}),
    ...(measured.fanIn !== undefined ? { filenameFanIn: measured.fanIn } : {}),
    ...(measured.coveringTests !== undefined ? { coveringTestNames: measured.coveringTests } : {}),
    ...(measured.scoutFiles !== undefined ? { scoutFiles: measured.scoutFiles } : {}),
    ...(measured.scoutRequests !== undefined ? { scoutRequests: measured.scoutRequests } : {}),
    ...(observed.partialReadCount !== undefined ? { partialReadCount: observed.partialReadCount } : {}),
    ...(observed.trajectorySignals?.length ? { trajectorySignals: observed.trajectorySignals } : {}),
    ...(strength ? { checkStrength: strength } : {}),
    ...(lastCheck ? { lastCheckVerdict: lastCheck } : {}),
  };
}
