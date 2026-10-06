/**
 * Verifier results of an entry, before and after its accepted handoff. A
 * finished step whose checks passed can still be wrong; these verdicts, with
 * the router-measured check strength, are what that is judged against.
 */
import { noteCheckVerdict, type CheckVerdict } from '../routing/policy/change-facts.js';
import { addReceipt, buildReceipt, staleReceipts } from '../routing/policy/check-receipt.js';
import { isMutationCall } from '../routing/policy/mutation-detector.js';
import { actionFromTool, contentText, cycleFromToolResult, fingerprint, isVerifier, type ToolCycleInput } from '../routing/struggle/fingerprints.js';
import type { Exec } from './execution-contract-tool.js';
import type { RouterSession } from './router-session-state.js';
import { snapshotWorkspace } from './workspace-snapshot.js';

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
    // A change to the workspace after a check run invalidates that run's receipt.
    if (state.checkVerdicts && isMutationCall(event.toolName, event.input)) {
      const stale = staleReceipts(state.checkVerdicts);
      if (stale !== state.checkVerdicts) session.commitWorkPhaseState({ ...state, checkVerdicts: stale });
      return;
    }
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

/**
 * Attach a receipt to a verifier run: its report, strength, and the workspace
 * version it ran against. Runs after the verdict is recorded and never delays
 * the tool result.
 */
export async function observeCheckReceipt(
  event: ToolCycleInput,
  session: RouterSession,
  exec: Exec,
  cwd: string,
): Promise<void> {
  try {
    const state = session.getWorkPhaseState();
    const last = session.getLastDecision();
    if (!state || !last || last.intentKey !== state.intentKey) return;
    const action = actionFromTool(event.toolName, event.input);
    if (!isVerifier(action)) return;
    const verdict = checkVerdict(event, state.providerInvocation);
    if (!verdict) return;
    const snapshot = await snapshotWorkspace(exec, cwd);
    const current = session.getWorkPhaseState();
    if (!current || current.intentKey !== state.intentKey) return;
    const receipt = buildReceipt({
      id: fingerprint([event.toolCallId]).slice(0, 8),
      kind: action.commandClass as 'test' | 'typecheck' | 'lint' | 'build',
      verdict,
      output: contentText(event.content),
      snapshot,
    });
    session.commitWorkPhaseState({ ...current, checkVerdicts: addReceipt(current.checkVerdicts ?? { runsAfterHandoff: 0 }, receipt) });
  } catch {
    // Receipts are evidence only; a failure leaves the verdict unchanged.
  }
}
