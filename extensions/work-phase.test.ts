import { describe, expect, it } from 'vitest';
import {
  capabilityBandFor,
  deriveInitialPhase,
  floorForBand,
  scoringPolicyForState,
  terminalRequirement,
} from './work-phase.js';
import type { TerminalAssessment } from './types.js';

const terminal = (over: Partial<TerminalAssessment> = {}): TerminalAssessment => ({
  kind: 'implement',
  complexity: 'hard',
  scope: 'open-ended',
  compound: true,
  confidence: 'high',
  discountEligible: true,
  ...over,
});

describe('terminal capability math', () => {
  it('implements the pinned requirement formula and bands', () => {
    expect(terminalRequirement(terminal())).toBeCloseTo(0.775);
    expect(capabilityBandFor(terminalRequirement(terminal()))).toBe('frontier');
    expect(capabilityBandFor(terminalRequirement(terminal({ complexity: 'moderate' })))).toBe('strong');
    expect(floorForBand('standard')).toBe(0.45);
    expect(floorForBand('strong')).toBe(0.70);
    expect(floorForBand('frontier')).toBe(0.85);
  });

  it('engages inspect only with explicit non-defaulted evidence', () => {
    expect(deriveInitialPhase(terminal(), 'frontier', {
      resolvedDimension: 'implement',
      capabilityRepickActive: false,
    })).toEqual({ phase: 'inspect', phaseReason: 'explicit-compound-inspect', multiWorkEngaged: true });

    expect(deriveInitialPhase(terminal({ discountEligible: false }), 'frontier', {
      resolvedDimension: 'implement',
      capabilityRepickActive: false,
    }).multiWorkEngaged).toBe(false);
  });
});
