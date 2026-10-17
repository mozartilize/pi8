/**
 * Candidate identity, capability reads, thinking levels, and candidate
 * construction for model routing.
 *
 * No I/O. No registry access. Testable with fixture tables.
 */
import type { Candidate, Dimension, QualityAxis } from '../../types.js';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import type { ModelCostTier, ModelPromptCache, ModelThinkingLevel, ThinkingLevel, ThinkingLevelMap } from '@earendil-works/pi-ai';

// ─── Candidate identity ─────────────────────────────────────────────

/** Every level a bench row can be measured at; also the key-suffix alphabet. */
export const MODEL_THINKING_LEVELS: readonly ModelThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

const isModelThinkingLevel = (v: string): boolean =>
  (MODEL_THINKING_LEVELS as readonly string[]).includes(v);

/**
 * Identity of one routable entity: `provider/id` for an unmeasured model,
 * `provider/id:effort` for a measured (model, effort) pair. Two effort
 * variants of one model are two chain entries, two blacklist keys, two
 * incumbent keys.
 */
export function candidateKey(c: Pick<Candidate, 'registryId' | 'effort'>): string {
  return c.effort != null ? `${c.registryId}:${c.effort}` : c.registryId;
}

export interface ParsedCandidateKey {
  provider: string;
  id: string;
  effort?: ModelThinkingLevel;
}

/**
 * Reverse of {@link candidateKey}. The effort suffix is only split when it is
 * exactly one of the known levels, so ids that legitimately contain colons
 * (e.g. openrouter `deepseek/deepseek-r1:free`) parse fail-closed as ids.
 */
export function parseCandidateKey(key: string): ParsedCandidateKey {
  const colon = key.lastIndexOf(':');
  const effort =
    colon > 0 && isModelThinkingLevel(key.slice(colon + 1))
      ? (key.slice(colon + 1) as ModelThinkingLevel)
      : undefined;
  const base = effort != null ? key.slice(0, colon) : key;
  const slash = base.indexOf('/');
  if (slash <= 0) return { provider: base, id: base, ...(effort != null ? { effort } : {}) };
  return {
    provider: base.slice(0, slash),
    id: base.slice(slash + 1),
    ...(effort != null ? { effort } : {}),
  };
}

// ─── Per-dimension quality projection ───────────────────────────────

/**
 * Measured capability of a candidate for a dimension, or undefined when the
 * candidate carries no benchmark row on that dimension's axis. Implementation
 * reads agentic coding, with coding as the fallback; every other dimension
 * reads intelligence. Exported so the routing policy can compare an incumbent
 * against a fresh pick without duplicating the per-dimension axis mapping.
 */
export function capabilityForDimension(c: Candidate, dim: Dimension): number | undefined {
  const quality = c.bench?.quality;
  const value = dim === 'implement' ? quality?.agenticCoding ?? quality?.coding : quality?.intelligence;
  return value != null && Number.isFinite(value) ? value : undefined;
}

type Minimums = Readonly<Partial<Record<QualityAxis, number>>>;

/**
 * Fixed capability minimums for a task type, on Artificial Analysis
 * Intelligence Index v4.3 scales, calibrated on 2026-10-02 against the models
 * the router serves. AA rescales its indexes between versions: a new version
 * needs a new calibration here.
 *
 * - gather: intelligence 20 keeps out mini and non-reasoning variants.
 * - plan, review: intelligence 30; Omniscience 0, so the model states facts
 *   right at least as often as wrong; AA-Briefcase rubric 0.35, so its work
 *   from many source files holds up when checked.
 * - implement: agentic coding 34, the Terminal-Bench 4.0 pass rate in
 *   percent (calibrated on 2026-10-08). 34 is 0.53 of the reference.
 * - lightweight: none; trivial work goes to the cheapest model.
 */
const CAPABILITY_MINIMUMS: Readonly<Record<Dimension, Minimums>> = {
  lightweight: {},
  gather: { intelligence: 20 },
  plan: { intelligence: 30, knowledge: 0, research: 0.35 },
  review: { intelligence: 30, knowledge: 0, research: 0.35 },
  implement: { agenticCoding: 34 },
};

/**
 * Strongest value measured on each axis when `CAPABILITY_MINIMUMS` was
 * calibrated. A handoff requirement is a share of these, so the difficulty
 * scale means the same in every request, whatever models the pool holds.
 */
export const AXIS_REFERENCE: Readonly<Record<Exclude<QualityAxis, 'knowledge'>, number>> = {
  intelligence: 57.6,
  coding: 78.3,
  agenticCoding: 63.6,
  agenticIndex: 57.9,
  research: 0.61,
  longContext: 1,
  visionReasoning: 1,
};

/** The Intelligence Index major.minor version that the minimums above are calibrated for. */
export const CALIBRATED_INDEX_VERSION = '4.3';

/**
 * A warning when the synced index version is not the calibrated version.
 * A new version can change evaluations and scales, but the user chose to
 * keep routing: the warning asks for a recalibration and does not block.
 */
export function indexVersionWarning(version: string | undefined): string | undefined {
  const reported = version?.trim().replace(/^v/i, '').split('.').slice(0, 2).join('.');
  if (reported === CALIBRATED_INDEX_VERSION) return undefined;
  return `Artificial Analysis Intelligence Index ${reported ? `version ${reported}` : 'version is not reported'}. `
    + `The capability minimums are calibrated for version ${CALIBRATED_INDEX_VERSION}. Routing continues with these minimums.`;
}

/** The strongest handoff requirement: the work keeps a model near the reference. */
export const FRONTIER_REQUIREMENT = 0.85;

/**
 * The task type's fixed minimums of the policy as one requirement: the largest
 * share of an axis reference among them. The Omniscience minimum is not a
 * share of a reference, so it does not count.
 */
export function defaultRequirement(dimension: Dimension): number {
  const fixed = CAPABILITY_MINIMUMS[dimension];
  const shares = (Object.keys(fixed) as QualityAxis[])
    .filter((axis): axis is Exclude<QualityAxis, 'knowledge'> => axis !== 'knowledge')
    .map((axis) => fixed[axis]! / AXIS_REFERENCE[axis]);
  return Math.max(0, ...shares);
}

/**
 * Resolve a served or submitter identity against a live candidate set.
 * The identity may carry effective effort (`provider/id:medium`) even when
 * the measured row is unsuffixed. Match the base `provider/id` and prefer
 * the exact effort variant. A different effort variant is a different
 * measurement and cannot stand in for the source.
 */
export function findSourceCandidate(
  candidates: readonly Candidate[],
  fromModel: string,
): Candidate | undefined {
  const exact = candidates.find((c) => candidateKey(c) === fromModel);
  if (exact) return exact;
  const parsed = parseCandidateKey(fromModel);
  const base = `${parsed.provider}/${parsed.id}`;
  const sameBase = candidates.filter((c) => c.registryId === base);
  if (parsed.effort != null) {
    const sameEffort = sameBase.find((c) => c.effort === parsed.effort);
    if (sameEffort) return sameEffort;
  }
  return sameBase.find((c) => c.effort == null);
}

export interface StrongerCompareOpts {
  /** Explicit user/session thinking request, when it outranks labelled effort. */
  userReasoning?: ThinkingLevel;
  userReasoningOverride?: boolean;
}

/**
 * Effort the candidate will actually serve after the model's support map
 * and an explicit user override. Labelled efforts go through `levelFrom`,
 * so a labelled effort that the model cannot send is not treated as served.
 */
export function servedEffort(
  candidate: Pick<Candidate, 'effort' | 'reasoning' | 'thinkingLevelMap'>,
  opts?: StrongerCompareOpts,
): ModelThinkingLevel | undefined {
  if (candidate.effort != null && !opts?.userReasoningOverride) {
    return levelFrom(candidate.effort, candidate);
  }
  return resolveThinkingLevel(candidate, opts?.userReasoning);
}

// ─── Context fit ─────────────────────────────────────────────────────

/** A context window holds a prompt with this margin for output and estimation error. */
export const CONTEXT_FIT_MARGIN = 1.2;

/** True when the window holds the prompt. An unknown window is not a reason to reject. */
export const holdsPrompt = (contextWindow: number | undefined, promptTokens: number): boolean =>
  !contextWindow || contextWindow <= 0 || contextWindow >= promptTokens * CONTEXT_FIT_MARGIN;

const THINKING_LEVELS: ModelThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Pi's own rule, read from Pi so the two cannot differ: a null map entry is
 * an unsupported level, `off` included, and `xhigh`/`max` need an explicit
 * entry. A model without reasoning has no thinking level to send, so it
 * supports none here; Pi lists only `off` for it.
 */
function isThinkingSupported(
  c: Pick<Candidate, 'reasoning' | 'thinkingLevelMap'> | undefined,
  level: ModelThinkingLevel,
): boolean {
  if (!c?.reasoning) return false;
  return getSupportedThinkingLevels(c as Parameters<typeof getSupportedThinkingLevels>[0]).includes(level);
}

export function isThinkingSupportedByRegistryModel(
  c: Pick<RegistryModelInfo, 'reasoning' | 'thinkingLevelMap'> | undefined,
  level: ModelThinkingLevel,
): boolean {
  return isThinkingSupported(c, level);
}

/**
 * Providers that cannot turn thinking off. Pi sends no reasoning for `off`,
 * and these providers then send no effort, so the model runs at its own
 * default effort. A measured `off` row describes a request they never send.
 */
const PROVIDERS_WITHOUT_THINKING_OFF: ReadonlySet<string> = new Set(['claude-bridge']);

/**
 * Whether a request at `off` runs the mode an `off` row measures: always for
 * a model without reasoning, and for a reasoning model only when it supports
 * `off` and its provider can turn thinking off.
 */
export function servesThinkingOff(
  m: Pick<RegistryModelInfo, 'provider' | 'reasoning' | 'thinkingLevelMap'>,
): boolean {
  if (!m.reasoning) return true;
  return isThinkingSupported(m, 'off') && !PROVIDERS_WITHOUT_THINKING_OFF.has(m.provider);
}

export function levelFrom(
  level: ModelThinkingLevel,
  c: Pick<Candidate, 'reasoning' | 'thinkingLevelMap'>,
): ModelThinkingLevel | undefined {
  const start = THINKING_LEVELS.indexOf(level);
  for (let i = start; i < THINKING_LEVELS.length; i++) {
    const l = THINKING_LEVELS[i]!;
    if (isThinkingSupported(c, l)) return l;
  }
  return undefined;
}

/**
 * The router's effort for a candidate: its measured (or estimated) effort,
 * raised only to the nearest level the model supports. Each effort has its
 * own score, so the scorer has already chosen the effort for the task. A
 * candidate with no effort label gets no router choice; the caller sends
 * Pi's session thinking level, as Pi does when a user selects that model.
 */
export function chooseThinkingLevel(c: Candidate | undefined): ModelThinkingLevel | undefined {
  if (!c?.reasoning || c.effort == null) return undefined;
  return levelFrom(c.effort, c);
}

export function resolveThinkingLevel(
  c: Pick<Candidate, 'reasoning' | 'thinkingLevelMap'> | undefined,
  requested: ThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (!c?.reasoning) return undefined;
  if (requested) {
    const index = THINKING_LEVELS.indexOf(requested as ModelThinkingLevel);
    if (index >= 0) {
      for (let offset = 0; offset < THINKING_LEVELS.length; offset++) {
        const up = index + offset;
        if (up < THINKING_LEVELS.length) {
          const level = THINKING_LEVELS[up]!;
          if (isThinkingSupported(c, level)) return level;
        }
        const down = index - offset;
        if (down >= 0) {
          const level = THINKING_LEVELS[down]!;
          if (isThinkingSupported(c, level)) return level;
        }
      }
    }
    return undefined;
  }
  return chooseThinkingLevel(c as Candidate | undefined);
}

export function buildRouterThinkingLevelMap(
  models: readonly RegistryModelInfo[],
): ThinkingLevelMap {
  const map: Partial<Record<ModelThinkingLevel, string | null>> = {};
  for (const level of THINKING_LEVELS) {
    map[level] = models.some((m) => isThinkingSupportedByRegistryModel(m as Pick<RegistryModelInfo, 'reasoning' | 'thinkingLevelMap'>, level))
      ? level
      : null;
  }
  return map as ThinkingLevelMap;
}

// ─── Build candidates from registry + store ───────────────────────────

export interface RegistryModelInfo {
  provider: string;
  id: string;
  api?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  input?: readonly ('text' | 'image')[];
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    /** Request-wide rates. The highest threshold that the prompt tokens exceed applies to the full request. */
    tiers?: readonly ModelCostTier[];
  };
  /** Prompt cache lifetime in seconds per retention tier. A missing tier means the lifetime is unknown. */
  promptCache?: ModelPromptCache;
  /** API-specific compatibility flags; only `supportsMidConvoEffort` is read. */
  compat?: object;
}

export function buildCandidate(
  model: RegistryModelInfo,
  bench?: Candidate['bench'],
): Candidate {
  return {
    registryId: `${model.provider}/${model.id}`,
    provider: model.provider,
    id: model.id,
    bench,
    // A candidate built from an effort-labelled row serves at exactly that
    // measured effort; a candidate without a bench row (or with an unlabelled
    // row) carries no effort and Pi's session thinking level applies.
    effort: bench?.effort,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    vision: model.input?.includes('image') ?? false,
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
    // pi-ai sends effort per message only on these models, which keeps the
    // cached prefix; every other call path sets effort on the request.
    ...(model.api === 'anthropic-messages' &&
      (model.compat as { supportsMidConvoEffort?: unknown } | undefined)?.supportsMidConvoEffort === true
      ? { effortSharesCache: true }
      : {}),
    cost: model.cost,
    available: true,
  };
}
