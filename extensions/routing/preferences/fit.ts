/**
 * Compile stored answers into linear constraints on the weight vector, using
 * only the frozen v1 scenarios. Live benchmark rows or cache state never
 * change a compiled constraint.
 */
import { CORE_PREFERENCE_KEYS, compileChoice, type ChoiceDirection, type PreferenceKey, type UserRoutingPreferencesV1 } from './schema.js';
import { scenarioDelta } from './scenarios.js';

export interface CompiledPreferenceConstraint {
  key: PreferenceKey;
  direction: ChoiceDirection;
  /**
   * Oriented difference. For `A`: `phi(A) - phi(B)`; for `B`: its negation;
   * both require `dot(theta, delta) >= margin`. For `equivalent`:
   * `phi(A) - phi(B)` with `|dot(theta, delta)| <= tolerance`.
   */
  delta: number[];
}

export function compilePreferenceConstraints(profile: UserRoutingPreferencesV1): CompiledPreferenceConstraint[] {
  const constraints: CompiledPreferenceConstraint[] = [];
  for (const key of CORE_PREFERENCE_KEYS) {
    const value = profile[key];
    if (value === undefined) continue;
    const direction = compileChoice(key, value);
    if (!direction) continue;
    const delta = scenarioDelta(key);
    constraints.push({ key, direction, delta: direction === 'B' ? delta.map((value) => -value) : delta });
  }
  return constraints;
}
