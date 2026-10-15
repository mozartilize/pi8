/** Shared numerical helpers. Domain policy belongs to its feature module. */
export const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** A finite, nonnegative number. */
export const usable = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value >= 0;
