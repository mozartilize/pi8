/**
 * Verifier results of an entry, before and after its accepted handoff. A
 * finished step whose checks passed can still be wrong; these verdicts, with
 * the router-measured check strength, are what that is judged against.
 */
import { noteCheckVerdict, type CheckVerdict } from '../routing/policy/change-facts.js';
import { actionFromTool, contentText, cycleFromToolResult, isVerifier, type ToolCycleInput } from '../routing/struggle/fingerprints.js';
import type { RouterSession } from './router-session-state.js';

/** Pi's shell tool ends the output of a command that ran past its timeout with this status. */
const TIMED_OUT = /Command timed out after \d+ seconds\s*$/;

/** The verdict of a verifier run; undefined for any other tool result. */
export function checkVerdict(event: ToolCycleInput, invocation: number): CheckVerdict | undefined {
  if (!isVerifier(actionFromTool(event.toolName, event.input))) return undefined;
  if (event.isError === true && TIMED_OUT.test(contentText(event.content))) return 'timeout';
  const hint = cycleFromToolResult(event, invocation).progressHint;
  return hint.isError || hint.failureSignature ? 'fail' : 'pass';
}

/** Record a verifier result for the entry that the current invocation serves. */
export function observeCheckVerdict(event: ToolCycleInput, session: RouterSession): void {
  try {
    const state = session.getWorkPhaseState();
    const last = session.getLastDecision();
    if (!state || !last || last.intentKey !== state.intentKey) return;
    const verdict = checkVerdict(event, state.providerInvocation);
    if (!verdict) return;
    session.commitWorkPhaseState({
      ...state,
      checkVerdicts: noteCheckVerdict(state.checkVerdicts, verdict, state.changeFacts !== undefined),
    });
  } catch {
    // Check bookkeeping must never change a tool result.
  }
}
