/**
 * Which stored executions a report can use. A hosted model name can point to a
 * new deployment, so old evidence can be too old for an activation claim. The
 * rule is the same for a pass and for a fail. It reads the deployment and the
 * time. It does not read the outcome.
 */
import type { EvidenceSelectionPolicy, ExecutionEvidenceV1 } from './schema.ts';

/** True when every deployment reports a revision. The evidence then names the exact model version. */
export function hasExactRevision(evidence: ExecutionEvidenceV1): boolean {
  return evidence.deployment.length > 0 && evidence.deployment.every((item) => item.reportedRevision !== undefined);
}

/**
 * An operational failure (`provider-error` or `sandbox-error`) never fills a
 * slot. Each other status is evidence.
 */
export function isEvidenceStatus(status: ExecutionEvidenceV1['status']): boolean {
  return status !== 'provider-error' && status !== 'sandbox-error';
}

export function isCompatible(evidence: ExecutionEvidenceV1, policy: EvidenceSelectionPolicy, now: number): boolean {
  if (!isEvidenceStatus(evidence.status)) return false;
  if (Date.parse(evidence.provenance.endedAt) > Date.parse(policy.cutoffAt)) return false;
  switch (policy.reuse.mode) {
    case 'historical-analysis':
      return true;
    case 'exact-revision':
      return hasExactRevision(evidence);
    case 'opaque-model-max-age': {
      if (hasExactRevision(evidence)) return true;
      const observed = Math.min(...evidence.deployment.map((item) => Date.parse(item.observedAt)));
      return Number.isFinite(observed) && now - observed <= policy.reuse.maxAgeMs;
    }
  }
}

/**
 * Choose one generation for a slot. `exact-compatible` chooses the oldest
 * compatible generation. `freshest-compatible` chooses the newest one.
 */
export function chooseGeneration(
  compatible: readonly ExecutionEvidenceV1[],
  policy: EvidenceSelectionPolicy,
): ExecutionEvidenceV1 | undefined {
  const ordered = [...compatible].sort((a, b) => Date.parse(a.provenance.endedAt) - Date.parse(b.provenance.endedAt)
    || (a.executionId < b.executionId ? -1 : 1));
  return policy.choose === 'freshest-compatible' ? ordered.at(-1) : ordered[0];
}
