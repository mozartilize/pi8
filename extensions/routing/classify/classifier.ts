/**
 * Classifier — pure function. Maps a user prompt to a task Dimension.
 *
 * Uses the LiteLLM complexity-router scheme (Apache-2.0) with keyword presence,
 * prompt length, and opening intent scoring.
 * Exports: classify()
 */
import type { Dimension, TerminalAssessment } from '../../types.js';
import { assessTerminal } from './terminal-classifier.js';
import {
  CONFIDENCE_FLOOR,
  DEFAULT_COMPLEXITY_DIMENSION_WEIGHTS,
  DEFAULT_LOW_CONFIDENCE_THRESHOLD,
  TIER_BOUNDARIES,
} from '../../constants.js';
import { DIMENSION_STRENGTH } from './classifier-keywords.js';
import {
  CODE_KEYWORDS,
  REASONING_KEYWORDS,
  TECHNICAL_KEYWORDS,
  SIMPLE_KEYWORDS,
  GATHER_KEYWORDS,
  REVIEW_KEYWORDS,
  PLAN_KEYWORDS,
  INTENT_VERBS,
} from './classifier-keywords.js';

export { DIMENSION_STRENGTH } from './classifier-keywords.js';
export { DEFAULT_LOW_CONFIDENCE_THRESHOLD as LOW_CONFIDENCE_THRESHOLD } from '../../constants.js';

// ─── Token estimate ───────────────────────────────────────────────────

// Any non-ASCII character is conservatively counted as ~1 token. Byte-level
// tokenizers average ~4 chars/token on Latin text but are far less efficient
// elsewhere: ~1 token/char for CJK/Hangul, ~1 token per 1-2 chars for
// Cyrillic, Arabic, Devanagari, Thai, etc. Over-estimating is the safe
// direction: it prevents non-English prompts from being misread as small
// talk AND keeps the long-context guard conservative (under-estimating
// context size would route oversized contexts to small-window models).
const NON_ASCII_RE = /[^\x00-\x7F]/g;

export const estimateTokenCount = (text: string): number => {
  const nonAscii = (text.match(NON_ASCII_RE) ?? []).length;
  const ascii = text.length - nonAscii;
  return Math.max(1, Math.ceil(ascii / 4) + nonAscii);
};

// ─── Word-boundary match ──────────────────────────────────────────────

function keywordMatches(text: string, keyword: string): boolean {
  const lower = text.toLowerCase();
  // Multi-word phrases: substring match
  if (keyword.includes(' ')) {
    return lower.includes(keyword.toLowerCase());
  }
  // Single words: word-boundary regex
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return new RegExp(`(^|[^a-zA-Z0-9])${escaped}([^a-zA-Z0-9]|$)`, 'i').test(text);
  } catch {
    return lower.includes(keyword.toLowerCase());
  }
}

// ─── Banded keyword scoring ───────────────────────────────────────────

interface DimensionScore {
  name: string;
  score: number;
  detail: string | null;
}

function scoreKeywordDimension(
  text: string,
  disclosableText: string,
  keywords: string[],
  name: string,
  label: string,
  thresholds: [number, number],
  scores: [number, number, number],
): DimensionScore {
  const matches = keywords.filter((kw) => keywordMatches(text, kw));
  const matchCount = matches.length;
  if (matchCount < thresholds[0]) {
    return { name, score: scores[0], detail: null };
  }
  const disclosable = matches.filter((kw) => keywordMatches(disclosableText, kw));
  const detail = disclosable.length > 0
    ? `${label} (${disclosable.slice(0, 3).join(', ')})`
    : `${label} (${matchCount} matches)`;
  const score = matchCount >= thresholds[1] ? scores[2] : scores[1];
  return { name, score, detail };
}

// ─── Multi-step & question scoring ────────────────────────────────────

function scoreMultiStep(text: string): DimensionScore {
  const patterns = [
    /\bfirst\b.*\bthen\b/i,
    /\bstep\s*\d/i,
    /\d\s*\.\s/,
    /\bfollowed\s+by\b/i,
    /\bnext\b.*\bfinally\b/i,
  ];
  const hits = patterns.filter((p) => p.test(text)).length;
  if (hits >= 2) return { name: 'multiStepPatterns', score: 1.0, detail: `${hits} patterns` };
  if (hits === 1) return { name: 'multiStepPatterns', score: 0.5, detail: `${hits} pattern` };
  return { name: 'multiStepPatterns', score: 0, detail: null };
}

function scoreQuestionComplexity(text: string): DimensionScore {
  const count = (text.match(/\?/g) ?? []).length;
  if (count > 3) return { name: 'questionComplexity', score: 0.5, detail: `${count} questions` };
  return { name: 'questionComplexity', score: 0, detail: null };
}

// ─── Intent detection ─────────────────────────────────────────────────

/**
 * Map the leading imperative verb to a dimension.
 *
 * Agent prompts are overwhelmingly imperative ("plan a migration…", "review
 * this PR…"), so the opening verb carries more signal than keyword density
 * anywhere else in the text. Only the first few words are considered, so a
 * later mention of "review" inside an implementation request does not hijack
 * the classification.
 */
export function detectIntent(prompt: string): Dimension | undefined {
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const LEADING_FILLER = new Set(['please', 'can', 'you', 'could', 'lets', 'let', 'us', 'now', 'ok', 'okay', 'so', 'hey', 'just', 'i', 'want', 'to', 'need', 'do', 'a', 'the', 'go', 'ahead', 'and']);

  for (const word of words.slice(0, 6)) {
    if (LEADING_FILLER.has(word)) continue;
    const intent = INTENT_VERBS[word];
    if (intent) return intent;
    // First meaningful token was not a known verb; stop rather than scanning
    // deep into the sentence and picking up an incidental noun.
    break;
  }
  return undefined;
}

// ─── Main classify ────────────────────────────────────────────────────

export interface ClassifyOptions {
  lowConfidenceThreshold?: number;
}

export interface ClassifyResult {
  dimension: Dimension;
  /** Unbumped dimension before low-confidence or long-prompt ambiguity bump. */
  rawDimension?: Dimension;
  /** True if dimension was bumped upward due to low confidence or prompt length. */
  ambiguityBumped?: boolean;
  confidence: number;
  /** Deterministic terminal metadata — the only authority for phase routing. */
  terminal: TerminalAssessment;
  /** Which signals triggered */
  signals: string[];
  /**
   * True when at least one categorical keyword/intent signal matched. If false,
   * the classifier is operating purely on length/complexity heuristics and is
   * a good candidate for an LLM consultation.
   */
  hasCategoricalEvidence: boolean;
}

/**
 * Classify a user prompt into one of our five routing dimensions.
 *
 * Uses the LiteLLM-weighted-signal scheme:
 * - System prompt excluded from ALL keyword, intent, and pattern scoring (only
 *   the user prompt is the task). Reasoning markers are scored from userText
 *   (per LiteLLM design). Code, technical, simple, gather, review, plan
 *   keywords are likewise matched against the user prompt alone so the agent's
 *   English system prompt does not dominate classification for non-English
 *   input.
 * - Keyword presence scored with banded thresholds.
 * - Weighted sum mapped through tier boundaries to dimension.
 * - Confidence = margin between top two dimension scores.
 */
interface ComplexityMetrics {
  rawScore: number;
  signals: string[];
  codeHits: number;
  technicalScore: DimensionScore;
  reasoningScore: DimensionScore;
  multiStepScore: DimensionScore;
}

/**
 * Score token counts, code presence, technical terms, and reasoning markers.
 * Pure: reads only its inputs.
 */
function scoreComplexityMetrics(
  scoredText: string,
  estimatedTokens: number,
): ComplexityMetrics {
  const signals: string[] = [];

  let tokenScore = 0;
  if (estimatedTokens < 15) {
    tokenScore = -1.0;
    signals.push('short-prompt');
  } else if (estimatedTokens > 400) {
    tokenScore = 1.0;
    signals.push('long-prompt');
  }

  const codeScore = scoreKeywordDimension(
    scoredText, scoredText, CODE_KEYWORDS, 'codePresence', 'code',
    [1, 2], [0, 0.5, 1.0],
  );
  if (codeScore.detail) signals.push(codeScore.detail);

  const reasoningScore = scoreKeywordDimension(
    scoredText, scoredText, REASONING_KEYWORDS, 'reasoningMarkers', 'reasoning',
    [1, 2], [0, 0.7, 1.0],
  );
  if (reasoningScore.detail) signals.push(reasoningScore.detail);

  const technicalScore = scoreKeywordDimension(
    scoredText, scoredText, TECHNICAL_KEYWORDS, 'technicalTerms', 'technical',
    [2, 4], [0, 0.5, 1.0],
  );
  if (technicalScore.detail) signals.push(technicalScore.detail);

  const simpleScore = scoreKeywordDimension(
    scoredText, scoredText, SIMPLE_KEYWORDS, 'simpleIndicators', 'simple',
    [1, 3], [0, -0.5, -1.0],
  );
  if (simpleScore.detail) signals.push(simpleScore.detail);

  const multiStepScore = scoreMultiStep(scoredText);
  if (multiStepScore.detail) signals.push(multiStepScore.detail);
  const questionScore = scoreQuestionComplexity(scoredText);
  if (questionScore.detail) signals.push(questionScore.detail);

  const weights = DEFAULT_COMPLEXITY_DIMENSION_WEIGHTS;

  const rawScore =
    tokenScore * weights.tokenCount +
    codeScore.score * weights.codePresence +
    reasoningScore.score * weights.reasoningMarkers +
    technicalScore.score * weights.technicalTerms +
    simpleScore.score * weights.simpleIndicators +
    multiStepScore.score * weights.multiStepPatterns +
    questionScore.score * weights.questionComplexity;

  const countMatches = (keywords: string[], text: string): number =>
    keywords.filter((kw) => keywordMatches(text, kw)).length;

  return {
    rawScore,
    signals,
    codeHits: countMatches(CODE_KEYWORDS, scoredText),
    technicalScore,
    reasoningScore,
    multiStepScore,
  };
}

interface EvidenceEvaluation {
  ordered: Array<{ dim: Dimension; score: number }>;
  hasCategoricalEvidence: boolean;
}

/**
 * Score keyword hits, intent verbs, and task evidence across dimensions.
 * Pure: reads only its inputs.
 */
function evaluateDimensionEvidence(
  prompt: string,
  scoredText: string,
  estimatedTokens: number,
  complexity: ComplexityMetrics,
): EvidenceEvaluation {
  const countMatches = (keywords: string[], text: string): number =>
    keywords.filter((kw) => keywordMatches(text, kw)).length;

  const gatherHits = countMatches(GATHER_KEYWORDS, scoredText);
  const reviewHits = countMatches(REVIEW_KEYWORDS, scoredText);
  const planHits = countMatches(PLAN_KEYWORDS, scoredText);
  const simpleHits = countMatches(SIMPLE_KEYWORDS, scoredText);

  if (gatherHits > 0) complexity.signals.push(`gather (${gatherHits})`);
  if (reviewHits > 0) complexity.signals.push(`review (${reviewHits})`);
  if (planHits > 0) complexity.signals.push(`plan (${planHits})`);

  const intent = detectIntent(prompt);
  if (intent) complexity.signals.push(`intent:${intent}`);

  const simpleEvidenceHits =
    estimatedTokens > 40 && simpleHits < 2 ? 0 : simpleHits;

  const isTinyPrompt = estimatedTokens < 15 && prompt.trim().length < 7;

  const evidence: Record<Dimension, number> = {
    lightweight: simpleEvidenceHits * 0.6,
    gather: gatherHits * 0.8,
    implement: complexity.codeHits * 0.5 + complexity.technicalScore.score * 0.3,
    review: reviewHits * 1.0,
    plan: planHits * 0.9 + complexity.reasoningScore.score * 0.8,
  };

  if (intent) evidence[intent] += 1.2;

  if (isTinyPrompt && complexity.codeHits === 0 && !hasReasoningMarkers(complexity.reasoningScore)) {
    evidence.lightweight += 1.0;
  }
  if (prompt.trim() === '') {
    evidence.lightweight += 2.0;
  }

  const ordered = (Object.keys(evidence) as Dimension[])
    .map((dim) => ({ dim, score: evidence[dim] }))
    .sort((a, b) =>
      b.score !== a.score
        ? b.score - a.score
        : DIMENSION_STRENGTH[b.dim] - DIMENSION_STRENGTH[a.dim],
    );

  const hasCategoricalEvidence =
    gatherHits > 0 ||
    reviewHits > 0 ||
    planHits > 0 ||
    complexity.codeHits > 0 ||
    simpleEvidenceHits > 0 ||
    complexity.reasoningScore.score > 0 ||
    complexity.technicalScore.score > 0 ||
    intent !== undefined ||
    complexity.multiStepScore.score > 0;

  return { ordered, hasCategoricalEvidence };
}

/**
 * Resolve the base dimension and confidence before uncertainty guards.
 * Pure: reads only its inputs.
 */
function resolveBaseDimension(
  ordered: Array<{ dim: Dimension; score: number }>,
  rawScore: number,
  prompt: string,
  estimatedTokens: number,
): { dimension: Dimension; confidence: number } {
  let dimension: Dimension;
  const isTinyPrompt = estimatedTokens < 15 && prompt.trim().length < 7;
  const t = TIER_BOUNDARIES;

  if (ordered[0].score > 0) {
    dimension = ordered[0].dim;
  } else {
    if (prompt.trim() === '' || isTinyPrompt) {
      dimension = 'lightweight';
    } else if (rawScore < t.medium_complex) {
      dimension = 'gather';
    } else if (rawScore < t.complex_reasoning) {
      dimension = 'implement';
    } else {
      dimension = 'plan';
    }
  }

  const top = ordered[0].score;
  const second = ordered[1]?.score ?? 0;
  const confidence = top > 0 ? clamp(1 - second / top, 0, 1) : 0.5;
  const reportedConfidence = Math.max(CONFIDENCE_FLOOR, confidence);

  return { dimension, confidence: reportedConfidence };
}

/**
 * Apply low-confidence and prompt-length ambiguity route-up guards.
 * Pure: reads only its inputs.
 */
function applyAmbiguityGuards(
  baseDimension: Dimension,
  ordered: Array<{ dim: Dimension; score: number }>,
  reportedConfidence: number,
  lowConfidenceThreshold: number,
  estimatedTokens: number,
): { dimension: Dimension; rawDimension: Dimension; ambiguityBumped: boolean } {
  const rawDimension = baseDimension;
  let dimension = baseDimension;
  const top = ordered[0]?.score ?? 0;

  if (reportedConfidence < lowConfidenceThreshold && top > 0 && ordered[1]) {
    const harder =
      DIMENSION_STRENGTH[ordered[0].dim] >= DIMENSION_STRENGTH[ordered[1].dim]
        ? ordered[0].dim
        : ordered[1].dim;
    dimension = harder;
  }

  if (
    dimension === 'lightweight' &&
    reportedConfidence < 0.35 &&
    estimatedTokens > 40 &&
    ordered[1]
  ) {
    dimension = ordered[1].dim;
  }

  return {
    dimension,
    rawDimension,
    ambiguityBumped: dimension !== rawDimension,
  };
}

export function classify(
  prompt: string,
  // Accepted but not read: the system prompt is instructions TO the model,
  // not a description OF the task, so scoring it would contaminate non-English
  // or simple user requests.
  _systemPrompt?: string | null,
  options: ClassifyOptions = {},
): ClassifyResult {
  const lowConfidenceThreshold = options.lowConfidenceThreshold ?? DEFAULT_LOW_CONFIDENCE_THRESHOLD;
  const scoredText = prompt.toLowerCase();
  const estimatedTokens = estimateTokenCount(prompt);

  const complexity = scoreComplexityMetrics(scoredText, estimatedTokens);
  const evidence = evaluateDimensionEvidence(prompt, scoredText, estimatedTokens, complexity);
  const base = resolveBaseDimension(evidence.ordered, complexity.rawScore, prompt, estimatedTokens);
  const guarded = applyAmbiguityGuards(
    base.dimension,
    evidence.ordered,
    base.confidence,
    lowConfidenceThreshold,
    estimatedTokens,
  );

  return {
    dimension: guarded.dimension,
    rawDimension: guarded.rawDimension,
    ambiguityBumped: guarded.ambiguityBumped,
    confidence: base.confidence,
    terminal: assessTerminal(prompt),
    signals: complexity.signals,
    hasCategoricalEvidence: evidence.hasCategoricalEvidence,
  };
}

function hasReasoningMarkers(reasoning: DimensionScore): boolean {
  return reasoning.score > 0;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
