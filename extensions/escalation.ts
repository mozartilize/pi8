/**
 * Model self-escalation state (M4b).
 *
 * The serving model can call the `route_up` tool when it recognizes it is
 * under-powered for the current task. The next router/auto turn consumes the
 * override and routes to a stronger dimension. Escalation overrides are
 * up-only and time/turn bounded so a single deep question does not stick the
 * whole session on a frontier model forever.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import type { Dimension, DecisionCause } from './types.js';
import { ROUTER_DIMENSIONS, ROUTER_PROVIDER_ID, AUTO_MODEL_ID } from './types.js';
import { DIMENSION_STRENGTH } from './classifier-keywords.js';
import { loadConfig } from './config.js';
import { debugLog } from './debuglog.js';
import { appendEscalationSignal } from './decisionlog.js';
import { notifyEscalation } from './ui.js';
import { getLastServed, getLastDecision } from './router-session-state.js';

export const ROUTE_UP_TOOL = 'route_up';

/**
 * Concise, self-contained route-up guidance injected directly into the
 * delegated model's system prompt. The route-up SKILL.md only surfaces as a
 * name/description in the skills listing; a fast model would have to choose to
 * `read` the file before it even learns it can escalate. Inlining the rules
 * removes that dependency so the tier most likely to need escalation always
 * sees them. This inline paragraph and skills/route-up/SKILL.md are two
 * renderings of one invocation contract; their shared contract is guarded by
 * route-up-guidance.test.ts. SKILL.md intentionally adds a skill-only
 * "Router behavior and boundaries" section not included inline.
 */
export const ROUTE_UP_INLINE_GUIDANCE = [
  '[router/auto] You were selected automatically for this turn.',
  'If the task needs a stronger model for deeper reasoning, multi-step planning, architecture/API',
  'design, trade-off analysis, or open-ended investigation beyond your capabilities — or the user',
  'pushed back on a previous answer’s depth — call the `route_up` tool BEFORE writing a substantive answer',
  '(dimension: plan | review | implement | gather; one-sentence reason), then briefly restate',
  'what you understood so the stronger model has a clean handoff. Do NOT escalate work you can',
  'genuinely handle: summaries, renames, small edits, factual lookups, formatting.',
].join(' ');

/**
 * Append the inline route-up guidance to a system prompt. Idempotent: a
 * context that already carries the guidance is returned unchanged.
 */
export function appendRouteUpGuidance(systemPrompt: string | undefined): string {
  const base = systemPrompt ?? '';
  if (base.includes('[router/auto]')) return base;
  return base ? `${base}\n\n${ROUTE_UP_INLINE_GUIDANCE}` : ROUTE_UP_INLINE_GUIDANCE;
}

export const DEFAULT_ESCALATION_TTL_MS = 5 * 60 * 1000;
/** Prevent a model from repeatedly renewing escalation without a pause. */
export const ESCALATION_COOLDOWN_MS = 30 * 1000;

interface EscalationOverride {
  dimension: Dimension;
  reason: string;
  /** The model that requested escalation, when one was actually serving. */
  fromModel?: string;
  /** Number of future router/auto turns this override still applies to. */
  remainingTurns: number;
  /** Epoch ms when the override was set; absolute TTL backstop. */
  setAt: number;
}

let activeOverride: EscalationOverride | undefined;
let escalationTtlMs = DEFAULT_ESCALATION_TTL_MS;
let lastAcceptedEscalationAt: number | undefined;

/**
 * Supersede a pending model escalation without touching the cooldown.
 *
 * An explicit user request outranks a model's earlier route_up, but clearing
 * the cooldown too would let a model immediately re-request escalation on the
 * very next turn, which is exactly what the cooldown exists to prevent.
 */
export function clearActiveEscalation(): void {
  activeOverride = undefined;
}

/** Clear escalation state that must never cross a Pi session boundary. */
export function resetEscalationSession(): void {
  activeOverride = undefined;
  lastAcceptedEscalationAt = undefined;
}

/** Test seam: reset session state and optionally set TTL. */
export function resetEscalation(opts?: { ttlMs?: number }): void {
  resetEscalationSession();
  if (opts?.ttlMs !== undefined) escalationTtlMs = opts.ttlMs;
}

function isExpired(override: EscalationOverride): boolean {
  return override.remainingTurns <= 0 || Date.now() - override.setAt > escalationTtlMs;
}

/**
 * Request a dimension escalation. Returns false if the request was ignored
 * (already at/above the requested dimension, or invalid).
 */
export function requestEscalation(
  dimension: Dimension,
  reason: string,
  ttlTurns: number,
): { ok: boolean; message: string } {
  if (!ROUTER_DIMENSIONS.includes(dimension)) {
    return { ok: false, message: `Invalid dimension: ${dimension}.` };
  }
  if (activeOverride && !isExpired(activeOverride)) {
    if (DIMENSION_STRENGTH[activeOverride.dimension] >= DIMENSION_STRENGTH[dimension]) {
      return {
        ok: false,
        message: `Already escalated to ${activeOverride.dimension}; ignoring weaker request to ${dimension}.`,
      };
    }
  }
  if (lastAcceptedEscalationAt !== undefined && Date.now() - lastAcceptedEscalationAt < ESCALATION_COOLDOWN_MS) {
    return {
      ok: false,
      message: 'Escalation requests are being rate-limited; wait before requesting another escalation.',
    };
  }
  lastAcceptedEscalationAt = Date.now();
  activeOverride = {
    dimension,
    reason: reason.slice(0, 200),
    fromModel: getLastServed()?.registryId,
    remainingTurns: Math.max(1, ttlTurns),
    setAt: Date.now(),
  };
  return {
    ok: true,
    message: `Escalated to ${dimension}. The next response will be served by a stronger model.`,
  };
}

/**
 * Apply the active escalation override to the heuristic dimension.
 * Decrements remainingTurns and clears expired overrides. Returns undefined
 * when no override applies.
 *
 * When the requested dimension equals the heuristic but a concrete serving
 * model requested the escalation, the override is still actionable as a
 * capability escalation (same-dimension repick to a different model).
 */
export function applyEscalation(
  heuristicDimension: Dimension,
): { dimension: Dimension; cause: DecisionCause; reason: string; fromModel: string | undefined } | undefined {
  if (!activeOverride || isExpired(activeOverride)) {
    activeOverride = undefined;
    return undefined;
  }

  const override = activeOverride;
  override.remainingTurns -= 1;
  if (override.remainingTurns <= 0) activeOverride = undefined;

  const requestedStrength = DIMENSION_STRENGTH[override.dimension];
  const heuristicStrength = DIMENSION_STRENGTH[heuristicDimension];

  if (requestedStrength < heuristicStrength) {
    // Heuristic already routed above the requested dimension; consume the
    // override without changing the decision.
    return undefined;
  }

  if (requestedStrength === heuristicStrength) {
    if (!override.fromModel) {
      // Same dimension, no serving model to escape from — nothing to do.
      return undefined;
    }
    return {
      dimension: override.dimension,
      cause: 'capability-escalation',
      reason: override.reason,
      fromModel: override.fromModel,
    };
  }

  return {
    dimension: override.dimension,
    cause: 'model-escalation',
    reason: override.reason,
    fromModel: override.fromModel,
  };
}

/** Register the `route_up` tool with Pi. */
export function registerRouteUpTool(pi: ExtensionAPI): void {
  try {
    pi.registerTool({
      name: ROUTE_UP_TOOL,
      label: 'Route Up',
      description:
        'Escalate this conversation to a stronger model tier. Call when the current task needs deeper reasoning, planning, architecture/design research, or open-ended investigation than a fast/cheap model tier is suited for. Choose the strongest dimension that fits: plan, review, implement, or gather.',
      parameters: Type.Object({
        dimension: Type.String({
          description: 'Target dimension: plan, review, implement, or gather.',
        }),
        reason: Type.String({
          description: 'One sentence explaining why a stronger model is needed.',
        }),
      }),
      execute: async (_id, params, _signal, _onUpdate, ctx) => {
        const dim = (params as { dimension: string }).dimension as Dimension;
        const reason = (params as { reason: string }).reason;
        // route_up is a router/auto-only mechanism: the tool is registered
        // globally (Pi has no per-session tool registration), so any model in
        // any session can technically call it. Outside a router/auto session
        // there is no routing loop to consume an escalation override, so
        // accepting the call here would set global state that is never read
        // and would falsely claim "the next response will be served by a
        // stronger model." Decline cleanly instead — zero state, zero
        // side effects, so a non-router session behaves exactly as if this
        // extension were not installed.
        if (ctx?.model?.provider !== ROUTER_PROVIDER_ID || ctx.model.id !== AUTO_MODEL_ID) {
          return {
            content: [{
              type: 'text' as const,
              text: 'route_up has no effect: the session model is not router/auto.',
            }],
            details: { ok: false, dimension: dim, reason },
          };
        }
        const config = loadConfig();
        const ttl = config.escalationTtlTurns ?? 4;
        const result = requestEscalation(dim, reason, ttl);
        // Always debug-log the call (accepted or not); the surrounding
        // handlers stay silent so this is the only trace of a route_up call.
        debugLog('escalation.request', {
          dimension: dim,
          reason: reason?.slice(0, 120),
          ok: result.ok,
          message: result.message,
        });
        if (result.ok) {
          // Only accepted escalations change routing, so only they earn a
          // durable decision-log entry and a user-facing notification.
          const servingModel = getLastServed()?.registryId;
          const effectiveDimension = getLastDecision()?.dimension;
          const routedUp = effectiveDimension !== undefined &&
            DIMENSION_STRENGTH[dim] > DIMENSION_STRENGTH[effectiveDimension];
          appendEscalationSignal({
            requestedDimension: dim,
            heuristicDimension: effectiveDimension,
            reason,
            servingModel,
            cause: routedUp ? 'model-escalation' : 'capability-escalation',
            routedUp,
          });
          if (config.prompt) notifyEscalation(ctx, dim, reason);
        }
        return {
          content: [{ type: 'text' as const, text: result.message }],
          details: { ok: result.ok, dimension: dim, reason },
        };
      },
    });
  } catch {
    // Tool registration must never crash extension init.
  }
}
