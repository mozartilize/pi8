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
import { contentText, type AssistantMessage, type AssistantMessageEventStream, type Model, type Api, type Context, type Usage } from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import type {
  AssessmentFallbackReason,
  AssessorTokenEstimate,
  Candidate,
  RoutingAssessment,
} from '../../types.js';
import { buildAssessmentPrompt, parseAssessment, type AssessmentEvidence } from './assessment-prompt.js';
import { debugLog } from '../../host/debuglog.js';
import { inputOutputPricePer1M } from '../score/scorer.js';
import { getAssessorTokenEstimate } from '../../serve/router-session-state.js';
import { isUsageLimitErrorMessage } from '../../serve/usage-limit.js';

export const DEFAULT_ASSESSOR_OUTPUT_TOKENS = 80;

/** How long a cancelled request may take to deliver its terminal message. */
const ABORT_SETTLE_MS = 100;

export interface AssessmentConfig {
  /** Mirrors `config.consultRouter`; false means fully deterministic routing. */
  enabled: boolean;
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

/**
 * The terminal message, or undefined when the provider ignores cancellation.
 * A cancelled Pi provider settles with `stopReason: 'aborted'` and its partial
 * content and usage, which carry the spend and the partial-output signal; the
 * short settle window after abort is what lets that message arrive.
 */
function settledResult(
  stream: AssistantMessageEventStream,
  signal: AbortSignal,
): Promise<AssistantMessage | undefined> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => { timer = setTimeout(() => resolve(undefined), ABORT_SETTLE_MS); };
    signal.addEventListener('abort', onAbort, { once: true });
    void stream.result().then(resolve).finally(() => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    });
  });
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
export function expectedAssessorCost(
  candidate: Candidate,
  expectedUsage: AssessorTokenEstimate,
): number | undefined {
  if (
    !Number.isFinite(expectedUsage.input)
    || expectedUsage.input < 0
    || !Number.isFinite(expectedUsage.output)
    || expectedUsage.output < 0
  ) return undefined;
  const price = inputOutputPricePer1M(candidate);
  if (!price) return undefined;
  return (expectedUsage.input / 1_000_000) * price.input
    + (expectedUsage.output / 1_000_000) * price.output;
}

export function selectAssessor(
  config: AssessmentConfig,
  registry: ExtensionContext['modelRegistry'] | undefined,
  candidates: Candidate[],
  strikes: ReadonlyMap<string, number> = new Map(),
  expectedUsage?: AssessorTokenEstimate,
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

  const shape = expectedUsage ?? {
    input: Number.isFinite(config.maxInputChars) ? Math.max(0, config.maxInputChars / 4) : 0,
    output: DEFAULT_ASSESSOR_OUTPUT_TOKENS,
  };
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
      const priceA = expectedAssessorCost(a, shape) ?? Infinity;
      const priceB = expectedAssessorCost(b, shape) ?? Infinity;
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

interface ObservedAssessmentUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  reportedCostUsd?: number;
}

/** Custom providers build their own messages, so counts are checked, not trusted. */
function observedUsage(usage: Usage | undefined): ObservedAssessmentUsage {
  const count = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  return {
    input: count(usage?.input) ?? 0,
    output: count(usage?.output) ?? 0,
    cacheRead: count(usage?.cacheRead) || undefined,
    cacheWrite: count(usage?.cacheWrite) || undefined,
    reportedCostUsd: count(usage?.cost?.total),
  };
}

function costFor(
  candidate: Candidate | undefined,
  usage: ObservedAssessmentUsage,
): number {
  const price = candidate ? inputOutputPricePer1M(candidate) : undefined;
  if (!price) return 0;
  const registryInput = candidate?.cost?.input;
  const registryOutput = candidate?.cost?.output;
  const registryPricingIsAuthoritative = Number.isFinite(registryInput)
    && Number.isFinite(registryOutput)
    && registryInput! >= 0
    && registryOutput! >= 0
    && registryInput === price.input
    && registryOutput === price.output;
  if (registryPricingIsAuthoritative && usage.reportedCostUsd != null) {
    return usage.reportedCostUsd;
  }
  const cacheReadPerM = registryPricingIsAuthoritative && Number.isFinite(candidate?.cost?.cacheRead)
    ? Math.max(0, candidate!.cost!.cacheRead!)
    : 0;
  const cacheWritePerM = registryPricingIsAuthoritative && Number.isFinite(candidate?.cost?.cacheWrite)
    ? Math.max(0, candidate!.cost!.cacheWrite!)
    : 0;
  return (usage.input / 1_000_000) * price.input
    + (usage.output / 1_000_000) * price.output
    + ((usage.cacheRead ?? 0) / 1_000_000) * cacheReadPerM
    + ((usage.cacheWrite ?? 0) / 1_000_000) * cacheWritePerM;
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
  tokenEstimator: (fallback: AssessorTokenEstimate) => AssessorTokenEstimate = getAssessorTokenEstimate,
): Promise<AssessmentAttempt> {
  if (!config.enabled) return { ok: false, fallbackReason: 'disabled', costUsd: 0, ms: 0 };

  const start = Date.now();
  const controller = new AbortController();
  const expiry = setTimeout(() => controller.abort(new Error('assessment deadline exceeded')), config.deadlineMs);
  let selectedRegistryId: string | undefined;

  try {
    const prompt = buildAssessmentPrompt(evidence, config.maxInputChars);
    const expectedUsage = tokenEstimator({
      input: prompt.length / 4,
      output: DEFAULT_ASSESSOR_OUTPUT_TOKENS,
    });
    const selected = selectAssessor(config, registry, candidates, strikes, expectedUsage);
    if (!selected) {
      debugLog('assessment.skip', { reason: 'no-assessor' });
      return { ok: false, fallbackReason: 'no-assessor', costUsd: 0, ms: Date.now() - start };
    }
    selectedRegistryId = selected.registryId;

    const assessmentContext: Context = {
      messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
    };

    // Registry dispatch resolves request auth, races it against the deadline,
    // and selects custom providers. The hook runs after auth and before the
    // provider, so a setup failure keeps its own 'auth' fallback.
    let requestReady = false;
    const stream = registry!.streamSimple(selected.model, assessmentContext, {
      signal: controller.signal,
      transformHeaders: (headers) => {
        requestReady = true;
        return headers;
      },
    });

    // The first terminal event wins: a transport failure after a usage-limit
    // error cannot replace it.
    const message = await settledResult(stream, controller.signal);
    // Custom providers may build an error message without content.
    const fullText = message?.content ? contentText(message.content) : '';
    const usage = observedUsage(message?.usage);
    // Only `stopReason: 'error'` is provider failure, as on the serving path;
    // output-limit exhaustion (`length`) can never blacklist a provider.
    const providerFailed = message?.stopReason === 'error';
    const errorMessage = providerFailed ? message.errorMessage : undefined;

    const candidate = candidates.find((c) => c.registryId === selected.registryId);
    const costUsd = costFor(candidate, usage);
    const reportedUsage = {
      input: usage.input,
      output: usage.output,
      ...(usage.cacheRead == null ? {} : { cacheRead: usage.cacheRead }),
      ...(usage.cacheWrite == null ? {} : { cacheWrite: usage.cacheWrite }),
    };
    const ms = Date.now() - start;
    const parsed = parseAssessment(fullText);

    if (!parsed) {
      // A cancelled or unparseable attempt still cost money; report the spend
      // so the routing tax stays visible even when the verdict is unusable.
      const reason: AssessmentFallbackReason = controller.signal.aborted ? 'expiry'
        : !requestReady ? 'auth' : providerFailed ? 'error' : 'parse';
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
        usage: reportedUsage,
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
      model: selectedRegistryId,
      producedOutput: false,
      ...(usageLimitProvider ? { usageLimitProvider } : {}),
    };
  } finally {
    clearTimeout(expiry);
    controller.abort();
  }
}
