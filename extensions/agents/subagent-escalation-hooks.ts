import {
  injectSubagentRoutingWithMetadata,
  stripThinkingSuffix,
  type InjectedSubagentSpec,
  type SubagentRoutingOptions,
  type SubagentRoutingTraversal,
} from './subagents.js';
import {
  parseSubagentResultRows,
  failedModelsForRow,
  isFailedResult,
} from './subagent-results.js';
import {
  SubagentEscalationState,
  parseSubagentEscalation,
  planSubagentOutcome,
} from './subagent-escalation.js';
import type { Role } from '../types.js';

interface PendingSubagentCall extends SubagentRoutingTraversal {
  async: boolean;
}

export interface SubagentToolResultLike<TContent extends { type: string }> {
  content: readonly TContent[];
  details: unknown;
  isError: boolean;
}

export interface SubagentToolResultPlan<TContent extends { type: string }> {
  blacklistModels: string[];
  retryDirectives: string[];
  observedModels: string[];
  observedRoles: Role[];
  content?: Array<TContent | { type: 'text'; text: string }>;
}

function childForStableIndex(
  pending: PendingSubagentCall,
  index: number,
): InjectedSubagentSpec | undefined {
  const matches = pending.children.filter((child) => {
    if (!child.stableIndexKnown || child.childIndex === undefined) return false;
    const span = child.childIndexSpan ?? 1;
    return index >= child.childIndex && index < child.childIndex + span;
  });
  if (matches.length !== 1 || !matches[0]!.routerOwned) return undefined;
  return matches[0] as InjectedSubagentSpec;
}

/**
 * Focused stateful adapter for the subagent tool_call/tool_result boundaries.
 * SingleResult.index, not result row order or role/model equality, establishes
 * ownership against the stable launch metadata.
 */
export class SubagentEscalationHooks {
  private readonly pendingCalls = new Map<string, PendingSubagentCall>();

  constructor(private readonly state = new SubagentEscalationState()) {}

  toolCall(
    toolCallId: string,
    input: unknown,
    roleModels: ReadonlyMap<Role, string>,
    roleFallbacks: ReadonlyMap<Role, string[]>,
    isBlacklisted: (registryId: string) => boolean,
    defaultModel?: string,
    selectChildren?: SubagentRoutingOptions['selectChildren'],
  ): PendingSubagentCall {
    const async = !!input && typeof input === 'object' &&
      (input as { async?: unknown }).async === true;
    const traversal = injectSubagentRoutingWithMetadata(input, roleModels, {
      selectChildren: selectChildren ?? ((requests) => {
        // The selector is attached by the caller through the role maps when
        // available; this default keeps direct unit callers on baseline picks.
        return new Map(requests.map((request) => [
          request.path,
          {
            model: roleModels.get(request.role) ?? '',
            fallbackChain: roleFallbacks.get(request.role) ?? [],
            dimension: request.role === 'researcher'
              ? 'gather'
              : request.role === 'worker'
                ? 'implement'
                : request.role === 'reviewer'
                  ? 'review'
                  : 'plan',
          },
        ] as const).filter(([, selection]) => selection.model));
      }),
      consumeOverride: (role, originalTask, selectedFallbackChain) => this.state.consume(
        role,
        originalTask,
        roleFallbacks,
        isBlacklisted,
        selectedFallbackChain,
      ),
      appendEscalationContract: !async,
      defaultModel,
    });
    const pending = { ...traversal, async };
    this.pendingCalls.set(toolCallId, pending);
    return pending;
  }

  toolResult<TContent extends { type: string }>(
    toolCallId: string,
    event: SubagentToolResultLike<TContent>,
    roleFallbacks: ReadonlyMap<Role, string[]>,
    blacklistModel: (registryId: string) => void,
  ): SubagentToolResultPlan<TContent> {
    const pending = this.pendingCalls.get(toolCallId);
    this.pendingCalls.delete(toolCallId);

    const observedModels = pending
      ? [...new Set(pending.children.flatMap((child) => child.model ? [child.model] : []))]
      : [];
    const observedRoles = pending
      ? [...new Set(pending.children.flatMap((child) => child.role ? [child.role] : []))]
      : [];
    const empty = {
      blacklistModels: [],
      retryDirectives: [],
      observedModels,
      observedRoles,
    };
    if (!pending || pending.async) return empty;

    const rows = parseSubagentResultRows(event.details);
    const hardFailures: InjectedSubagentSpec[] = [];
    const selfReports: Array<{ child: InjectedSubagentSpec; reason: string }> = [];
    let sawOwnedFinalOutput = false;

    const indexCounts = new Map<number, number>();
    for (const row of rows) {
      const index = row.index;
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) continue;
      indexCounts.set(index, (indexCounts.get(index) ?? 0) + 1);
    }

    for (const row of rows) {
      const index = row.index;
      // SingleResult.index is the only ownership key. Missing, invalid,
      // duplicate, unknown, or overlapping indexes deliberately fail open.
      if (
        typeof index !== 'number' ||
        !Number.isInteger(index) ||
        index < 0 ||
        indexCounts.get(index) !== 1
      ) continue;
      const owned = childForStableIndex(pending, index);
      if (!owned) continue;

      if (isFailedResult(row)) {
        const currentModel = stripThinkingSuffix(owned.model);
        const failedModels = failedModelsForRow(row);
        if (failedModels.length === 0 || failedModels.includes(currentModel)) {
          hardFailures.push(owned);
        }
        continue;
      }

      if (row.exitCode === 0 && typeof row.finalOutput === 'string') {
        sawOwnedFinalOutput = true;
        const report = parseSubagentEscalation(row.finalOutput);
        if (report) selfReports.push({ child: owned, reason: report.reason });
      }
    }

    // A tool-level failure without per-child rows is attributable only when
    // exactly one child exists and that child was router-owned.
    if (event.isError && rows.length === 0 && pending.children.length === 1) {
      const child = pending.children[0];
      if (child?.routerOwned && child.stableIndexKnown) {
        hardFailures.push(child as InjectedSubagentSpec);
      }
    }

    // Older single-child result details can omit results entirely. Never use
    // content fallback when rows exist because missing row indexes fail open.
    if (!event.isError && rows.length === 0 && !sawOwnedFinalOutput && pending.children.length === 1) {
      const child = pending.children[0];
      if (child?.routerOwned && child.stableIndexKnown) {
        const text = event.content
          .map((part) => 'text' in part && typeof part.text === 'string' ? part.text : '')
          .join('\n');
        const report = parseSubagentEscalation(text);
        if (report) selfReports.push({ child: child as InjectedSubagentSpec, reason: report.reason });
      }
    }

    const blacklistModels = [...new Set(hardFailures.map((child) => stripThinkingSuffix(child.model)))];
    // Preserve existing failure semantics before planning a retry directive.
    for (const model of blacklistModels) blacklistModel(model);

    const retryDirectives: string[] = [];
    const boundedGroupKeys = new Set<string>();
    const scheduleForChild = (
      child: InjectedSubagentSpec,
      reason: string,
      kind: 'hard-failure' | 'self-report',
    ): void => {
      if (!child.stableIndexKnown) return;
      const span = child.childIndexSpan ?? 1;
      const taskKey = span <= 1 ? child.originalTask : undefined;
      const baseIndex = child.childIndex ?? 0;
      let occurrenceKey: string;
      if (span <= 1) {
        occurrenceKey = `${child.path}:${baseIndex}`;
      } else {
        const groupKey = `${child.role}\u0000${stripThinkingSuffix(child.model)}\u0000${child.path}`;
        if (boundedGroupKeys.has(groupKey)) return;
        boundedGroupKeys.add(groupKey);
        occurrenceKey = `${child.path}:${baseIndex}-${baseIndex + span - 1}`;
      }
      const sourceChain = child.fallbackChain ?? roleFallbacks.get(child.role);
      const retryChain = sourceChain && kind === 'hard-failure'
        ? [
            child.model,
            ...sourceChain.filter((model) =>
              model !== child.model
              && stripThinkingSuffix(model) !== stripThinkingSuffix(child.model),
            ),
          ]
        : sourceChain;
      const outcome = planSubagentOutcome(
        this.state,
        kind,
        child.role,
        child.model,
        retryChain ? new Map([[child.role, retryChain]]) : roleFallbacks,
        reason,
        taskKey,
        occurrenceKey,
      );
      if (outcome.retry) retryDirectives.push(outcome.retry.directive);
    };

    for (const child of hardFailures) {
      scheduleForChild(child, 'the subagent spawn failed or timed out', 'hard-failure');
    }
    for (const { child, reason } of selfReports) {
      scheduleForChild(child, reason, 'self-report');
    }

    return {
      blacklistModels,
      retryDirectives,
      observedModels,
      observedRoles,
      ...(retryDirectives.length > 0
        ? {
            content: [
              ...event.content,
              { type: 'text' as const, text: retryDirectives.join('\n') },
            ],
          }
        : {}),
    };
  }

  reset(): void {
    this.pendingCalls.clear();
    this.state.reset();
  }
}
