/**
 * Archived evaluation policy names. Production scoring does not read these
 * names. The type remains so historical decision records and eval arm
 * metadata stay readable. A shadow-selector arm must fail closed.
 */
export type PolicyVersion = 'legacy' | 'cheapest-sufficient';
