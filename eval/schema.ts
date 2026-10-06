/**
 * Schemas of the evaluation harness. The harness is outside the published
 * extension. It records what a model did on a task, so that a later report can
 * use the record again. A policy arm names an experiment. Only the execution
 * recipe identifies an execution.
 */
import type { Dimension } from '../extensions/types.ts';
import type { TaskOutcome } from '../extensions/routing/policy/outcome.ts';

// ── Policy arms and execution recipes ────────────────────────────────────

export interface LockedAssignment {
  selector: EpisodeSelector;
  /** The exact provider/model[:effort] that owned the episode. */
  candidateKey: string;
}

export type ForcedCandidate = string;

export interface EvaluationArm {
  /** A name for reports and provenance only. It is not part of a recipe. */
  id: string;
  policy:
    | { kind: 'current-auto' }
    | { kind: 'fixed-candidate'; candidateKey: string }
    | { kind: 'shadow-selector'; selectorVersion: string }
    | { kind: 'locked-prefix'; assignments: LockedAssignment[]; current?: ForcedCandidate };
  continuation: 'normal-policy' | 'fixed-anchor';
}

export interface ExecutionRecipeV1 {
  schema: 1;
  task: {
    id: string;
    baseRevision: string;
    publicFixtureDigest: string;
    environmentDigest: string;
  };
  runtime: {
    piRevision: string;
    pi8Commit: string;
    configDigest: string;
    benchmarkStoreDigest: string;
    candidateRegistryDigest: string;
    /** Digest of the normalized API or base-url identity. It has no secret material. */
    providerEndpointDigest: string;
    /** Optional digest of a connection or account identity. It has no secret material. */
    accountScopeDigest?: string;
    systemPromptDigest: string;
    toolsetDigest: string;
    generationParametersDigest: string;
  };
  execution:
    | { kind: 'whole-task'; policyDigest: string }
    | {
        kind: 'episode-probe';
        lockedAssignmentsDigest: string;
        targetEpisodeDigest: string;
        forcedCandidate: string;
        anchorContinuationDigest: string;
      };
}

/** `replicate` names an independent execution slot. It is not part of the recipe hash. */
export interface ExecutionRequestV1 {
  recipe: ExecutionRecipeV1;
  replicate: number;
}

export interface ExecutionSlotKey {
  recipeHash: string;
  replicate: number;
}

// ── Freshness and selection ──────────────────────────────────────────────

export type ReusePolicy =
  | { mode: 'exact-revision' }
  | { mode: 'opaque-model-max-age'; maxAgeMs: number }
  | { mode: 'historical-analysis' };

export interface EvidenceSelectionPolicy {
  reuse: ReusePolicy;
  /** The campaign sets this value before it opens held-out outcomes. */
  choose: 'exact-compatible' | 'freshest-compatible';
  /** ISO time. A report cannot select evidence that ended after this time. */
  cutoffAt: string;
}

export interface DeploymentProvenance {
  provider: string;
  modelId: string;
  servedEffort?: string;
  apiFamily?: string;
  /** Set only when the provider reports a revision. Do not derive it from benchmark data. */
  reportedRevision?: string;
  observedAt: string;
}

// ── Artifacts, status, evidence ──────────────────────────────────────────

export interface FinalArtifact {
  digest: string;
  path: string;
  /** False when the harness could not capture the external state. A change of grader then needs a new execution. */
  regradeable: boolean;
  stateKinds: Array<'git-worktree' | 'untracked-files' | 'database-dump' | 'service-snapshot'>;
}

export type ExecutionStatus =
  | 'completed'
  | 'task-budget-exhausted'
  | 'provider-error'
  | 'sandbox-error'
  | 'prefix-diverged';

export type GradeStatus = 'graded' | 'oracle-error';

export interface ExecutionProvenance {
  producedByRunId: string;
  producedByPiSession?: string;
  host?: string;
  startedAt: string;
  endedAt: string;
}

export interface UsageAttemptV1 {
  /** Stable identity of one terminal accounting event. Deduplication uses only this value. */
  usageEventId: string;
  attemptId: string;
  sequence: number;
  source: 'main-agent' | 'subagent';
  subagentId?: string;
  provider: string;
  modelId: string;
  /** Includes the measured or served effort when it applies. */
  candidateKey: string;
  servedEffort?: string;
  outcome: 'served' | 'provider-failure' | 'retry' | 'fallback' | 'budget-exhausted';
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  usageComplete: boolean;
  /** For a cross-check only. */
  providerReportedUsd?: number;
  executionPriceSnapshot?: {
    source: string;
    inputPer1M?: number;
    outputPer1M?: number;
    cacheReadPer1M?: number;
    cacheWritePer1M?: number;
  };
}

export interface RawExecutionUsage {
  attempts: UsageAttemptV1[];
  spendIncomplete: boolean;
}

export interface PriceView {
  registryPriceDigest: string;
  computedUsd?: number;
  complete: boolean;
}

export interface CompletedExecutionV1 {
  status: ExecutionStatus;
  provenance: ExecutionProvenance;
  deployment: DeploymentProvenance[];
  naturalDecision?: string;
  forcedCandidate?: string;
  servedTarget?: string;
  finalArtifact: FinalArtifact;
  boundaryArtifacts?: Array<{ selector: EpisodeSelector; artifact: FinalArtifact }>;
  decisionLogDigest: string;
  realizedTrajectoryDigest: string;
  realizedPrefixDigest?: string;
  realizedWorkspaceDigest: string;
  rawUsage: RawExecutionUsage;
  wallTimeMs: number;
  providerFailures: number;
  fallbackCount: number;
  capabilityEscalations: number;
}

export interface ExecutionEvidenceV1 extends CompletedExecutionV1 {
  executionId: string;
  slot: ExecutionSlotKey;
  recipeHash: string;
  recipe: ExecutionRecipeV1;
}

export interface GradeKeyV1 {
  executionId: string;
  oracleDigest: string;
  graderRuntimeDigest: string;
}

export type TargetVerdict = 'pass' | 'fail' | 'unknown';

export type TargetAttribution =
  | 'independently-sufficient'
  | 'independently-failed'
  | 'conditional-success-with-anchor-continuation'
  | 'downstream-repair-observed'
  | 'recovered-by-stronger-capability'
  | 'candidate-never-served'
  | 'prefix-diverged'
  | 'indeterminate'
  | 'not-applicable';

export interface EpisodeSelector {
  ordinal: number;
  dimension: Dimension;
  boundaryKind: 'entry-start' | 'context-handoff' | 'execution-contract' | 'submitter-return' | 'reopen';
  deliverable?: Dimension;
}

export interface GradeEvidenceV1 {
  gradeId: string;
  key: GradeKeyV1;
  status: GradeStatus;
  outcome: TaskOutcome;
  targetVerdict?: TargetVerdict;
  targetAttribution?: TargetAttribution;
  oracleElapsedMs?: number;
  summary?: Record<string, string | number | boolean>;
}

// ── Public task and private oracle ───────────────────────────────────────

export interface PublicTaskSpec {
  id: string;
  fixtureVersion: string;
  workspace: {
    source: string;
    baseRevision: string;
    sandbox: 'container' | 'os-isolated-process';
    imageDigest?: string;
  };
  userRequest: string;
  setupCommands?: string[];
  visibleChecks?: string[];
  budget: { wallTimeMs: number; maxProviderInvocations?: number };
}

export interface OracleResult {
  verdict: 'pass' | 'fail' | 'error';
  elapsedMs?: number;
  summary?: Record<string, string | number | boolean>;
}

export interface PrivateOracleSpec {
  taskId: string;
  oracleVersion: string;
  evaluate(finalArtifact: FinalArtifact): Promise<OracleResult>;
}
