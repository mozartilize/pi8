/**
 * Credential-shaped token scrub for text that may leave the session.
 *
 * Over-redaction costs a little context; a leak costs the user a secret on
 * another provider, so the scrub is deliberately greedy.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // Case-sensitive: in prose "bearer" is a common word ("the bearer shareholding
  // account"), while the HTTP header convention is uppercase. The sk- patterns
  // still catch lowercase keys themselves.
  /\bBearer\s+[-A-Za-z0-9._~+/=]{8,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  // Redact to the end of the line, not the first token: a spaced value like
  // "PASSWORD=my secret phrase" would otherwise leak everything after the first
  // word.
  /\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_?KEY)[A-Z0-9_]*\s*[=:]\s*[^\n]*/gi,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]');
  return out;
}
