import { describe, expect, it } from 'vitest';
import type { ExecutionRubric, MeasuredFeatures } from '../../types.js';
import {
  acceptContract,
  attributeExecutor,
  breakContract,
  contractBudget,
  contractShapeBand,
  entryEndOutcome,
  executionMinimum,
  expireContract,
  isDeclaredTarget,
  isExcludedExecutor,
  isUnderReview,
  noteContractEdit,
  noteContractVerifier,
  reworkContract,
  validateContract,
} from './execution-contract.js';
import { BASE_REQUIREMENT } from './execution-difficulty.js';
import { inheritThinContinuation, type WorkPhaseState } from './work-phase.js';

const state = (over: Partial<WorkPhaseState> = {}): WorkPhaseState => ({
  intentKey: 'intent-a',
  terminal: {
    kind: 'plan', complexity: 'moderate', scope: 'bounded', compound: false, confidence: 'high',
  },
  terminalBand: 'strong',
  providerInvocation: 3,
  observedMutationTools: 0,
  ...over,
});

const edit = (path: string) => ({ kind: 'edit', path, change: 'make the claim atomic' });
const verify = { kind: 'verify', verifier: 'test' };

const EASY: ExecutionRubric = { openDecisions: 1, spread: 1, verification: 1, knowledge: 1, coupling: 1 };
/** Small, existing, quiet targets: no measurement adds to the requirement. */
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
    submitterDimension: 'plan',
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
      shapeBand: 'economy',
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

  it('maps plan shape to a band, keeping the submitter above standard', () => {
    expect(contractShapeBand(2, 4)).toBe('economy');
    expect(contractShapeBand(3, 4)).toBe('standard');
    expect(contractShapeBand(5, 8)).toBe('standard');
    expect(contractShapeBand(6, 8)).toBeUndefined();
    expect(contractShapeBand(2, 9)).toBeUndefined();
  });

  it('gives every releasing band an implement minimum', () => {
    expect(executionMinimum('economy')).toBe(BASE_REQUIREMENT);
    expect(executionMinimum('standard')).toBe(0.45);
    expect(executionMinimum('strong')).toBe(0.70);
    expect(executionMinimum('frontier')).toBeUndefined();
  });
});

describe('execution contract lifecycle', () => {
  it('releases a small plan and keeps the submitter for a large one', () => {
    const small = accepted([edit('a.ts'), verify]).contract!;
    expect(small).toMatchObject({
      status: 'active', band: 'economy', release: true, minimum: BASE_REQUIREMENT, submitterDimension: 'plan',
    });
    const large = accepted(['a', 'b', 'c', 'd', 'e', 'f'].map((f) => edit(`${f}.ts`))).contract!;
    expect(large).toMatchObject({ band: 'frontier', release: false, keepReason: 'size' });
    expect(large.minimum).toBeUndefined();
  });

  it('lets the rubric raise a small plan above its shape band, never below it', () => {
    expect(accepted([edit('a.ts')], state(), { openDecisions: 3 }).contract)
      .toMatchObject({ band: 'standard', release: true });
    expect(accepted([edit('a.ts')], state(), { openDecisions: 5 }).contract)
      .toMatchObject({ band: 'frontier', release: false, keepReason: 'difficulty' });
    // Three files cannot fall below standard, however easy the rubric.
    expect(accepted([edit('a.ts'), edit('b.ts'), edit('c.ts')]).contract)
      .toMatchObject({ band: 'standard', minimum: 0.45 });
  });

  it('requires the higher of the computed requirement and the band minimum', () => {
    const contract = accepted([edit('a.ts')], state(), { openDecisions: 2 }).contract!;
    expect(contract.band).toBe('economy');
    expect(contract.minimum).toBeCloseTo(contract.requirement);
    expect(contract.minimum).toBeGreaterThan(BASE_REQUIREMENT);
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
    const second = breakContract(accepted([edit('a.ts')], first), 'codex/luna:medium', 'struggle');
    expect(second.contractStrikes).toEqual({ luna: 2 });
    expect(second.excludedExecutors).toEqual(['codex/luna:medium']);
    expect(isExcludedExecutor(second, 'copilot/luna:max')).toBe(true);
    expect(isExcludedExecutor(second, 'copilot/terra:max')).toBe(false);
  });

  it('never strikes the submitter for breaking its own plan', () => {
    const broken = breakContract(accepted([edit('a.ts')]), 'codex/sol:high', 'undeclared-target');
    expect(broken.contract?.status).toBe('broken');
    expect(broken.contractStrikes).toBeUndefined();
  });

  it('raises the band one step per excluded executor until the submitter keeps the work', () => {
    const excluded = (models: string[]) => state({ excludedExecutors: models });
    expect(accepted([edit('a.ts')], excluded(['x/luna:high'])).contract).toMatchObject({ band: 'standard', release: true });
    expect(accepted([edit('a.ts')], excluded(['x/luna:high', 'x/flash'])).contract).toMatchObject({ band: 'strong', release: true });
    expect(accepted([edit('a.ts')], excluded(['x/luna:high', 'x/flash', 'x/terra'])).contract)
      .toMatchObject({ band: 'frontier', release: false, keepReason: 'excluded' });
  });

  it('ignores a break when no contract is active', () => {
    const idle = state();
    expect(breakContract(idle, 'x/luna', 'replan')).toBe(idle);
  });

  it('drops the contract but keeps strikes across a thin continuation', () => {
    const broken = breakContract(accepted([edit('a.ts')]), 'x/luna', 'struggle');
    const withActive = accepted([edit('a.ts')], broken);
    const next = inheritThinContinuation('intent-b', withActive, 'plan');
    expect(next.contract).toBeUndefined();
    expect(next.contractStrikes).toEqual({ luna: 1 });
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
    expect(once.contractStrikes).toEqual({ luna: 1 });
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
