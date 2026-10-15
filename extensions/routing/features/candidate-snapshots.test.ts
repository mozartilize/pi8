import { afterEach, expect, it, vi } from 'vitest';
import { candidateFeatures } from './candidate.js';
import * as task from './task-demand.js';
import * as capability from './model.js';
import * as spend from './spend.js';
import * as continuity from './continuity.js';
import * as recovery from './recovery.js';
import { enumerateEffectiveActions } from './actions.js';
import type { DecisionStateV1 } from './state.js';

afterEach(() => vi.restoreAllMocks());

it('projects only the declared domain fields before evaluation', () => {
  const taskCall = vi.spyOn(task, 'composeTaskDemand');
  const capabilityCall = vi.spyOn(capability, 'capabilityFeatures');
  const gapsCall = vi.spyOn(capability, 'evidenceGaps');
  const spendCall = vi.spyOn(spend, 'predictSpend');
  const continuityCall = vi.spyOn(continuity, 'continuityFeature');
  const recoveryCall = vi.spyOn(recovery, 'recoveryFeatures');
  const state: DecisionStateV1 = {
    phase: 'implement', estimatedContextTokens: 100, needsVision: false,
    boundary: 'ordinary', friction: [], nowMs: 1000, isSubagentSpawn: false,
    benchmarkIndexVersion: '4.3',
  };
  const model = { provider: 'p', id: 'm', reasoning: false, cost: { input: 1, output: 2 } };
  candidateFeatures(state, model, enumerateEffectiveActions(model)[0]!, []);
  const fields = (value: unknown) => Object.keys(value as object).sort();
  expect(fields(taskCall.mock.calls[0]![0])).toEqual([
    'contextAcquisition', 'difficulty', 'estimatedContextTokens', 'needsVision', 'openDecisions', 'phase',
  ]);
  expect(fields(capabilityCall.mock.calls[0]![2])).toEqual(['benchmarkIndexVersion']);
  expect(fields(gapsCall.mock.calls[0]![2])).toEqual(['benchmarkIndexVersion']);
  expect(fields(spendCall.mock.calls[0]![0])).toEqual([
    'cache', 'estimatedContextTokens', 'isSubagentSpawn', 'nowMs', 'promptIdentity', 'promptTokenScales',
  ]);
  expect(fields(spendCall.mock.calls[0]![2])).toEqual(['api', 'compat', 'cost', 'promptCache']);
  expect(fields(continuityCall.mock.calls[0]![0])).toEqual(['boundary', 'incumbent', 'rework']);
  expect(fields(recoveryCall.mock.calls[0]![0])).toEqual(['boundary', 'friction', 'rework', 'workItemId']);
});
