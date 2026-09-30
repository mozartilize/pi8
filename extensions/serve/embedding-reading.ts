/**
 * Where the embedding reader's readings enter routing.
 *
 * The keyword rules read English only. A prompt they cannot read — one with
 * letters outside ASCII, or no keyword evidence at all — is read by the
 * local E5 model instead, when `embeddingClassifier` is on. Its readings
 * only ever raise routing:
 *  - a thin reading makes the entry carry on the work it follows (a minimum
 *    task type, an unresolved fallback instead of new work) but never takes
 *    the fast path, which stays with the exact English rules because it
 *    reuses a work item's state without collecting more context;
 *  - a decided kind stronger than the keyword one raises the entry's final
 *    step's kind.
 */
import { readPrompt, type EmbeddingReading } from '../embed/embedding.js';
import { debugLog } from '../host/debuglog.js';
import type { ClassifyResult } from '../routing/classify/classifier.js';
import { DIMENSION_STRENGTH } from '../routing/classify/classifier-keywords.js';
import type { TurnClassificationInput } from '../routing/policy/continuation.js';
import type { AutoRouterConfig, EmbeddingMeta, TaskKind } from '../types.js';
import type { RouterSession } from './router-session-state.js';

/** A thin prompt is short; a longer one carries content whatever it resembles. */
export const EMBEDDING_THIN_MAX_CHARS = 60;

const NON_ASCII_LETTER = /(?![\p{ASCII}])\p{L}/u;

/** Whether the English keyword rules cannot read `prompt`. */
export function keywordsCannotRead(prompt: string, hasCategoricalEvidence: boolean): boolean {
  const text = prompt.trim();
  return text !== '' && (NON_ASCII_LETTER.test(text) || !hasCategoricalEvidence);
}

export interface EntryReading {
  turnInput: TurnClassificationInput;
  /** The keyword result, with its final step's kind raised when the reading decided a stronger one. */
  classifyResult: ClassifyResult;
  embedding?: EmbeddingMeta;
}

/** The reading's kind when it is decided and stronger than `kind`. */
function raisedKind(reading: EmbeddingReading, kind: TaskKind): TaskKind | undefined {
  return reading.kindDecided && DIMENSION_STRENGTH[reading.kind] > DIMENSION_STRENGTH[kind] ? reading.kind : undefined;
}

/**
 * Read a new entry's prompt with the embedding model when the keyword rules
 * cannot, and mark it thin when the reading says so and the rules did not.
 * Anything that fails or runs out of time leaves the entry as the rules
 * read it.
 */
export async function readEntryPrompt(
  turnInput: TurnClassificationInput,
  classifyResult: ClassifyResult,
  config: AutoRouterConfig,
  session: RouterSession,
): Promise<EntryReading> {
  const unread: EntryReading = { turnInput, classifyResult };
  if (!config.embeddingClassifier || !keywordsCannotRead(turnInput.promptText, classifyResult.hasCategoricalEvidence)) {
    return unread;
  }
  const generation = session.getSessionGeneration();
  let reading: EmbeddingReading | undefined;
  try {
    reading = await readPrompt(turnInput.promptText, { deadlineMs: config.embeddingDeadlineMs });
  } catch {
    reading = undefined;
  }
  if (session.getSessionGeneration() !== generation) return unread;
  if (!reading) {
    session.recordEmbedding('failed');
    return unread;
  }
  session.recordEmbedding('read');
  const thin = !turnInput.thin && reading.thin && turnInput.promptText.trim().length <= EMBEDDING_THIN_MAX_CHARS;
  if (thin) session.recordEmbedding('thin');
  const kind = raisedKind(reading, classifyResult.terminal.kind);
  if (kind) session.recordEmbedding('kindRaised');
  debugLog('embedding.read', { thinMargin: round(reading.thinMargin), thin, kind: reading.kind, kindMargin: round(reading.kindMargin), kindRaised: kind != null });
  return {
    turnInput: thin ? { ...turnInput, thin: true, thinByEmbedding: true } : turnInput,
    classifyResult: kind ? { ...classifyResult, terminal: { ...classifyResult.terminal, kind } } : classifyResult,
    embedding: {
      thinMargin: round(reading.thinMargin),
      kind: reading.kind,
      kindMargin: round(reading.kindMargin),
      ...(thin ? { thin: true } : {}),
      ...(kind ? { kindRaised: true } : {}),
    },
  };
}

const round = (value: number): number => Math.round(value * 1000) / 1000;
