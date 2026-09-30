/**
 * Grounding: router-observed evidence that a referenced artifact was read,
 * by content.
 *
 * An anchor only says a work item is about a file. Grounding says the model
 * saw that exact file: successful tool results whose text, together, holds
 * every line of the file as it is now, or the model's own write. Which tool
 * returned the text does not matter, only that its lines match the file; a
 * summary or outline of a file matches nothing. A file larger than one
 * result shows is grounded by reading it in chunks. Freshness compares the file's
 * current SHA-256 with the recorded one, so a changed requirement is owed
 * again. Only SHA-256 counts: size or mtime cannot show the
 * content is the same, and a git blob id needs the content anyway.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { GroundedArtifact, WorkItem } from './types.js';

/** Larger files are never grounded. */
export const GROUNDING_MAX_BYTES = 1_000_000;

export interface FileFingerprint {
  sha256: string;
  text: string;
}

/**
 * Fingerprint a regular file at or below the size cap. The file is opened
 * non-blocking and checked on the open handle, so a FIFO or device path
 * cannot stall the caller. Undefined for anything that cannot be grounded.
 */
export async function fingerprintFile(absPath: string): Promise<FileFingerprint | undefined> {
  let handle;
  try {
    handle = await open(absPath, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > GROUNDING_MAX_BYTES) return undefined;
    const bytes = await handle.readFile();
    if (bytes.length > GROUNDING_MAX_BYTES) return undefined;
    return { sha256: createHash('sha256').update(bytes).digest('hex'), text: bytes.toString('utf8') };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** The first text block of a tool result, which for `read` is the file text it returned. */
export function resultText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const block = content.find((b) => b && typeof b === 'object' && (b as { type?: unknown }).type === 'text');
  const text = (block as { text?: unknown } | undefined)?.text;
  return typeof text === 'string' ? text : undefined;
}

/**
 * The continuation notice Pi's `read` appends after a chunk: truncation by
 * lines or bytes, or a limit that stopped before the end of the file.
 */
const READ_NOTICE = /\n\n\[(?:Showing lines \d+-\d+ of \d+[^\]\n]*|\d+ more lines in file\.[^\]\n]*)\]$/u;

/** Lines `[start, end)` of a file split on `\n`. */
export interface LineRange {
  start: number;
  end: number;
}

/**
 * The lines a result must show to have shown the whole file. The empty
 * string after a final newline is not a line of content, and an empty file
 * has none, so no other tool's text can match it.
 */
export function contentLineCount(fileText: string): number {
  if (fileText === '') return 0;
  const lines = fileText.split('\n').length;
  return fileText.endsWith('\n') ? lines - 1 : lines;
}

/**
 * Fewer lines match by coincidence (`}`, `import x`), so a shorter run
 * counts only when it is the whole file.
 */
export const MIN_MATCHED_LINES = 3;

/** A line this common in the file says nothing about where a run starts. */
const MAX_START_POSITIONS = 64;

/** A line-number gutter tools print before file lines: `12\t`, `12: `, `12 │ `, right-aligned `12  `. */
const LINE_NUMBER = /^\s*\d+(?:\t|: ?|\s*[│|]\s?| {2})/u;

/**
 * The lines of the file, as it is now, that a tool result shows, whatever
 * tool returned it: runs of consecutive result lines, with or without a
 * line-number gutter, equal to consecutive file lines. A run counts only
 * where it sits in exactly one place in the file, and only when it has at
 * least `MIN_MATCHED_LINES` non-blank lines or is the whole file. Text cut
 * short, reformatted, or summarized matches only the lines it reproduces.
 */
export function matchedLineRanges(returned: string, fileText: string): LineRange[] {
  const file = fileText.split('\n').slice(0, contentLineCount(fileText));
  if (file.length === 0 || returned === '') return [];
  const raw = returned.split('\n');
  const bare = raw.map((line) => {
    const gutter = LINE_NUMBER.exec(line);
    return gutter ? line.slice(gutter[0].length) : undefined;
  });
  const positions = new Map<string, number[]>();
  file.forEach((line, index) => {
    const at = positions.get(line);
    if (at) at.push(index);
    else positions.set(line, [index]);
  });
  const same = (i: number, p: number) => p >= 0 && p < file.length && (raw[i] === file[p] || bare[i] === file[p]);

  const ranges: LineRange[] = [];
  let consumed = 0;
  let i = 0;
  while (i < raw.length) {
    const starts = new Set([...(positions.get(raw[i]!) ?? []), ...(bare[i] != null ? positions.get(bare[i]!) ?? [] : [])]);
    if (starts.size === 0 || starts.size > MAX_START_POSITIONS) {
      i += 1;
      continue;
    }
    let best: { start: number; end: number; forward: number } | undefined;
    let tied = false;
    for (const p of starts) {
      let forward = 0;
      while (i + forward < raw.length && same(i + forward, p + forward)) forward += 1;
      let back = 0;
      while (i - back - 1 >= consumed && same(i - back - 1, p - back - 1)) back += 1;
      const candidate = { start: p - back, end: p + forward, forward };
      const length = candidate.end - candidate.start;
      const bestLength = best ? best.end - best.start : -1;
      if (length > bestLength) {
        best = candidate;
        tied = false;
      } else if (length === bestLength) {
        tied = true;
      }
    }
    // A tie holds for every start inside the tied run, so skip all of it.
    const step = Math.max(1, best?.forward ?? 1);
    if (best && !tied) {
      const whole = best.start === 0 && best.end === file.length;
      const nonBlank = file.slice(best.start, best.end).filter((line) => line.trim() !== '').length;
      if (whole || nonBlank >= MIN_MATCHED_LINES) {
        ranges.push({ start: best.start, end: best.end });
        consumed = i + step;
      }
    }
    i += step;
  }
  return ranges;
}

/**
 * The lines of the file, as it is now, that one `read` returned: its text,
 * without a continuation notice, must equal those lines exactly, starting at
 * the read's offset; a limit shows in how many lines came back. Undefined
 * when it returned anything else, which also rejects a file that changed
 * between the read and this fingerprint.
 */
export function readLineRange(
  input: { offset?: unknown; limit?: unknown } | undefined,
  details: unknown,
  returned: string | undefined,
  fileText: string,
): LineRange | undefined {
  if (returned == null) return undefined;
  const truncation = (details as { truncation?: { firstLineExceedsLimit?: unknown } } | undefined)?.truncation;
  if (truncation?.firstLineExceedsLimit === true) return undefined;
  const offset = typeof input?.offset === 'number' && input.offset > 1 ? Math.floor(input.offset) : 1;
  const start = offset - 1;
  const lines = fileText.split('\n');
  if (start >= lines.length) return undefined;
  for (const text of new Set([returned, returned.replace(READ_NOTICE, '')])) {
    const end = start + text.split('\n').length;
    if (end <= lines.length && lines.slice(start, end).join('\n') === text) return { start, end };
  }
  return undefined;
}

/**
 * Which lines of one version of a file the model has been shown, across
 * reads. Any other content hash starts over.
 */
export class ReadCoverage {
  private covered: Uint8Array;
  private remaining: number;

  constructor(readonly sha256: string, lineCount: number) {
    this.covered = new Uint8Array(lineCount);
    this.remaining = lineCount;
  }

  /** Mark a range as read; true once every line has been. */
  add(range: LineRange): boolean {
    for (let line = range.start; line < Math.min(range.end, this.covered.length); line += 1) {
      if (this.covered[line] === 0) {
        this.covered[line] = 1;
        this.remaining -= 1;
      }
    }
    return this.remaining === 0;
  }
}

/** Whether the artifact's file still has the recorded content. */
export async function isFresh(cwd: string | undefined, artifact: GroundedArtifact): Promise<boolean> {
  const current = await fingerprintFile(cwd ? join(cwd, artifact.anchorValue) : artifact.anchorValue);
  return current?.sha256 === artifact.sha256;
}

/**
 * Referenced files require fresh grounding on this item. Directories are
 * investigation scopes, not file content: only an accepted investigation
 * closes that obligation. It never substitutes for a file's hash evidence.
 * No referenced path means nothing here proves the context in hand.
 */
export async function referencedArtifactsFresh(
  cwd: string | undefined,
  item: Pick<WorkItem, 'grounding' | 'openContext'>,
  paths: readonly string[],
): Promise<boolean> {
  return paths.length > 0 && (await unmetArtifactPaths(cwd, item, paths)).length === 0;
}

/** The referenced paths not yet met: a file not read as it is now, or a directory no accepted handoff closed. */
export async function unmetArtifactPaths(
  cwd: string | undefined,
  item: Pick<WorkItem, 'grounding' | 'openContext'>,
  paths: readonly string[],
): Promise<string[]> {
  const unmet: string[] = [];
  for (const path of paths) {
    const artifact = item.grounding.find((g) => g.anchorValue === path);
    if (artifact) {
      if (!(await isFresh(cwd, artifact))) unmet.push(path);
      continue;
    }
    // Unknown open context counts as open.
    if (item.openContext?.length !== 0) {
      unmet.push(path);
      continue;
    }
    // A missing, unreadable, oversized, or special file must not masquerade
    // as a directory scope merely because fingerprinting failed.
    try {
      if (!(await stat(cwd ? join(cwd, path) : path)).isDirectory()) unmet.push(path);
    } catch {
      unmet.push(path);
    }
  }
  return unmet;
}
