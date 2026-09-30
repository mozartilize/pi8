/**
 * Non-ASCII text is conservatively counted at one token per character;
 * Latin text at four characters per token. Overestimation protects context
 * limits without classifying the request.
 */
export function estimateTokenCount(text: string): number {
  const nonAscii = (text.match(/[^\x00-\x7F]/g) ?? []).length;
  return Math.max(1, Math.ceil((text.length - nonAscii) / 4) + nonAscii);
}
