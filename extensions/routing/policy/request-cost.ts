/**
 * Request-shaped cost arithmetic: what one provider request costs at a
 * candidate's rates, before it is sent and after it settles. Pure; it prices
 * requests and selects nothing.
 *
 * An unknown price stays unknown: zero is a price only when provider metadata
 * says the model is free.
 */
import type { Usage } from '@earendil-works/pi-ai';
import type { Candidate } from '../../types.js';
import { inputOutputPricePer1M } from '../score/scorer.js';

/** Expected token counts for one request. */
export interface RequestTokens {
  input: number;
  output: number;
}

/**
 * Providers that can bill each request, not tokens: one request can cost a
 * whole request (times the model's multiplier), whatever its token count.
 */
export const REQUEST_BILLED_PROVIDERS: ReadonlySet<string> = new Set(['github-copilot']);

/** Whether the candidate's provider can bill per request. */
export function requestBilled(registryId: string): boolean {
  return REQUEST_BILLED_PROVIDERS.has(registryId.split('/')[0] ?? '');
}

/** Expected USD for a request of `tokens` at the candidate's input and output rates. */
export function expectedRequestCost(candidate: Candidate, tokens: RequestTokens): number | undefined {
  if (
    !Number.isFinite(tokens.input)
    || tokens.input < 0
    || !Number.isFinite(tokens.output)
    || tokens.output < 0
  ) return undefined;
  const price = inputOutputPricePer1M(candidate);
  if (!price) return undefined;
  return (tokens.input / 1_000_000) * price.input
    + (tokens.output / 1_000_000) * price.output;
}

/**
 * USD a settled request cost. Registry pricing is authoritative when the
 * candidate's rates come from it: the provider's reported total wins, and
 * cache reads and writes are priced at the registry's cache rates. Otherwise
 * the rates are benchmark rates, so only input and output are priced; a
 * reported total there reflects prices the router does not rank on. Custom
 * providers build their own messages, so counts are checked, not trusted.
 */
export function observedRequestCost(candidate: Candidate | undefined, usage: Usage | undefined): number | undefined {
  const price = candidate ? inputOutputPricePer1M(candidate) : undefined;
  if (!price) return undefined;
  const count = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  const registryInput = candidate?.cost?.input;
  const registryOutput = candidate?.cost?.output;
  const registryPricingIsAuthoritative = Number.isFinite(registryInput)
    && Number.isFinite(registryOutput)
    && registryInput! >= 0
    && registryOutput! >= 0
    && registryInput === price.input
    && registryOutput === price.output;
  const reported = count(usage?.cost?.total);
  if (registryPricingIsAuthoritative && reported != null) return reported;
  const cacheRate = (rate: number | undefined) =>
    registryPricingIsAuthoritative && Number.isFinite(rate) ? Math.max(0, rate!) : 0;
  return ((count(usage?.input) ?? 0) / 1_000_000) * price.input
    + ((count(usage?.output) ?? 0) / 1_000_000) * price.output
    + ((count(usage?.cacheRead) ?? 0) / 1_000_000) * cacheRate(candidate?.cost?.cacheRead)
    + ((count(usage?.cacheWrite) ?? 0) / 1_000_000) * cacheRate(candidate?.cost?.cacheWrite);
}
