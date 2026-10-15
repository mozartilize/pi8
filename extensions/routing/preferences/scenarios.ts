/**
 * Frozen v1 preference scenarios: the meaning of every stored v1 answer.
 *
 * Each scenario compares two synthetic actions with full ten-feature vectors
 * in the order of `FEATURE_NAMES`. The values are normalized desirabilities
 * of hypothetical alternatives, not live benchmark rows, not current prices
 * and not success probabilities. A benchmark refresh never changes them. A
 * change to any vector, price, transform anchor or scenario text requires
 * `preferences.version` 2 and an explicit migration or reconfirmation.
 */
import { digestOf } from '../digest.js';
import { FEATURE_COUNT, FEATURE_SCHEMA_DIGEST } from '../features/schema.js';
import type { PreferenceKey } from './schema.js';

export interface ScenarioOptionV1 {
  /** Short label shown in the questionnaire. */
  label: string;
  /** Hypothetical all-in USD per decision; the cost feature is its transform. */
  usd: number;
  features: readonly number[];
}

export interface PreferenceScenarioV1 {
  key: PreferenceKey;
  title: string;
  /** Conditions held constant. */
  context: string;
  question: string;
  A: ScenarioOptionV1;
  B: ScenarioOptionV1;
  /** Primary trade-off the question resolves. */
  tradeOff: string;
}

export const CORE_SCENARIOS_V1: Readonly<Record<PreferenceKey, PreferenceScenarioV1>> = {
  settledImplementation: {
    key: 'settledImplementation',
    title: 'Settled implementation',
    context: 'The plan is settled and relevant tests exist. Effort and evidence are the same.',
    question: 'Would you prefer the lower-cost candidate with a slightly lower coding benchmark, or the stronger coding benchmark at higher cost?',
    A: { label: 'Lower cost', usd: 0.07, features: [0.45, 0.52, 0.3, 0.55, 0.35915, 0.6, 0.55, 1, 0, 0] },
    B: { label: 'Higher coding capability', usd: 0.1, features: [0.45, 0.62, 0.3, 0.55, 0.333333, 0.6, 0.55, 1, 0, 0] },
    tradeOff: 'Cost against coding fit for settled work',
  },
  openDesignDecisions: {
    key: 'openDesignDecisions',
    title: 'Open design decisions',
    context: 'Interface or design choices remain open. Grounding and latency are the same.',
    question: 'Would you prefer the cheaper candidate with a lower reasoning benchmark, or the stronger reasoning benchmark at higher cost?',
    A: { label: 'Lower cost', usd: 0.05, features: [0.55, 0.45, 0.3, 0.55, 0.383505, 0.6, 0.6, 1, 0, 0] },
    B: { label: 'Higher reasoning capability', usd: 0.1, features: [0.74, 0.45, 0.3, 0.55, 0.333333, 0.6, 0.6, 1, 0, 0] },
    tradeOff: 'Cost against reasoning under uncertainty',
  },
  handoffWarmCache: {
    key: 'handoffWarmCache',
    title: 'Warm cache at a handoff',
    context: 'An authorized assignment boundary. The previous model has an 80K-token warm prefix; the other model starts cold. Both can serve.',
    question: 'Would you keep the warm incumbent at a lower cached cost, or switch to the model with higher relevant capability at a higher cold cost?',
    A: { label: 'Keep the warm incumbent', usd: 0.04, features: [0.56, 0.45, 0.4, 0.55, 0.399657, 0.6, 0.65, 1, 0, 0] },
    B: { label: 'Switch for capability', usd: 0.15, features: [0.8, 0.45, 0.4, 0.55, 0.303985, 0.6, 0.45, 1, 0, 0] },
    tradeOff: 'Cache-priced cost against capability fit',
  },
  researchTasks: {
    key: 'researchTasks',
    title: 'Research tasks',
    context: 'Research or review work with external dependencies.',
    question: 'Would you prefer the cheaper candidate with a stronger coding benchmark, or the more expensive candidate with a stronger research benchmark?',
    A: { label: 'Lower cost', usd: 0.06, features: [0.55, 0.62, 0.4, 0.55, 0.370308, 0.6, 0.55, 1, 0, 0] },
    B: { label: 'Higher research capability', usd: 0.12, features: [0.55, 0.44, 0.75, 0.55, 0.320136, 0.6, 0.55, 1, 0, 0] },
    tradeOff: 'Research fit against cost',
  },
  afterRework: {
    key: 'afterRework',
    title: 'After verified rework',
    context: 'Verified rework is attributed to the old exact effort. Neither option has failed. Capability, cost, latency and uncertainty are the same.',
    question: 'Would you retry with the same model at a higher effort, or switch to a different model?',
    A: { label: 'Same model, higher effort', usd: 0.1, features: [0.6, 0.6, 0.3, 0.55, 0.333333, 0.6, 0.78, 1, 1, 0] },
    B: { label: 'Different model', usd: 0.1, features: [0.6, 0.6, 0.3, 0.55, 0.333333, 0.6, 0.48, 1, 0, 1] },
    tradeOff: 'Recovery action preference; not proof that either action succeeds',
  },
};

for (const scenario of Object.values(CORE_SCENARIOS_V1)) {
  for (const option of [scenario.A, scenario.B]) {
    // A stored v1 answer means a comparison of these exact vectors; a vector of
    // another length or outside [0, 1] does not fit the feature schema.
    if (option.features.length !== FEATURE_COUNT || !option.features.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) {
      throw new Error(`scenario ${scenario.key} option ${option.label} does not match the feature schema`);
    }
    Object.freeze(option.features);
  }
}

export const CORE_SCENARIOS_V1_DIGEST = digestOf({ scenarios: CORE_SCENARIOS_V1, featureSchema: FEATURE_SCHEMA_DIGEST });

/** `phi(A) - phi(B)` of a scenario. */
export const scenarioDelta = (key: PreferenceKey): number[] => {
  const { A, B } = CORE_SCENARIOS_V1[key];
  return A.features.map((value, index) => value - B.features[index]!);
};
