/**
 * The routing policy that a process runs. Production runs `legacy`. A harness that
 * evaluates a candidate policy sets the environment variable before it starts the
 * process. A user cannot set the version in a config file, and any other value
 * selects `legacy`.
 */
export type PolicyVersion = 'legacy' | 'cheapest-sufficient';

export const POLICY_VERSION_ENV = 'PI8_POLICY_VERSION';

export function evaluationPolicyVersion(env: NodeJS.ProcessEnv = process.env): PolicyVersion {
  return env[POLICY_VERSION_ENV] === 'cheapest-sufficient' ? 'cheapest-sufficient' : 'legacy';
}
