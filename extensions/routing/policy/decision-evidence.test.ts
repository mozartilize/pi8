import { describe, expect, it } from 'vitest';
import type { CheckReceipt, FactsLog } from './change-facts.js';
import { decisionEvidence } from './decision-evidence.js';

const facts: FactsLog = {
  declared: { modify: 2, decisions: 1, answers: { ordering: 'Y' } },
  measured: { files: 2, directories: 1, existingLines: 198, fanIn: 3, coveringTests: 1, scoutFiles: 4, scoutRequests: 6 },
  shadow: { requirement: 0.6, band: 'standard', used: 0.5 },
};

describe('decisionEvidence', () => {
  it('copies the declared codes and measured counts', () => {
    expect(decisionEvidence('implement', facts)).toEqual({
      version: 1,
      dimension: 'implement',
      declaredFacts: facts.declared,
      files: 2,
      directories: 1,
      existingLines: 198,
      filenameFanIn: 3,
      coveringTestNames: 1,
      scoutFiles: 4,
      scoutRequests: 6,
    });
  });

  it('adds the strongest current check strength and the last verdict', () => {
    const receipt = { strength: 'partial', freshness: 'current' } as CheckReceipt;
    expect(decisionEvidence('plan', facts, { runsAfterHandoff: 0, beforeHandoff: 'fail', receipts: [receipt] }))
      .toMatchObject({ checkStrength: 'partial', lastCheckVerdict: 'fail' });
    expect(decisionEvidence('plan', facts, { runsAfterHandoff: 0, receipts: [{ ...receipt, freshness: 'stale' }] }).checkStrength).toBe('none');
  });

  it('adds the partial reads and the trajectory signals that the router observed', () => {
    const signals = [{ kind: 'failure-persistence', severity: 'warning', evidenceCount: 2 }] as const;
    expect(decisionEvidence('plan', facts, undefined, { partialReadCount: 2, trajectorySignals: [...signals] }))
      .toMatchObject({ partialReadCount: 2, trajectorySignals: signals });
    expect(decisionEvidence('plan', facts, undefined, { partialReadCount: 0, trajectorySignals: [] }).trajectorySignals).toBeUndefined();
  });
});
