/**
 * The outcome of a task, judged apart from the model's own checks.
 * Only an independent result verifies a task. A passing check that the
 * executor wrote or chose leaves the outcome `unverified`.
 */
import type { CheckReceipt } from './change-facts.js';

export type TaskOutcome = 'verified-pass' | 'verified-fail' | 'unverified' | 'environment-error';

/** A result from a check that the executor did not write or choose. */
export interface IndependentResult {
  source: 'hidden-oracle' | 'boundary-oracle' | 'audit';
  /** `error`: the check could not run, so it says nothing about the artifact. */
  verdict: 'pass' | 'fail' | 'error';
  /** Digest of the artifact that the check examined. */
  artifactDigest?: string;
}

export interface OutcomeInput {
  independent?: IndependentResult;
  /** Digest of the final artifact. A different digest means the check examined another version. */
  finalDigest?: string;
  /** The turn ended on a provider failure. This is not a capability failure. */
  providerFailure?: boolean;
  receipts?: readonly CheckReceipt[];
}

export function taskOutcome(input: OutcomeInput): TaskOutcome {
  const { independent } = input;
  if (independent) {
    if (independent.verdict === 'error') return 'environment-error';
    const changed = independent.artifactDigest !== undefined
      && input.finalDigest !== undefined
      && independent.artifactDigest !== input.finalDigest;
    if (changed) return 'unverified';
    return independent.verdict === 'pass' ? 'verified-pass' : 'verified-fail';
  }
  if (input.providerFailure) return 'environment-error';
  // A check that a user or project accepted can verify the artifact it ran against.
  const accepted = input.receipts?.findLast((receipt) => receipt.strength === 'contract' && receipt.freshness === 'current');
  if (accepted && accepted.verdict !== 'timeout') return accepted.verdict === 'pass' ? 'verified-pass' : 'verified-fail';
  return 'unverified';
}
