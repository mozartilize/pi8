/**
 * Feature schema of the unified selector: ten bounded desirability features
 * in [0, 1], larger is better, in one fixed order. Weight vectors, preference
 * scenarios and feature vectors all use this order.
 */
import { digestOf } from '../digest.js';

export const FEATURE_NAMES = [
  'reasoningFit',
  'agenticFit',
  'researchFit',
  'inputFit',
  'costDesirability',
  'timeDesirability',
  'continuity',
  'frictionAvoidance',
  'effortRecoveryFit',
  'modelSwitchRecoveryFit',
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];
export const FEATURE_COUNT = FEATURE_NAMES.length;
export const FEATURE_INDEX: Readonly<Record<FeatureName, number>> = Object.fromEntries(
  FEATURE_NAMES.map((name, index) => [name, index]),
) as Record<FeatureName, number>;

/**
 * Mapping identity recorded with every feature value. Each feature module owns
 * its authored policy values: transforms, missing-value intervals, central
 * representatives and relevances. These values are not calibrated
 * measurements. A change to one of them is a feature-policy revision. If the
 * change alters what a stored preference scenario means, `preferences.version`
 * must also increase. A benchmark refresh changes observations, not policy.
 */
export const FEATURE_MAPPING_VERSION = 'feature-v11' as const;

export const FEATURE_SCHEMA_DIGEST = digestOf({ names: FEATURE_NAMES, mapping: FEATURE_MAPPING_VERSION });

/**
 * Provenance of one benchmark quality axis. Only `measured` is an exact
 * observation. `source-estimated` may supply a central representative but
 * keeps the missing interval. The other values give no evidence.
 */
export type AxisProvenance =
  | 'measured'
  | 'source-estimated'
  | 'regression-bridge'
  | 'effort-stepdown'
  | 'missing';

/** How one feature value was obtained. */
export type FeatureEvidenceCode =
  | 'measured'
  | 'source-estimated'
  | 'missing'
  | 'not-relevant'
  | 'price-known'
  | 'price-unknown'
  | 'speed-known'
  | 'speed-unknown'
  | 'speed-other-effort'
  | 'boundary-rule'
  | 'identity-unknown'
  | 'attributed'
  | 'unattributed';

export interface FeatureEvidence {
  feature: FeatureName;
  code: FeatureEvidenceCode;
  mapping: typeof FEATURE_MAPPING_VERSION;
  /** Per-component codes, e.g. `research:measured`, `knowledge:missing`. */
  details?: string[];
}

/**
 * One action's features. `values` is the central representative used for
 * display, ties and central fallback; it is not an observation when evidence
 * is missing. `lower` and `upper` are the interval bounds; both equal
 * `values` for an exact feature.
 */
export interface ActionFeatureVector {
  key: string;
  values: number[];
  lower: number[];
  upper: number[];
  evidence: FeatureEvidence[];
}

export interface Interval {
  center: number;
  lower: number;
  upper: number;
}

