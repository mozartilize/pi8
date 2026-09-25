/**
 * Investigation → planning/review handoff: the phase boundary before an
 * entry's plan or review.
 *
 * An entry that owes a plan or review (or a compound implementation, which
 * needs a decided plan first) starts as an investigation, routed as
 * `gather`. When the investigating model has the evidence, it calls
 * `hand_off_investigation` with its findings and a rubric of the reasoning
 * left; the router values that rubric plus the facts it measures itself, and
 * routes the rest of the entry as `plan` or `review` at the resulting
 * minimum. The boundary releases the incumbent minimums once: the first
 * invocation that serves the new phase owns it.
 *
 * Pure state transitions only: no I/O, no registry or session access.
 */
import { dirname } from 'node:path';
import type { DecisionCause, Dimension, ReasoningEvidence, ReasoningHandoffMeta } from '../../types.js';
import type { WorkPhaseState } from './work-phase.js';

export const INVESTIGATION_HANDOFF_TOOL = 'hand_off_investigation';

/** Most files a handoff is measured on; every weighted fact saturates well below it. */
export const MAX_EVIDENCE_PATHS = 20;

/** Evidence of a handoff that no file backs: its reasoning rests on the conversation. */
export const CONVERSATION_EVIDENCE: ReasoningEvidence = { applicable: false, files: 0, directories: 0 };

/**
 * Whether the entry owes an investigation before its deliverable: a plan, a
 * review, or a compound implementation (investigate, then change), which
 * needs a decided plan before its change.
 */
export function investigationOwed(state: WorkPhaseState | undefined): boolean {
  const deliverable = state?.deliverable;
  if (deliverable === 'plan' || deliverable === 'review') return true;
  return deliverable === 'implement' && state!.terminal.compound && state!.terminal.confidence !== 'low';
}

/** The reasoning phase a handoff leads to. */
export function reasoningTarget(deliverable: Dimension | undefined): 'plan' | 'review' {
  return deliverable === 'review' ? 'review' : 'plan';
}

export interface EntryPhase {
  dimension: Dimension;
  /** Present when the phase, not the classification, sets the task type. */
  cause?: Extract<DecisionCause, 'investigation' | 'investigation-handoff'>;
}

/**
 * The entry's routed phase. `bypass` is a pinned model: it serves the
 * deliverable directly, with no investigation before it.
 */
export function entryPhase(state: WorkPhaseState | undefined, base: Dimension, bypass: boolean): EntryPhase {
  if (state?.reasoningHandoff) return { dimension: state.reasoningHandoff.target, cause: 'investigation-handoff' };
  if (!bypass && investigationOwed(state)) return { dimension: 'gather', cause: 'investigation' };
  return { dimension: base };
}

/** Record an accepted handoff; the boundary stays pending until a model serves it. */
export function acceptInvestigationHandoff(
  state: WorkPhaseState,
  handoff: Omit<ReasoningHandoffMeta, 'id' | 'pending' | 'owner'>,
): WorkPhaseState {
  if (state.reasoningHandoff) return state;
  return { ...state, reasoningHandoff: { ...handoff, id: state.intentKey, pending: true } };
}

/** The first invocation that served the reasoning phase owns it. */
export function serveReasoningHandoff(state: WorkPhaseState, owner: string): WorkPhaseState {
  const handoff = state.reasoningHandoff;
  if (!handoff?.pending) return state;
  return { ...state, reasoningHandoff: { ...handoff, pending: false, owner } };
}

/** Remember a path the investigation read, most recent first. */
export function noteInvestigationRead(state: WorkPhaseState, path: string): WorkPhaseState {
  if (state.reasoningHandoff) return state;
  const readPaths = [path, ...(state.readPaths ?? []).filter((p) => p !== path)].slice(0, MAX_EVIDENCE_PATHS);
  return { ...state, readPaths };
}

/**
 * Files a handoff is measured on: the declared files first, then the most
 * recently read ones, deduplicated. Reads count even when the model declares
 * none, so leaving `files` empty cannot switch measurement off.
 */
export function evidencePaths(declared: readonly string[], readPaths: readonly string[] = []): string[] {
  return [...new Set([...declared, ...readPaths])].slice(0, MAX_EVIDENCE_PATHS);
}

/** Router-counted shape of an evidence set; I/O facts are added by the caller. */
export function evidenceShape(paths: readonly string[]): Pick<ReasoningEvidence, 'applicable' | 'files' | 'directories'> {
  return {
    applicable: paths.length > 0,
    files: paths.length,
    directories: new Set(paths.map((path) => dirname(path))).size,
  };
}
