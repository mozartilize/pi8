import { describe, expect, it } from 'vitest';
import {
  ECONOMY_EXECUTION_MINIMUM,
  acceptContract,
  breakContract,
  contractShapeBand,
  executionMinimum,
  isDeclaredTarget,
  isExcludedExecutor,
  validateContract,
} from './execution-contract.js';
import { inheritThinContinuation, type WorkPhaseState } from './work-phase.js';

const state = (over: Partial<WorkPhaseState> = {}): WorkPhaseState => ({
  intentKey: 'intent-a',
  terminal: {
    kind: 'plan', complexity: 'moderate', scope: 'bounded', compound: false, confidence: 'high', discountEligible: false,
  },
  terminalRequirement: 0.6,
  terminalBand: 'strong',
  phase: 'reason',
  phaseReason: 'terminal-plan',
  multiWorkEngaged: false,
  providerInvocation: 3,
  mutationGateBlocks: 0,
  mutationGateTriggered: false,
  mutationCompleted: false,
  pendingMutationToolCallIds: new Set(),
  observedReadTools: 0,
  observedMutationTools: 0,
  ...over,
});

const edit = (path: string) => ({ kind: 'edit', path, change: 'make the claim atomic' });
const verify = { kind: 'verify', verifier: 'test' };

function accepted(steps: Parameters<typeof validateContract>[0], base = state()): WorkPhaseState {
  const validation = validateContract(steps, '/repo');
  if (!validation.ok) throw new Error(validation.reason);
  return acceptContract(base, {
    submitter: 'codex/sol:max',
    submitterDimension: 'plan',
    targets: validation.targets,
    steps: validation.steps,
    shapeBand: validation.shapeBand,
  });
}

describe('execution contract validation', () => {
  it('accepts concrete file changes and resolves targets against the working directory', () => {
    const result = validateContract([edit('src/a.ts'), edit('./src/a.ts'), verify], '/repo');
    expect(result).toEqual({ ok: true, targets: ['/repo/src/a.ts'], steps: 3, shapeBand: 'economy' });
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
    expect(executionMinimum('economy')).toBe(ECONOMY_EXECUTION_MINIMUM);
    expect(executionMinimum('standard')).toBe(0.45);
    expect(executionMinimum('strong')).toBe(0.70);
    expect(executionMinimum('frontier')).toBeUndefined();
  });
});

describe('execution contract lifecycle', () => {
  it('releases a small plan and keeps the submitter for a large one', () => {
    const small = accepted([edit('a.ts'), verify]).contract!;
    expect(small).toMatchObject({ status: 'active', band: 'economy', release: true, submitterDimension: 'plan' });
    const large = accepted(['a', 'b', 'c', 'd', 'e', 'f'].map((f) => edit(`${f}.ts`))).contract!;
    expect(large).toMatchObject({ band: 'frontier', release: false });
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
      .toMatchObject({ band: 'frontier', release: false });
  });

  it('ignores a break when no contract is active', () => {
    const idle = state();
    expect(breakContract(idle, 'x/luna', 'replan')).toBe(idle);
  });

  it('drops the contract but keeps strikes across a thin continuation', () => {
    const broken = breakContract(accepted([edit('a.ts')]), 'x/luna', 'struggle');
    const withActive = accepted([edit('a.ts')], broken);
    const next = inheritThinContinuation('intent-b', withActive);
    expect(next.contract).toBeUndefined();
    expect(next.contractStrikes).toEqual({ luna: 1 });
  });
});
