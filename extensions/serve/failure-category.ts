/**
 * The category of a failed provider attempt, for the decision log.
 *
 * The log must say why an attempt failed, because a fallback chain that ends
 * in one error hides the errors before it. The log keeps a category and an
 * HTTP status and never the provider message: a message can quote the
 * request, and the log carries no model-written text.
 */

export type AttemptFailureCategory =
  | 'usage-limit'
  | 'tool-sequence'
  | 'context-length'
  | 'auth'
  | 'overloaded'
  | 'invalid-request'
  | 'timeout'
  | 'aborted'
  | 'trajectory'
  | 'output-limit'
  | 'declined'
  | 'other';

export interface AttemptFailureInfo {
  category: AttemptFailureCategory;
  /** The HTTP status that the message names, when it names one. */
  status?: number;
}

// A transcript that a provider rejects because a tool call and its result do not pair.
const TOOL_SEQUENCE = /role 'tool' must be a response|tool_use ids? .*without .*tool_result|tool_result .*(?:corresponding|matching) .*tool_use|no tool (?:output|call) found for function call|tool_calls? .*must be followed by tool messages/i;
const CONTEXT_LENGTH = /context[_ ]length|maximum context|prompt is too long|too many tokens|exceeds the context window/i;
const USAGE_LIMIT = /usage limit|insufficient_quota|quota|rate.?limit|too many requests|insufficient (?:balance|credits)|billing|hit your limit/i;
const AUTH = /unauthori[sz]ed|forbidden|invalid api key|invalid[_ ]token|token (?:has )?expired|not logged in|authentication/i;
const OVERLOADED = /overloaded|temporarily unavailable|service unavailable|bad gateway|gateway time-?out/i;

function statusOf(message: string): number | undefined {
  const match = /^\D{0,24}?\b([1-5]\d\d)\b|\bstatus(?: code)?[:= ]+([1-5]\d\d)\b/i.exec(message);
  const value = match?.[1] ?? match?.[2];
  return value === undefined ? undefined : Number(value);
}

export function classifyProviderFailure(message: string): AttemptFailureInfo {
  const status = statusOf(message);
  const info = (category: AttemptFailureCategory): AttemptFailureInfo => ({ category, ...(status !== undefined ? { status } : {}) });
  if (TOOL_SEQUENCE.test(message)) return info('tool-sequence');
  if (CONTEXT_LENGTH.test(message)) return info('context-length');
  if (USAGE_LIMIT.test(message) || status === 402 || status === 429) return info('usage-limit');
  if (AUTH.test(message) || status === 401 || status === 403) return info('auth');
  if (OVERLOADED.test(message) || status === 502 || status === 503 || status === 504 || status === 529) return info('overloaded');
  if (/invalid_request_error|bad request/i.test(message) || status === 400) return info('invalid-request');
  return info('other');
}
