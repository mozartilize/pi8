/** Compatibility of benchmark evidence with the authored normalization scale. */
/** Intelligence Index versions whose scale the feature mapping normalizes. Others give no evidence. */
export const INTELLIGENCE_INDEX_VERSIONS: readonly string[] = ['4.3'];

const majorMinor = (version: string | undefined): string | undefined =>
  version?.trim().replace(/^v/i, '').split('.').slice(0, 2).join('.') || undefined;

/** True when the feature mapping normalizes this Intelligence Index version. */
export const isCompatibleIndexVersion = (version: string | undefined): boolean =>
  INTELLIGENCE_INDEX_VERSIONS.includes(majorMinor(version) ?? '');

