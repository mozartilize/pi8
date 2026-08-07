/**
 * The always-on semantic routing layer.
 *
 * The keyword classifier is a survivable fallback, not a policy engine: it
 * derives confidence from keyword hit counts, so a strong match yields full
 * confidence on a wrong answer. That is precisely the failure a confidence
 * gate cannot detect, which is why the old `shouldConsult` gate fired on 0.4%
 * of decisions and why there is no gate here — one assessment per real user
 * entry, unconditionally, bounded by one end-to-end deadline.
 *
 * The assessment answers *only* what kind of work this is. The deterministic
 * scorer still owns which models satisfy that need.
 */
import { streamSimple } from '@earendil-works/pi-ai/compat';
import type { Model, Api, Context, SimpleStreamOptions } from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import type {
  AssessmentFallbackReason,
  AssessmentMode,
  Candidate,
  RoutingAssessment,
} from './types.js';
import { buildAssessmentPrompt, parseAssessment, type AssessmentEvidence } from './assessment-prompt.js';
import { debugLog } from './debuglog.js';
import { blendedPricePer1M } from './scorer.js';
import { isUsageLimitErrorMessage } from './usage-limit.js';

export interface AssessmentConfig {
  /** Mirrors `config.consultRouter`; false means fully deterministic routing. */
  enabled: boolean;
  mode: AssessmentMode;
  /** Optional `provider/id` override; honoured only if it is routable. */
  modelRef?: string;
  deadlineMs: number;
  maxInputChars: number;
  assessorQualityRatio: number;
}

export type AssessmentAttempt =
  | { ok: true; assessment: RoutingAssessment }
  | {
      ok: false;
      fallbackReason: AssessmentFallbackReason;
      costUsd: number;
      ms: number;
      /** Selected assessor, when one was chosen (absent for no-assessor/disabled). */
      model?: string;
      /** Whether the assessor streamed any text before the attempt ended. A
       *  failed attempt that produced NO output is the structural dud signal
       *  the caller strikes; a partial-then-failed attempt is not. */
      producedOutput?: boolean;
      /** Provider of the assessor when its own failure was a usage-limit
       *  error. The cap is shared with the serving path, so the caller
       *  blacklists the whole provider. */
      usageLimitProvider?: string;
    };

function parseProviderId(modelRef: string): { provider: string; id: string } | undefined {
  const [provider, ...idParts] = modelRef.split('/');
  if (!provider || idParts.length === 0) return undefined;
  return { provider, id: idParts.join('/') };
}

async function resolveAuth(
  registry: ExtensionContext['modelRegistry'] | undefined,
  model: Model<Api>,
  deadlineAt: number,
): Promise<{ apiKey: string; headers?: Record<string, string> } | undefined> {
  if (!registry?.getApiKeyAndHeaders) return undefined;
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) return undefined;
  try {
    const auth = await Promise.race([
      Promise.resolve(registry.getApiKeyAndHeaders(model)),
      new Promise<undefined>((_, reject) =>
        setTimeout(() => reject(new Error('consult auth timeout')), remaining),
      ),
    ]);
    if (auth && auth.ok && auth.apiKey) {
      return { apiKey: auth.apiKey, headers: auth.headers };
    }
  } catch {
    // fall through
  }
  return undefined;
}

/**
 * Cheapest-and-fastest is not sufficient: a weak assessor produces expensive
 * downstream mistakes, so competence gates and price only ranks.
 *
 * `latencyMsTtft` ranks ties and does not gate on any fixed threshold: only 28
 * of 86 measured rows fall under 1500 ms and the median is 2500 ms, so a fixed
 * gate would reject most of the pool over a number that does not transfer
 * between deployments. The wall clock, via the AbortController, is what
 * enforces the deadline, because it measures the deployment rather than
 * predicting it.
 *
 * The one exclusion is arithmetic rather than prediction: a candidate whose
 * measured time to first *answer* already exceeds the whole end-to-end budget
 * cannot produce a verdict before the deadline aborts it, so selecting it
 * spends a provider request on a guaranteed expiry. Reasoning rows report
 * TTFT as the first *thinking* token (e.g. deepseek-v4-pro: 1.6 s thinking vs
 * 71.25 s to the first answer), and an assessor must return parsed answer
 * text, so the gate input is time-to-first-answer, falling back to TTFT when
 * the row carries no answer measurement. Unmeasured latency never excludes —
 * absent data is not evidence of slowness.
 */
export function selectAssessor(
  config: AssessmentConfig,
  registry: ExtensionContext['modelRegistry'] | undefined,
  candidates: Candidate[],
  strikes: ReadonlyMap<string, number> = new Map(),
): { model: Model<Api>; registryId: string } | undefined {
  if (!registry?.find || candidates.length === 0) return undefined;

  const resolve = (registryId: string) => {
    const parsed = parseProviderId(registryId);
    if (!parsed) return undefined;
    const model = registry.find(parsed.provider, parsed.id);
    return model ? { model: model as Model<Api>, registryId } : undefined;
  };

  if (config.modelRef && candidates.some((c) => c.registryId === config.modelRef)) {
    const override = resolve(config.modelRef);
    if (override) return override;
  }

  const best = candidates.reduce(
    (max, c) => Math.max(max, c.bench?.quality?.intelligence ?? 0),
    0,
  );
  if (best <= 0) return undefined;
  const floor = best * config.assessorQualityRatio;

  const eligible = candidates
    .filter((c) => (c.bench?.quality?.intelligence ?? -1) >= floor)
    .filter((c) => {
      if (!Number.isFinite(config.deadlineMs)) return true;
      const latency = c.bench?.latencyMsTtfa ?? c.bench?.latencyMsTtft;
      return latency == null || latency < config.deadlineMs;
    })
    .sort((a, b) => {
      // Struck assessors sink below un-struck ones: a model that failed to
      // emit a verdict before the deadline last time is tried only after
      // cheaper-and-unproven alternatives, but is never excluded (the pool
      // must never empty). Fewer strikes first.
      const strikeA = strikes.get(a.registryId) ?? 0;
      const strikeB = strikes.get(b.registryId) ?? 0;
      if (strikeA !== strikeB) return strikeA - strikeB;
      const priceA = blendedPricePer1M(a) ?? Infinity;
      const priceB = blendedPricePer1M(b) ?? Infinity;
      // Only subtract when prices differ — avoids NaN (Infinity - Infinity)
      // which silently corrupts sort ordering.
      if (priceA !== priceB) {
        const diff = priceA - priceB;
        if (Math.abs(diff) > 1e-9) return diff;
      }
      const ttft = (a.bench?.latencyMsTtft ?? Infinity) - (b.bench?.latencyMsTtft ?? Infinity);
      if (Number.isFinite(ttft) && ttft !== 0) return ttft;
      // Canonical id last so ordering never depends on registry insertion.
      return a.registryId.localeCompare(b.registryId);
    });

  for (const candidate of eligible) {
    const resolved = resolve(candidate.registryId);
    if (resolved) return resolved;
  }
  return undefined;
}

function usageFromEvent(
  event: unknown,
): { input: number; output: number; cacheRead?: number } | undefined {
  const usage = (event as { usage?: Record<string, unknown> } | undefined)?.usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return undefined;
  const input = Number(usage.inputTokens ?? usage.input ?? 0);
  const output = Number(usage.outputTokens ?? usage.output ?? 0);
  if (!Number.isFinite(input) && !Number.isFinite(output)) return undefined;
  const cacheRead = Number(usage.cacheRead ?? usage.cacheReadTokens ?? 0);
  return {
    input: Number.isFinite(input) ? input : 0,
    output: Number.isFinite(output) ? output : 0,
    cacheRead: Number.isFinite(cacheRead) && cacheRead > 0 ? cacheRead : undefined,
  };
}

function costFor(
  candidate: Candidate | undefined,
  usage: { input: number; output: number },
): number {
  const inputPerM = candidate?.cost?.input ?? 0;
  const outputPerM = candidate?.cost?.output ?? 0;
  return (usage.input / 1_000_000) * inputPerM + (usage.output / 1_000_000) * outputPerM;
}

/**
 * Provider of the assessor when its own failure message is a usage-limit
 * signal. Returns undefined when the message carries no such signal or no
 * registry id is available, so callers can attach it conditionally.
 */
function usageLimitProviderOf(
  message: string | undefined,
  registryId: string | undefined,
): string | undefined {
  if (!registryId || !isUsageLimitErrorMessage(message)) return undefined;
  const slash = registryId.indexOf('/');
  return slash > 0 ? registryId.slice(0, slash) : registryId;
}

export async function runAssessment(
  config: AssessmentConfig,
  registry: ExtensionContext['modelRegistry'] | undefined,
  candidates: Candidate[],
  evidence: AssessmentEvidence,
  strikes: ReadonlyMap<string, number> = new Map(),
): Promise<AssessmentAttempt> {
  if (!config.enabled) return { ok: false, fallbackReason: 'disabled', costUsd: 0, ms: 0 };

  const start = Date.now();
  const deadlineAt = start + config.deadlineMs;
  const controller = new AbortController();
  const expiry = setTimeout(() => controller.abort(), config.deadlineMs);
  let iterator: AsyncIterator<{ type: string }> | undefined;
  let usage = { input: 0, output: 0, cacheRead: undefined as number | undefined };
  let selectedRegistryId: string | undefined;
  let errorMessage: string | undefined;

  try {
    const selected = selectAssessor(config, registry, candidates, strikes);
    if (!selected) {
      debugLog('assessment.skip', { reason: 'no-assessor' });
      return { ok: false, fallbackReason: 'no-assessor', costUsd: 0, ms: Date.now() - start };
    }
    selectedRegistryId = selected.registryId;

    const auth = await resolveAuth(registry, selected.model, deadlineAt);
    if (!auth) {
      debugLog('assessment.skip', { reason: 'auth', model: selected.registryId });
      return { ok: false, fallbackReason: 'auth', costUsd: 0, ms: Date.now() - start };
    }

    const prompt = buildAssessmentPrompt(evidence, config.maxInputChars);
    const assessmentContext: Context = {
      messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
    };

    const stream = streamSimple(selected.model, assessmentContext, {
      apiKey: auth.apiKey,
      headers: auth.headers,
      signal: controller.signal,
    } as SimpleStreamOptions);

    let fullText = '';
    let expired = false;
    let streamError = false;
    iterator = (stream as AsyncIterable<{ type: string }>)[Symbol.asyncIterator]();

    while (true) {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) {
        expired = true;
        break;
      }
      let step: IteratorResult<{ type: string }>;
      try {
        step = await Promise.race([
          iterator.next(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('assessment stream timeout')), remaining),
          ),
        ]);
      } catch (err) {
        // Distinguish a genuine stream error (network, server 5xx) from the
        // deadline timeout above.
        if (err instanceof Error && err.message === 'assessment stream timeout') {
          expired = true;
        } else {
          streamError = true;
          // Keep the first signal: a usage-limit error event that arrived
          // before a dropped connection must not be overwritten by the
          // transport error that followed it.
          if (!errorMessage) errorMessage = err instanceof Error ? err.message : String(err);
        }
        break;
      }
      if (step.done) break;
      const event = step.value;
      const eventUsage = usageFromEvent(event);
      if (eventUsage) usage = { ...usage, ...eventUsage };
      if (event.type === 'error' && !errorMessage) {
        // A provider error event carries the usage-limit signature (e.g. 429
        // GoUsageLimitError) the caller needs to exclude the provider. Only a
        // genuine `stopReason: 'error'` counts — same gate as the serving path
        // (delegation.ts), so output-limit exhaustion (`stopReason: 'length'`)
        // can never blacklist a provider. `errorMessage` is the structured
        // field and is preferred over the loose `message`, mirroring
        // delegation's `errorMessageObj?.errorMessage ?? message`.
        const err = (event as unknown as {
          error?: { stopReason?: string; errorMessage?: string; message?: string };
        }).error;
        if (err?.stopReason === 'error') errorMessage = err?.errorMessage ?? err?.message;
      }
      if (
        event.type === 'text_delta' &&
        typeof (event as unknown as { delta?: string }).delta === 'string'
      ) {
        fullText += (event as unknown as { delta: string }).delta;
      }
    }

    const candidate = candidates.find((c) => c.registryId === selected.registryId);
    const costUsd = costFor(candidate, usage);
    const ms = Date.now() - start;
    const parsed = parseAssessment(fullText);

    if (!parsed) {
      // A cancelled or unparseable attempt still cost money; report the spend
      // so the routing tax stays visible even when the verdict is unusable.
      const reason: AssessmentFallbackReason = expired ? 'expiry' : streamError ? 'error' : 'parse';
      const usageLimitProvider = usageLimitProviderOf(errorMessage, selectedRegistryId);
      debugLog('assessment.skip', {
        reason,
        model: selected.registryId,
        ms,
        costUsd,
        textChars: fullText.length,
        ...(usageLimitProvider ? { usageLimitProvider } : {}),
      });
      return {
        ok: false,
        fallbackReason: reason,
        costUsd,
        ms,
        model: selected.registryId,
        producedOutput: fullText.length > 0,
        ...(usageLimitProvider ? { usageLimitProvider } : {}),
      };
    }

    return {
      ok: true,
      assessment: {
        ...parsed,
        model: selected.registryId,
        ms,
        usage,
        costUsd,
      },
    };
  } catch (err) {
    const ms = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    const usageLimitProvider = usageLimitProviderOf(message, selectedRegistryId);
    debugLog('assessment.error', {
      message,
      ms,
      ...(usageLimitProvider ? { usageLimitProvider } : {}),
    });
    return {
      ok: false,
      fallbackReason: 'error',
      costUsd: 0,
      ms,
      ...(usageLimitProvider ? { usageLimitProvider } : {}),
    };
  } finally {
    clearTimeout(expiry);
    controller.abort();
    try {
      await iterator?.return?.(undefined as never);
    } catch {
      // A provider that refuses cancellation must not fail the turn.
    }
  }
}
