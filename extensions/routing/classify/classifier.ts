/**
 * Classifier — pure function. Maps a user prompt to a task Dimension.
 *
 * Ported from LiteLLM's complexity_router.py (Apache-2.0, see docs/findings.md §5.1).
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
export function classify(
  prompt: string,
  // Accepted but not read: classifier.ts is frozen in semantic scope (spec
  // §5.1), so the system prompt is not scored here. See spec §3.3.
  _systemPrompt?: string | null,
  options: ClassifyOptions = {},
): ClassifyResult {
  const lowConfidenceThreshold = options.lowConfidenceThreshold ?? DEFAULT_LOW_CONFIDENCE_THRESHOLD;
  // Keyword & intent scoring runs against the user prompt only — the system
  // prompt is instructions TO the model, not a description OF the task.
  // Scored text (disclosable in signals) is the same thing.
  const scoredText = prompt.toLowerCase();
  const estimatedTokens = estimateTokenCount(prompt);

  const signals: string[] = [];

  // Token count signal
  let tokenScore = 0;
  if (estimatedTokens < 15) {
    tokenScore = -1.0;
    signals.push('short-prompt');
  } else if (estimatedTokens > 400) {
    tokenScore = 1.0;
    signals.push('long-prompt');
  }

  // Code presence: (1,2) thresholds → (0, .5, 1.0)
  const codeScore = scoreKeywordDimension(
    scoredText, scoredText, CODE_KEYWORDS, 'codePresence', 'code',
    [1, 2], [0, 0.5, 1.0],
  );
  if (codeScore.detail) signals.push(codeScore.detail);

  // Reasoning markers (LiteLLM design: user_text only)
  const reasoningScore = scoreKeywordDimension(
    scoredText, scoredText, REASONING_KEYWORDS, 'reasoningMarkers', 'reasoning',
    [1, 2], [0, 0.7, 1.0],
  );
  if (reasoningScore.detail) signals.push(reasoningScore.detail);

  // Technical terms
  const technicalScore = scoreKeywordDimension(
    scoredText, scoredText, TECHNICAL_KEYWORDS, 'technicalTerms', 'technical',
    [2, 4], [0, 0.5, 1.0],
  );
  if (technicalScore.detail) signals.push(technicalScore.detail);

  // Simple indicators (negative weight → low complexity)
  const simpleScore = scoreKeywordDimension(
    scoredText, scoredText, SIMPLE_KEYWORDS, 'simpleIndicators', 'simple',
    [1, 3], [0, -0.5, -1.0],
  );
  if (simpleScore.detail) signals.push(simpleScore.detail);

  // Multi-step & question patterns
  const multiStepScore = scoreMultiStep(scoredText);
  if (multiStepScore.detail) signals.push(multiStepScore.detail);
  const questionScore = scoreQuestionComplexity(scoredText);
  if (questionScore.detail) signals.push(questionScore.detail);

  // Weighted sum using LiteLLM's dimension weights
  const weights = DEFAULT_COMPLEXITY_DIMENSION_WEIGHTS;

  const rawScore =
    tokenScore * weights.tokenCount +
    codeScore.score * weights.codePresence +
    reasoningScore.score * weights.reasoningMarkers +
    technicalScore.score * weights.technicalTerms +
    simpleScore.score * weights.simpleIndicators +
    multiStepScore.score * weights.multiStepPatterns +
    questionScore.score * weights.questionComplexity;

  // ─── Per-dimension evidence ─────────────────────────────────────────
  //
  // Map keyword/intent hits directly onto routing dimensions so each task
  // type competes independently and gets its own strength score.

  const countMatches = (keywords: string[], text: string): number =>
    keywords.filter((kw) => keywordMatches(text, kw)).length;

  const gatherHits = countMatches(GATHER_KEYWORDS, scoredText);
  const reviewHits = countMatches(REVIEW_KEYWORDS, scoredText);
  const planHits = countMatches(PLAN_KEYWORDS, scoredText);
  const simpleHits = countMatches(SIMPLE_KEYWORDS, scoredText);
  const codeHits = countMatches(CODE_KEYWORDS, scoredText);

  if (gatherHits > 0) signals.push(`gather (${gatherHits})`);
  if (reviewHits > 0) signals.push(`review (${reviewHits})`);
  if (planHits > 0) signals.push(`plan (${planHits})`);

  const intent = detectIntent(prompt);
  if (intent) signals.push(`intent:${intent}`);

  // Small-talk words only count as evidence when they dominate a short prompt.
  // In a long deliberative prompt, "ok" / "thanks" / "hey" are conversational
  // glue, not task evidence, so we require at least two distinct simple hits
  // before assigning any lightweight evidence. (Long prompts are rarely small
  // talk by definition.)
  const simpleEvidenceHits =
    estimatedTokens > 40 && simpleHits < 2 ? 0 : simpleHits;

  // "Tiny prompt" = genuinely small-talk sized. Uses BOTH the token estimate
  // and a raw character floor. The floor is deliberately low (< 7 chars) so it
  // catches greetings in every script (hi, hola, привет, 你好, こんにちは, 안녕 are
  // all ≤ 6 chars) WITHOUT swallowing short-but-substantive non-English
  // requests (重构认证中间件 = 7 chars = "refactor auth middleware"), which must
  // fall through to the universal `gather` fallback rather than lightweight.
  const isTinyPrompt = estimatedTokens < 15 && prompt.trim().length < 7;

  const evidence: Record<Dimension, number> = {
    lightweight: simpleEvidenceHits * 0.6,
    gather: gatherHits * 0.8,
    implement: codeHits * 0.5 + technicalScore.score * 0.3,
    review: reviewHits * 1.0,
    plan: planHits * 0.9 + reasoningScore.score * 0.8,
  };

  // The opening verb outweighs any single keyword hit but not a pile of them.
  if (intent) evidence[intent] += 1.2;

  // Very short prompts with no code or reasoning content are small talk
  // regardless of what else matched. Uses isTinyPrompt so the char-count
  // floor protects substantive non-English prompts: e.g. a 12-char CJK
  // coding request is ~12 tokens (<15) but 12 chars (<25) — it will pass
  // this guard and fall through to the universal safe default (gather).
  if (isTinyPrompt && codeHits === 0 && !hasReasoningMarkers(reasoningScore)) {
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
        : // Tie-break toward the more capable dimension: over-serving a cheap
          // task costs money, under-serving a hard one costs a bad answer.
          DIMENSION_STRENGTH[b.dim] - DIMENSION_STRENGTH[a.dim],
    );

  let dimension: Dimension;
  const t = TIER_BOUNDARIES;

  if (ordered[0].score > 0) {
    dimension = ordered[0].dim;
  } else {
    // No categorical evidence at all — fall back to raw complexity banding.
    // Uncertainty routes UP: an unrecognized but non-trivial prompt is never
    // classified as small talk, because under-routing a real task is the
    // expensive failure mode. This is the universal safe default for ALL
    // non-English prompts: keywords are English-only, so any Spanish,
    // Russian, Arabic, CJK… prompt typically lands here → gather.
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

  // Confidence: normalized margin between the top two dimensions.
  const top = ordered[0].score;
  const second = ordered[1]?.score ?? 0;
  const confidence = top > 0 ? clamp(1 - second / top, 0, 1) : 0.5;
  const reportedConfidence = Math.max(CONFIDENCE_FLOOR, confidence);

  // Route up on low confidence: prefer the harder of the top two.
  if (reportedConfidence < lowConfidenceThreshold && top > 0 && ordered[1]) {
    const harder =
      DIMENSION_STRENGTH[ordered[0].dim] >= DIMENSION_STRENGTH[ordered[1].dim]
        ? ordered[0].dim
        : ordered[1].dim;
    dimension = harder;
  }

  // Asymmetric route-up for lightweight winners on longer prompts:
  // over-serving a cheap task costs pennies; under-serving a hard one costs
  // a bad answer. A long prompt that only barely looks lightweight is an
  // unrecognized task, not small talk.
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
    confidence: reportedConfidence,
    terminal: assessTerminal(prompt),
    signals,
    // hasCategoricalEvidence means a keyword, intent, or pattern matched —
    // the length-only tiny-prompt boost does NOT count. An English system
    // prompt should not make a non-English user prompt look categorized.
    hasCategoricalEvidence:
      gatherHits > 0 ||
      reviewHits > 0 ||
      planHits > 0 ||
      codeHits > 0 ||
      simpleEvidenceHits > 0 ||
      reasoningScore.score > 0 ||
      technicalScore.score > 0 ||
      intent !== undefined ||
      multiStepScore.score > 0,
  };
}

function hasReasoningMarkers(reasoning: DimensionScore): boolean {
  return reasoning.score > 0;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
