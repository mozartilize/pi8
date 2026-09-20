import { describe, expect, it } from 'vitest';

import { evaluateMutationCall, recordMutationResult } from './mutation-gate.js';
import { terminalAssessment } from '../../test-support/router-fixtures.js';
import type { WorkPhaseState } from './work-phase.js';
import type { ServedInfo } from '../../host/ui.js';

function baseState(overrides: Partial<WorkPhaseState> = {}): WorkPhaseState {
  return {
    intentKey: 'intent-a',
    terminal: terminalAssessment(),
    terminalRequirement: 0.775,
    terminalBand: 'frontier',
    phase: 'inspect',
    phaseReason: 'explicit-compound-inspect',
    multiWorkEngaged: true,
    providerInvocation: 3,
    mutationGateBlocks: 0,
    mutationGateTriggered: false,
    mutationCompleted: false,
    pendingMutationToolCallIds: new Set(),
    observedReadTools: 0,
    observedMutationTools: 0,
    ...overrides,
  };
}

const inspectState = baseState();

function blockedState(invocation: number): WorkPhaseState {
  return baseState({
    providerInvocation: invocation,
    gateBlockedInvocation: invocation,
    mutationGateTriggered: true,
    mutationGateBlocks: 1,
  });
}

function servedWithCapability(
  clearsTerminalFloor: boolean | 'unknown',
  invocation: number,
  terminalCapableInScoringSet: boolean,
): ServedInfo {
  return {
    registryId: 'test/model',
    viaFallback: false,
    accumulatedCost: 0,
    capability: {
      providerInvocation: invocation,
      terminalFloor: 0.85,
      terminalCapableInScoringSet,
      candidate: { clearsTerminalFloor, viaInspectPromotion: false },
    },
  };
}

const underTerminalServed = (invocation: number, terminalCapableInScoringSet: boolean): ServedInfo =>
  servedWithCapability(false, invocation, terminalCapableInScoringSet);

const terminalClearedServed = (invocation: number): ServedInfo =>
  servedWithCapability(true, invocation, true);

const unknownCapabilityServed = (invocation: number): ServedInfo =>
  servedWithCapability('unknown', invocation, true);

describe('evaluateMutationCall', () => {
  it('blocks every under-terminal sibling from the same invocation once', () => {
    const first = evaluateMutationCall({
      toolName: 'edit', toolCallId: 'edit-1', state: inspectState,
      served: underTerminalServed(3, true),
    });
    expect(first.block).toBe(true);
    expect(first.nextState?.gateBlockedInvocation).toBe(3);
    expect(first.nextState?.mutationGateBlocks).toBe(1);

    const sibling = evaluateMutationCall({
      toolName: 'write', toolCallId: 'write-1', state: first.nextState,
      served: underTerminalServed(3, true),
    });
    expect(sibling.block).toBe(true);
    expect(sibling.nextState?.mutationGateBlocks).toBe(1);
  });

  it('allows the later invocation through the bounded escape', () => {
    const result = evaluateMutationCall({
      toolName: 'edit', toolCallId: 'edit-2', state: blockedState(3),
      served: underTerminalServed(4, true),
    });
    expect(result.block).toBe(false);
    expect(result.nextState?.pendingMutationToolCallIds.has('edit-2')).toBe(true);
    expect(result.metadata).toMatchObject({ capabilityDegraded: true, mutationGateEscaped: true });
  });

  it('allows unknown capability without promotion credit', () => {
    const result = evaluateMutationCall({
      toolName: 'edit', toolCallId: 'unknown-1', state: inspectState,
      served: unknownCapabilityServed(1),
    });
    expect(result.block).toBe(false);
    expect(result.metadata?.clearance).toBe('unknown');
  });

  it('allows a terminal-clearing served candidate without a gate', () => {
    const result = evaluateMutationCall({
      toolName: 'edit', toolCallId: 'clear-1', state: inspectState,
      served: terminalClearedServed(3),
    });
    expect(result.block).toBe(false);
    expect(result.metadata).toMatchObject({ clearance: true });
    expect(result.nextState?.phase).toBe('mutate');
  });

  it('allows through when no candidate in the scoring set ever clears the floor', () => {
    const result = evaluateMutationCall({
      toolName: 'edit', toolCallId: 'no-candidate-1', state: inspectState,
      served: underTerminalServed(3, false),
    });
    expect(result.block).toBe(false);
    expect(result.metadata).toMatchObject({ clearance: false, capabilityDegraded: true });
  });

  it('fails open on missing served info', () => {
    const result = evaluateMutationCall({
      toolName: 'edit', toolCallId: 'missing-1', state: inspectState, served: undefined,
    });
    expect(result.block).toBe(false);
    expect(result.metadata?.clearance).toBe('unknown');
    expect(result.nextState?.phase).toBe('mutate');
  });

  it('fails open on served info with no capability evidence', () => {
    const result = evaluateMutationCall({
      toolName: 'edit', toolCallId: 'missing-2', state: inspectState,
      served: { registryId: 'test/model', viaFallback: false, accumulatedCost: 0 },
    });
    expect(result.block).toBe(false);
    expect(result.metadata?.clearance).toBe('unknown');
  });

  it('fails open when the intent state is wholly missing', () => {
    const result = evaluateMutationCall({
      toolName: 'edit', toolCallId: 'no-state-1', state: undefined,
      served: underTerminalServed(3, true),
    });
    expect(result).toEqual({ block: false });
  });

  it('ignores non-mutation tools entirely', () => {
    const result = evaluateMutationCall({
      toolName: 'read', toolCallId: 'read-1', state: inspectState,
      served: underTerminalServed(3, true),
    });
    expect(result).toEqual({ block: false });
  });

  it('never gates a non-engaged intent, but still tracks the pending call', () => {
    const nonEngaged = baseState({ multiWorkEngaged: false, phase: 'mutate' });
    const result = evaluateMutationCall({
      toolName: 'edit', toolCallId: 'plain-1', state: nonEngaged,
      served: underTerminalServed(3, true),
    });
    expect(result.block).toBe(false);
    expect(result.nextState?.pendingMutationToolCallIds.has('plain-1')).toBe(true);
  });

  it('never gates once already in the mutate phase', () => {
    const mutating = baseState({ phase: 'mutate' });
    const result = evaluateMutationCall({
      toolName: 'write', toolCallId: 'mutate-1', state: mutating,
      served: underTerminalServed(3, true),
    });
    expect(result.block).toBe(false);
    expect(result.nextState?.pendingMutationToolCallIds.has('mutate-1')).toBe(true);
  });
});

describe('bash detections in the gate', () => {
  it('gates a high-confidence bash write like a native mutation', () => {
    const result = evaluateMutationCall({
      toolName: 'bash', toolCallId: 'bash-1', state: inspectState,
      served: underTerminalServed(3, true),
      detection: { confidence: 'high', surface: 'bash-shell', signal: 'shell-redirect' },
    });
    expect(result.block).toBe(true);
    expect(result.nextState?.gateBlockedInvocation).toBe(3);
    expect(result.metadata).toMatchObject({
      clearance: false,
      mutationSurface: 'bash-shell',
      mutationSignal: 'shell-redirect',
    });
  });

  it('blocks high-confidence bash siblings from the same invocation once', () => {
    const first = evaluateMutationCall({
      toolName: 'bash', toolCallId: 'bash-1', state: inspectState,
      served: underTerminalServed(3, true),
      detection: { confidence: 'high', surface: 'bash-python-inline', signal: 'python-write-api' },
    });
    expect(first.block).toBe(true);

    const sibling = evaluateMutationCall({
      toolName: 'bash', toolCallId: 'bash-2', state: first.nextState,
      served: underTerminalServed(3, true),
      detection: { confidence: 'high', surface: 'bash-shell', signal: 'shell-writer' },
    });
    expect(sibling.block).toBe(true);
    expect(sibling.nextState?.mutationGateBlocks).toBe(1);
  });

  it('escapes on the later invocation with surface metadata intact', () => {
    const result = evaluateMutationCall({
      toolName: 'bash', toolCallId: 'bash-3', state: blockedState(3),
      served: underTerminalServed(4, true),
      detection: { confidence: 'high', surface: 'bash-shell', signal: 'shell-filesystem' },
    });
    expect(result.block).toBe(false);
    expect(result.nextState?.pendingMutationToolCallIds.has('bash-3')).toBe(true);
    expect(result.metadata).toMatchObject({
      mutationGateEscaped: true,
      capabilityDegraded: true,
      mutationSurface: 'bash-shell',
      mutationSignal: 'shell-filesystem',
    });
  });

  it('allows possible/opaque bash without state change, logging enum metadata only', () => {
    const result = evaluateMutationCall({
      toolName: 'bash', toolCallId: 'bash-4', state: inspectState,
      served: underTerminalServed(3, true),
      detection: { confidence: 'possible', surface: 'bash-python-opaque', signal: 'python-opaque' },
    });
    expect(result).toEqual({
      block: false,
      metadata: {
        clearance: 'unknown',
        mutationSurface: 'bash-python-opaque',
        mutationSignal: 'python-opaque',
      },
    });
    expect(result.nextState).toBeUndefined();
  });

  it('ignores read-only bash entirely', () => {
    const result = evaluateMutationCall({
      toolName: 'bash', toolCallId: 'bash-5', state: inspectState,
      served: underTerminalServed(3, true),
      detection: { confidence: 'none' },
    });
    expect(result).toEqual({ block: false });
  });

  it('fails open for a high-confidence bash write with no intent state', () => {
    const result = evaluateMutationCall({
      toolName: 'bash', toolCallId: 'bash-6', state: undefined,
      served: underTerminalServed(3, true),
      detection: { confidence: 'high', surface: 'bash-shell', signal: 'shell-redirect' },
    });
    expect(result).toEqual({ block: false });
  });

  it('carries native surface metadata on edit and write', () => {
    const edit = evaluateMutationCall({
      toolName: 'edit', toolCallId: 'e2', state: inspectState,
      served: underTerminalServed(3, true),
    });
    expect(edit.block).toBe(true);
    expect(edit.metadata).toMatchObject({ mutationSurface: 'native', mutationSignal: 'native-edit' });

    const write = evaluateMutationCall({
      toolName: 'write', toolCallId: 'w2', state: inspectState,
      served: underTerminalServed(3, true),
    });
    expect(write.block).toBe(true);
    expect(write.metadata).toMatchObject({ mutationSurface: 'native', mutationSignal: 'native-write' });
  });
});

describe('recordMutationResult', () => {
  it('clears the pending id and marks completion on success', () => {
    const state = baseState({ pendingMutationToolCallIds: new Set(['edit-1']) });
    const next = recordMutationResult({ state, toolCallId: 'edit-1', isError: false });
    expect(next.pendingMutationToolCallIds.has('edit-1')).toBe(false);
    expect(next.mutationCompleted).toBe(true);
  });

  it('clears the pending id without marking completion on error', () => {
    const state = baseState({ pendingMutationToolCallIds: new Set(['edit-1']) });
    const next = recordMutationResult({ state, toolCallId: 'edit-1', isError: true });
    expect(next.pendingMutationToolCallIds.has('edit-1')).toBe(false);
    expect(next.mutationCompleted).toBe(false);
  });

  it('leaves state unchanged for an unrelated tool call id', () => {
    const state = baseState({ pendingMutationToolCallIds: new Set(['edit-1']) });
    const next = recordMutationResult({ state, toolCallId: 'edit-2', isError: false });
    expect(next).toBe(state);
  });
});
