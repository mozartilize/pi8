/**
 * Assessment prompt construction and reply validation.
 *
 * The prompt is versioned infrastructure, not an inline string: a routing
 * regression has to be correlatable to a specific revision, so every decision
 * log entry stamps ASSESSMENT_PROMPT_VERSION and a wording change without a
 * version bump is not a valid change.
 *
 * Pure by design — deterministic given its inputs, so construction, labelling,
 * truncation and redaction are all unit-testable without a live model.
 */
import type {
  AssessmentConfidence,
  ComplexityBand,
  TaskKind,
  TaskScope,
} from '../../types.js';

/** Bump on any wording, ontology or field change. Semver: major = ontology. */
export const ASSESSMENT_PROMPT_VERSION = '2.0.0';

export interface AssessmentEvidence {
  /** Role-labelled conversation; labels come from provenance, not raw role. */
  conversation: string;
  /** Latest compaction or branch summary text, if any. */
  summary?: string;
  /** Active tool names only — never descriptions. */
  toolNames: readonly string[];
  /** Active skill names only — never SKILL.md content. */
  skillNames: readonly string[];
  /** Recent tool activity as names and counts — never arguments or results. */
  toolActivity: ReadonlyArray<{ name: string; count: number }>;
}

export type ParsedAssessment = {
  kind: TaskKind;
  complexity: ComplexityBand;
  scope: TaskScope;
  compound: boolean;
  confidence: AssessmentConfidence;
  reasoning: string;
};

const KINDS: readonly TaskKind[] = ['lightweight', 'gather', 'plan', 'implement', 'review'];
const COMPLEXITIES: readonly ComplexityBand[] = ['trivial', 'routine', 'moderate', 'hard', 'frontier'];
const SCOPES: readonly TaskScope[] = ['bounded', 'open-ended'];
const CONFIDENCES: readonly AssessmentConfidence[] = ['high', 'medium', 'low'];

const MAX_REASONING_CHARS = 240;
const MAX_SUMMARY_CHARS = 1200;
const MAX_EVIDENCE_CHARS = 400;

/**
 * Conservative credential scrub. It runs over already-bounded prose, so a
 * false positive costs the assessor a little context; a false negative would
 * leak a secret to a different provider.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
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
  // word. Over-redaction costs the assessor a little context; a leak costs the
  // user a secret on a different provider, so the scrub is deliberately greedy.
  /\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_?KEY)[A-Z0-9_]*\s*[=:]\s*[^\n]*/gi,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]');
  return out;
}

/** Keep the tail: the newest text is the request, the oldest is background. */
function tail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `…${text.slice(-(maxChars - 1))}`;
}

const INSTRUCTIONS = `You are a routing assessor for a coding agent. Read the request below and
classify the work the user is asking for.

Classify by the requested terminal DELIVERABLE, not by the first phase of the work:
- "investigate and fix X" is implement, because a fix is requested.
- "research and recommend an architecture" is plan, because a recommendation is requested.
- "inspect this diff for bugs" is review.
- "list the main features of <one file>" is lightweight, because it is a bounded extraction.

Kinds:
- lightweight: small, bounded, self-contained answers and extractions
- gather: multi-source reading, search, open-ended investigation
- plan: architecture, design, tradeoff analysis, recommendations
- implement: writing or modifying code toward a known outcome
- review: critiquing or verifying existing work

Complexity bands:
- trivial: mechanical, no judgement needed
- routine: familiar work with an obvious method
- moderate: several interacting parts or a non-obvious method
- hard: subtle correctness, concurrency, cross-component or migration work
- frontier: novel design with no established method

Scope is bounded when the deliverable is a small, enumerable amount of work
over named material, and open-ended otherwise.

Compound is yes only when the request states an explicit prerequisite or
exploration step that must precede a terminal mutation deliverable, and no
otherwise.`;

const OUTPUT_CONTRACT = `Return exactly six lines and nothing else:
Kind: [lightweight|gather|plan|implement|review]
Complexity: [trivial|routine|moderate|hard|frontier]
Scope: [bounded|open-ended]
Compound: [yes|no]
Confidence: [high|medium|low]
Reasoning: [one short sentence]`;

export function buildAssessmentPrompt(
  evidence: AssessmentEvidence,
  maxChars: number,
): string {
  const sections: string[] = [INSTRUCTIONS];

  if (evidence.summary) {
    sections.push(
      `Summary of compacted history: ${redactSecrets(tail(evidence.summary, MAX_SUMMARY_CHARS))}`,
    );
  }

  const tools = redactSecrets(evidence.toolNames.slice(0, 40).join(', '));
  if (tools) sections.push(tail(`Available tools: ${tools}`, MAX_EVIDENCE_CHARS));

  const skills = redactSecrets(evidence.skillNames.slice(0, 40).join(', '));
  if (skills) sections.push(tail(`Available skills: ${skills}`, MAX_EVIDENCE_CHARS));

  const activity = redactSecrets(
    evidence.toolActivity
      .slice(0, 20)
      .map((entry) => `${entry.name}×${entry.count}`)
      .join(', '),
  );
  if (activity) sections.push(tail(`Recent tool activity: ${activity}`, MAX_EVIDENCE_CHARS));

  const fixed = [...sections, OUTPUT_CONTRACT].join('\n\n');
  // Whatever is left after the fixed sections belongs to the conversation, and
  // the conversation is truncated oldest-first so the latest request survives.
  // The join inserts '\n\n' before "Request:" and '\n' after it; the trailing
  // slice guard below enforces the cap exactly regardless.
  const conversationBudget = Math.max(0, maxChars - fixed.length - '\n\nRequest:\n'.length);
  const conversation = redactSecrets(tail(evidence.conversation, conversationBudget));

  const prompt = [...sections, `Request:\n${conversation}`, OUTPUT_CONTRACT].join('\n\n');
  return prompt.length <= maxChars ? prompt : prompt.slice(-maxChars);
}

function fieldValue(text: string, field: string): string | undefined {
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    const marker = `${field.toLowerCase()}:`;
    if (line.toLowerCase().startsWith(marker)) {
      return line.slice(marker.length).trim();
    }
  }
  return undefined;
}

function oneOf<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
): T | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase().replace(/[[\]]/g, '').trim();
  return allowed.find((candidate) => candidate === normalized);
}

/**
 * Strict: any field failing validation makes the whole assessment unavailable.
 * A partially-parsed verdict is not a weaker verdict, it is an unknown one,
 * and unknown routes up through the ordinary fallback rather than adopting.
 */
export function parseAssessment(text: string): ParsedAssessment | undefined {
  if (typeof text !== 'string' || !text.trim()) return undefined;

  const kind = oneOf(fieldValue(text, 'Kind'), KINDS);
  const complexity = oneOf(fieldValue(text, 'Complexity'), COMPLEXITIES);
  const scope = oneOf(fieldValue(text, 'Scope'), SCOPES);
  const compoundRaw = oneOf(fieldValue(text, 'Compound'), ['yes', 'no'] as const);
  const confidence = oneOf(fieldValue(text, 'Confidence'), CONFIDENCES);
  const reasoningRaw = fieldValue(text, 'Reasoning');

  if (!kind || !complexity || !scope || !compoundRaw || !confidence || !reasoningRaw) return undefined;

  return {
    kind,
    complexity,
    scope,
    compound: compoundRaw === 'yes',
    confidence,
    reasoning: reasoningRaw.slice(0, MAX_REASONING_CHARS),
  };
}
