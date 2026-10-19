import { describe, expect, it } from 'vitest';
import type { ExecutionRubric, MeasuredFeatures } from '../../types.js';
import {
  acceptContract,
  attributeExecutor,
  breakContract,
  contractBudget,
  delegatableShape,
  entryEndOutcome,
  expireContract,
  isDeclaredTarget,
  isExcludedExecutor,
  servedBySubmitter,
  isUnderReview,
  handBackContract,
  noteContractEdit,
  noteContractVerifier,
  reworkContract,
  validateContract,
} from './execution-contract.js';
import { penaltiesOf, withContinuedPenalties, type WorkPhaseState } from './work-phase.js';

const state = (over: Partial<WorkPhaseState> = {}): WorkPhaseState => ({
  intentKey: 'intent-a',
  providerInvocation: 3,
  observedMutationTools: 0,
  ...over,
});

const edit = (path: string) => ({ kind: 'edit', path, change: 'make the claim atomic' });
const verify = { kind: 'verify', verifier: 'test' };

const EASY: ExecutionRubric = { openDecisions: 1, spread: 1, verification: 1, knowledge: 1, coupling: 1 };
/** Small, existing, quiet targets. */
const QUIET: Omit<MeasuredFeatures, 'files' | 'directories' | 'steps' | 'testTargets'> = {
  existingLines: 100, missingTargets: 0, commits: 0, fixCommits: 0,
};

function accepted(
  steps: Parameters<typeof validateContract>[0],
  base = state(),
  rubric: Partial<ExecutionRubric> = {},
  observed: Partial<MeasuredFeatures> = {},
): WorkPhaseState {
  const validation = validateContract(steps, '/repo');
  if (!validation.ok) throw new Error(validation.reason);
  return acceptContract(base, {
    submitter: 'codex/sol:max',
    validation,
    rubric: { ...EASY, ...rubric },
    measured: { ...validation.structural, ...QUIET, ...observed },
  });
}

describe('execution contract validation', () => {
  it('accepts concrete file changes and resolves targets against the working directory', () => {
    const result = validateContract([edit('src/a.ts'), edit('./src/a.ts'), verify], '/repo');
    expect(result).toEqual({
      ok: true,
      targets: ['/repo/src/a.ts'],
      editTargets: ['/repo/src/a.ts'],
      steps: 3,
      delegatable: true,
      deletes: false,
      structural: { files: 1, directories: 1, steps: 3, testTargets: 0 },
    });
  });

  it('measures directories and test targets, and completes only on edit/create targets', () => {
    const result = validateContract(
      [edit('src/a.ts'), edit('src/a.test.ts'), { kind: 'delete', path: 'lib/old.ts' }],
      '/repo',
    );
    expect(result).toMatchObject({
      ok: true,
      editTargets: ['/repo/src/a.ts', '/repo/src/a.test.ts'],
      structural: { files: 3, directories: 2, steps: 3, testTargets: 1 },
    });
  });

  it.each([
    [[], 'no steps'],
    [[verify], 'changes no files'],
    [[edit('src/**/*.ts')], 'pattern'],
    [[{ kind: 'edit', path: 'src/a.ts', change: '  ' }], 'does not describe the change'],
    [[{ kind: 'investigate', path: 'src/a.ts' }], 'unsupported step kind'],
    [[{ kind: 'create', path: '' , change: 'x' }], 'has no path'],
  ])('rejects a plan that is not a closed program (%#)', (steps, reason) => {
    const result = validateContract(steps, '/repo');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(reason);
  });

  it('rejects with a code that never quotes the plan', () => {
    const rejected = (steps: Parameters<typeof validateContract>[0]) => {
      const validation = validateContract(steps, '/repo');
      return validation.ok ? undefined : validation.code;
    };
    expect(rejected([])).toBe('no-steps');
    expect(rejected([{ kind: 'rename', path: 'src/a.ts' }])).toBe('unsupported-step');
    expect(rejected([{ kind: 'edit', change: 'x' }])).toBe('missing-path');
    expect(rejected([edit('src/*.ts')])).toBe('pattern-path');
    expect(rejected([{ kind: 'create', path: 'src/a.ts' }])).toBe('missing-change');
    expect(rejected([verify])).toBe('no-files');
  });

  it('allows a delete without a change description', () => {
    expect(validateContract([{ kind: 'delete', path: 'old.ts' }], '/repo').ok).toBe(true);
  });

  it('lets another model execute a plan of up to five files and eight steps', () => {
    expect(delegatableShape(5, 8)).toBe(true);
    expect(delegatableShape(6, 8)).toBe(false);
    expect(delegatableShape(5, 9)).toBe(false);
  });
});

describe('execution contract lifecycle', () => {
  it('releases a closed plan and keeps the submitter for a plan too large to hand off', () => {
    const small = accepted([edit('a.ts'), verify]).contract!;
    expect(small).toMatchObject({ status: 'active', release: true, releasePending: true });
    expect(small.keepReason).toBeUndefined();
    const files = (count: number) => Array.from({ length: count }, (_, index) => edit(`f${index}.ts`));
    expect(accepted(files(5)).contract).toMatchObject({ release: true });
    expect(accepted(files(6)).contract).toMatchObject({ release: false, keepReason: 'size' });
  });

  it('releases a settled plan however hard its rubric, and keeps a plan with an open choice', () => {
    const hard = { openDecisions: 3, spread: 5, verification: 5, knowledge: 5, coupling: 5 };
    expect(accepted([edit('a.ts')], state(), hard).contract).toMatchObject({ release: true });
    expect(accepted([edit('a.ts')], state(), { openDecisions: 4 }).contract)
      .toMatchObject({ release: false, keepReason: 'open-decisions' });
    const validation = validateContract([edit('a.ts')], '/repo');
    if (!validation.ok) throw new Error(validation.reason);
    const unscored = acceptContract(state(), {
      submitter: 'codex/sol:max', validation, rubric: undefined, measured: { ...validation.structural, ...QUIET },
    }).contract!;
    expect(unscored.release).toBe(true);
    expect(unscored.rubric).toBeUndefined();
  });

  it('keeps the submitter when a target to edit or delete does not exist', () => {
    expect(accepted([edit('a.ts')], state(), {}, { missingTargets: 1 }).contract)
      .toMatchObject({ release: false, keepReason: 'unknown-target' });
  });

  it('keeps the submitter when target existence was not measured', () => {
    expect(accepted([edit('a.ts')], state(), {}, { missingTargets: undefined }).contract)
      .toMatchObject({ release: false, keepReason: 'unknown-target' });
  });

  it('keeps the submitter for a plan that deletes a file', () => {
    expect(accepted([edit('a.ts'), { kind: 'delete', path: 'b.ts' }]).contract)
      .toMatchObject({ release: false, keepReason: 'delete' });
  });

  it('checks declared targets by resolved path', () => {
    const contract = accepted([edit('src/a.ts')]).contract!;
    expect(isDeclaredTarget(contract, '/repo', './src/a.ts')).toBe(true);
    expect(isDeclaredTarget(contract, '/repo', '/repo/src/a.ts')).toBe(true);
    expect(isDeclaredTarget(contract, '/repo', '@src/a.ts')).toBe(true);
    expect(isDeclaredTarget(contract, '/repo', 'src/b.ts')).toBe(false);
  });

  it('excludes an executor model only on its second break, at every effort', () => {
    const first = breakContract(accepted([edit('a.ts')]), 'copilot/luna:high', 'undeclared-target');
    expect(first.contract).toMatchObject({ status: 'broken', breakReason: 'undeclared-target', breaker: 'copilot/luna:high' });
    expect(first.excludedExecutors).toBeUndefined();
    const second = breakContract(accepted([edit('a.ts')], first), 'copilot/luna:medium', 'struggle');
    expect(second.contractStrikes).toEqual({ 'copilot/luna': 2 });
    expect(second.excludedExecutors).toEqual(['copilot/luna:medium']);
    expect(isExcludedExecutor(second, 'copilot/luna:max')).toBe(true);
    expect(isExcludedExecutor(second, 'copilot/terra:max')).toBe(false);
  });

  it('keeps strikes and exclusions apart for the same model id on two providers', () => {
    const first = breakContract(accepted([edit('a.ts')]), 'copilot/luna:high', 'undeclared-target');
    const second = breakContract(accepted([edit('a.ts')], first), 'codex/luna:high', 'struggle');
    expect(second.contractStrikes).toEqual({ 'copilot/luna': 1, 'codex/luna': 1 });
    expect(second.excludedExecutors).toBeUndefined();
    const third = breakContract(accepted([edit('a.ts')], second), 'copilot/luna:low', 'struggle');
    expect(third.excludedExecutors).toEqual(['copilot/luna:low']);
    expect(isExcludedExecutor(third, 'copilot/luna:max')).toBe(true);
    expect(isExcludedExecutor(third, 'codex/luna:max')).toBe(false);
  });

  it('a submitter does not shield the same model id on another provider', () => {
    // The submitter is codex/sol.
    const broken = breakContract(accepted([edit('a.ts')]), 'copilot/sol:high', 'undeclared-target');
    expect(broken.contractStrikes).toEqual({ 'copilot/sol': 1 });
    expect(attributeExecutor(accepted([edit('a.ts')]), 'copilot/sol:high').contract?.executor).toBe('copilot/sol:high');
    expect(servedBySubmitter(accepted([edit('a.ts')]).contract!, 'copilot/sol:high')).toBe(false);
    expect(servedBySubmitter(accepted([edit('a.ts')]).contract!, 'codex/sol:low')).toBe(true);
  });

  it('never strikes the submitter for breaking its own plan', () => {
    const broken = breakContract(accepted([edit('a.ts')]), 'codex/sol:high', 'undeclared-target');
    expect(broken.contract?.status).toBe('broken');
    expect(broken.contractStrikes).toBeUndefined();
  });

  it('releases a plan after executors are excluded: the exclusion keeps only them out', () => {
    const excluded = state({ excludedExecutors: ['x/luna:high', 'x/flash', 'x/terra'] });
    const contract = accepted([edit('a.ts')], excluded).contract!;
    expect(contract.release).toBe(true);
    expect(contract.keepReason).toBeUndefined();
  });

  it('ignores a break when no contract is active', () => {
    const idle = state();
    expect(breakContract(idle, 'x/luna', 'replan')).toBe(idle);
  });

  it('keeps strikes, never the contract, for an entry that continues the work item', () => {
    const broken = breakContract(accepted([edit('a.ts')]), 'x/luna', 'struggle');
    const withActive = { ...accepted([edit('a.ts')], broken), workItemId: 'w_1' };
    const next = withContinuedPenalties({ ...state(), intentKey: 'intent-b', priorWork: penaltiesOf(withActive)! },
      'w_1', 'continue');
    expect(next.contract).toBeUndefined();
    expect(next.contractStrikes).toEqual({ 'x/luna': 1 });
  });
});

describe('execution contract completion and outcome', () => {
  const plan = () => accepted([edit('src/a.ts'), edit('src/b.ts'), verify]);

  it('executes the plan once every declared edit/create target is edited, recording the executor', () => {
    const first = noteContractEdit(plan(), '/repo', 'src/a.ts', 'copilot/luna:high');
    expect(first.contract).toMatchObject({ status: 'active', pending: ['/repo/src/b.ts'], executor: 'copilot/luna:high' });
    // Undeclared paths and repeated edits change nothing.
    expect(noteContractEdit(first, '/repo', 'src/other.ts', 'copilot/luna:high')).toBe(first);
    expect(noteContractEdit(first, '/repo', './src/a.ts', 'copilot/luna:high')).toBe(first);
    const done = noteContractEdit(first, '/repo', './src/b.ts', 'copilot/luna:high');
    expect(done.contract).toMatchObject({ status: 'executed', executedReason: 'complete', pending: [] });
  });

  it('never records the submitter as the executor', () => {
    const edited = noteContractEdit(plan(), '/repo', 'src/a.ts', 'codex/sol:high');
    expect(edited.contract?.executor).toBeUndefined();
  });

  it('executes an active plan once its invocation budget is used up', () => {
    const active = plan();
    const budget = contractBudget(active.contract!.steps);
    const within = { ...active, providerInvocation: active.contract!.acceptedAt + budget };
    expect(expireContract(within)).toBe(within);
    const over = { ...active, providerInvocation: active.contract!.acceptedAt + budget + 1 };
    expect(expireContract(over).contract).toMatchObject({ status: 'executed', executedReason: 'budget' });
  });

  it('attributes a released plan to the first model other than its submitter', () => {
    const active = plan();
    expect(attributeExecutor(active, 'codex/sol:high')).toBe(active);
    expect(attributeExecutor(active, undefined)).toBe(active);
    const attributed = attributeExecutor(active, 'copilot/luna:high');
    expect(attributed.contract?.executor).toBe('copilot/luna:high');
    expect(attributeExecutor(attributed, 'copilot/terra:low')).toBe(attributed);
    const kept = accepted([edit('src/a.ts')], state(), { openDecisions: 5 });
    expect(attributeExecutor(kept, 'copilot/luna:high')).toBe(kept);
  });

  it('hands a plan back to its submitter for review only when the submitter owned the turn', () => {
    const executed = noteContractEdit(accepted([edit('src/a.ts')]), '/repo', 'src/a.ts', 'copilot/luna:high').contract!;
    expect(handBackContract(executed)).toBe(executed);
    // A submitter that served because of an escalation or a fallback does not own the review.
    expect(handBackContract({ ...executed, submitterTemporary: true })).toBeUndefined();
    // A broken plan still returns to its submitter.
    const broken = { ...executed, status: 'broken' as const, submitterTemporary: true };
    expect(handBackContract(broken)).toBe(broken);
    expect(handBackContract(undefined)).toBeUndefined();
  });

  it('reviews only a plan another model executed', () => {
    const byExecutor = noteContractEdit(accepted([edit('src/a.ts')]), '/repo', 'src/a.ts', 'copilot/luna:high');
    expect(isUnderReview(byExecutor.contract!)).toBe(true);
    const bySubmitter = noteContractEdit(accepted([edit('src/a.ts')]), '/repo', 'src/a.ts', 'codex/sol:high');
    expect(bySubmitter.contract).toMatchObject({ status: 'executed', release: true });
    expect(isUnderReview(bySubmitter.contract!)).toBe(false);
    expect(noteContractEdit(bySubmitter, '/repo', 'src/b.ts', 'codex/sol:high')).toBe(bySubmitter);
    const byBudget = expireContract({ ...plan(), providerInvocation: 99 });
    expect(isUnderReview(byBudget.contract!)).toBe(false);
    expect(isUnderReview(attributeExecutor(byBudget, 'copilot/luna:high').contract!)).toBe(true);
  });

  it('labels review activity: an edit marks the work fixed, the first verifier run is kept', () => {
    const executed = attributeExecutor(expireContract({ ...plan(), providerInvocation: 99 }), 'copilot/luna:high');
    const verified = noteContractVerifier(noteContractVerifier(executed, false), true);
    expect(verified.contract?.reviewVerifier).toBe('fail');
    expect(entryEndOutcome(verified.contract!)).toBe('clean');
    const fixed = noteContractEdit(verified, '/repo', 'anything.ts', 'codex/sol:max');
    expect(fixed.contract?.reviewEdited).toBe(true);
    expect(entryEndOutcome(fixed.contract!)).toBe('fixed');
  });

  it('labels a plan still running at the end of the entry as unfinished, and a broken one as broken', () => {
    expect(entryEndOutcome(plan().contract!)).toBe('unfinished');
    expect(entryEndOutcome(breakContract(plan(), 'x/luna', 'replan').contract!)).toBe('broken');
  });

  it('strikes the executor of reworked work and excludes it on the second strike', () => {
    const executedBy = (base: WorkPhaseState) => {
      let next = accepted([edit('src/a.ts')], base);
      next = noteContractEdit(next, '/repo', 'src/a.ts', 'copilot/luna:high');
      return next;
    };
    const once = reworkContract(executedBy(state()));
    expect(once.contractStrikes).toEqual({ 'copilot/luna': 1 });
    const twice = reworkContract(executedBy(once));
    expect(twice.excludedExecutors).toEqual(['copilot/luna:high']);
  });

  it('never strikes on rework of a plan the submitter executed itself', () => {
    const selfExecuted = noteContractEdit(accepted([edit('src/a.ts')]), '/repo', 'src/a.ts', 'codex/sol:max');
    expect(selfExecuted.contract?.status).toBe('executed');
    expect(reworkContract(selfExecuted)).toBe(selfExecuted);
  });

  it('never labels later edits as fixes when the submitter kept the plan', () => {
    const kept = accepted([edit('src/a.ts')], state(), { openDecisions: 5 });
    const executed = noteContractEdit(kept, '/repo', 'src/a.ts', 'codex/sol:max');
    expect(executed.contract).toMatchObject({ status: 'executed', release: false });
    expect(noteContractEdit(executed, '/repo', 'src/b.ts', 'codex/sol:max')).toBe(executed);
    expect(entryEndOutcome(executed.contract!)).toBe('clean');
  });
});
