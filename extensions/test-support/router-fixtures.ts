/**
 * Shared test factories for the router's delegation, scoring, and subagent
 * tests.
 *
 * These intentionally construct minimal, schema-shaped objects (not real
 * provider models) so `runDelegationLoop`/scorer/classifier can exercise their
 * logic without touching the network or the model registry. Every factory
 * accepts typed partial overrides and returns fresh objects (nested objects
 * are merged, not shared) so one test mutating a fixture cannot leak into
 * another.
 */
import type { Api } from '@earendil-works/pi-ai';

import type { RegistryModelInfo } from '../scorer.js';
import type { BenchModel, Candidate, RoutingDecision } from '../types.js';
import type { SubagentResultRow } from '../subagent-results.js';

/** A minimal, hand-filled routing decision across `chain`. */
export function routingDecision(chain: string[]): RoutingDecision {
  return {
    dimension: 'implement',
    chosen: chain[0]!,
    reason: 'test decision',
    confidence: 1,
    routedUp: false,
    routedDown: false,
    cause: 'heuristic',
    fallbackChain: [...chain],
  };
}

/**
 * Build a minimal registry model whose id is derived from `registryId`
 * (`provider/id`). Satisfies `RegistryModelInfo` for scoring/subagent tests
 * and carries the name/api/baseUrl fields the delegation harness needs when
 * casting to a live `Model<Api>`.
 */
export function registryModel(
  registryId: string,
  overrides: Partial<RegistryModelInfo> & { name?: string; api?: Api; baseUrl?: string } = {},
): RegistryModelInfo & { name: string; api: Api; baseUrl: string } {
  const slash = registryId.indexOf('/');
  const provider = registryId.slice(0, slash);
  const id = registryId.slice(slash + 1);
  return {
    provider,
    id,
    name: id,
    api: 'openai-completions',
    baseUrl: `https://${provider}.example.test`,
    contextWindow: 128_000,
    maxTokens: 8_192,
    input: ['text'],
    reasoning: false,
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  } as RegistryModelInfo & { name: string; api: Api; baseUrl: string };
}

/** A benchmark row for `registryId` with neutral quality defaults. */
export function benchRow(
  registryId: string,
  overrides: Partial<BenchModel> = {},
): BenchModel {
  const result: BenchModel = {
    registryId,
    benchSlug: registryId.split('/').at(-1)!,
    active: true,
    quality: { intelligence: 75, coding: 75, agenticCoding: 75 },
    source: 'test',
    ...overrides,
  };
  result.quality = {
    intelligence: 75,
    coding: 75,
    agenticCoding: 75,
    ...overrides.quality,
  };
  return result;
}

/**
 * A routable candidate for `registryId`. `cost` is merged fresh when an
 * override provides one; an explicit `cost: undefined` stays undefined so
 * unknown-price tests can exercise the absence of price data.
 */
export function candidate(
  registryId: string,
  overrides: Partial<Candidate> = {},
): Candidate {
  const slash = registryId.indexOf('/');
  const provider = registryId.slice(0, slash);
  const id = registryId.slice(slash + 1);
  const DEFAULT_COST = {
    input: 0.000003,
    output: 0.000015,
    cacheRead: 0.0000003,
    cacheWrite: 0.00000375,
  };
  const result: Candidate = {
    registryId,
    provider,
    id,
    contextWindow: 200_000,
    vision: false,
    reasoning: false,
    cost: DEFAULT_COST,
    available: true,
    ...overrides,
  };
  if (overrides.cost && typeof overrides.cost === 'object') {
    result.cost = { ...DEFAULT_COST, ...overrides.cost };
  }
  return result;
}

/** A `subagent` tool_result row with neutral defaults. */
export function subagentResultRow(
  overrides: Partial<SubagentResultRow> = {},
): SubagentResultRow {
  return {
    index: 0,
    agent: 'worker',
    model: 'provider/fast:high',
    exitCode: 0,
    finalOutput: 'done',
    modelAttempts: [],
    ...overrides,
  };
}
