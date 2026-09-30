import type { ComplexityBand, TaskKind, TaskScope, TerminalAssessment } from '../../types.js';

// The final step's kind, complexity, and scope, from keywords alone. It says
// nothing about what must happen before that step: whether a request owes
// an investigation first is the entry's prerequisite, which the work-context
// resolver decides.

const MUTATION = [
  'fix', 'implement', 'add', 'update', 'change', 'refactor', 'write', 'modify',
] as const;
const REVIEW = ['review', 'critique', 'audit'] as const;
const PLAN = ['plan', 'design', 'architect', 'strategy'] as const;
const GATHER = ['what', 'why', 'how', 'where', 'explain'] as const;

const FRONTIER_COMPLEXITY = ['from scratch', 'greenfield', 'novel algorithm'] as const;
const HARD_COMPLEXITY = [
  'race condition', 'concurrency', 'deadlock', 'distributed', 'migration',
  'architecture', 'protocol', 'cross-service', 'multi-service',
] as const;
const TRIVIAL_COMPLEXITY = ['typo', 'rename', 'one-line', 'bump version'] as const;

const BOUNDED_SCOPE = [
  'this file', 'this function', 'this method', 'this line', 'single file',
] as const;
const OPEN_SCOPE = [
  'across', 'caller', 'callers', 'codebase', 'code base', 'every', 'all services',
  'services',
] as const;

const NEGATION = /(?:do not|don't|never|without)[^.!?]{0,48}(?:fix|implement|add|update|change|refactor|write|modify)/iu;
const QUOTED = /"[^"\n]*"|'[^'\n]*'|`[^`\n]*`/gu;
const PATH_LIKE = /[\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs|md|json)(?![\w])/u;

// A request states its terminal deliverable near its start; scanning an entire
// pasted context would make a pure helper cost more than the routing decision.
const MAX_ANALYZED_CHARS = 4000;

// Word-boundary anchors use letter lookarounds rather than \b: \b is
// ASCII-only, so it treats a non-ASCII letter as a boundary and would match a
// cue inside a non-Latin word.
const compile = (cues: readonly string[]): RegExp[] => cues.map((cue) => {
  // A cue ending in consonant+y inflects the y into i before -es/-ed
  // (modify -> modifies/modified, strategy -> strategies) but keeps it before
  // -ing (modifying). Without this branch the generic stemmer below never
  // matches those forms, and a missed MUTATION cue silently routes DOWN
  // (kind falls through to gather), the one direction R3 forbids.
  if (/[^aeiou]y$/iu.test(cue)) {
    const root = cue.slice(0, -1);
    return new RegExp(`(?<!\\p{L})${root}(?:y|ies|ied|ying)(?!\\p{L})`, 'iu');
  }
  const stem = cue.replace(/e$/u, '');
  return new RegExp(`(?<!\\p{L})${stem}(?:e|es|ed|ing|s)?(?!\\p{L})`, 'iu');
});

const MUTATION_RE = compile(MUTATION);
const REVIEW_RE = compile(REVIEW);
const PLAN_RE = compile(PLAN);
const GATHER_RE = compile(GATHER);
const FRONTIER_RE = compile(FRONTIER_COMPLEXITY);
const HARD_RE = compile(HARD_COMPLEXITY);
const TRIVIAL_RE = compile(TRIVIAL_COMPLEXITY);
const BOUNDED_RE = compile(BOUNDED_SCOPE);
const OPEN_RE = compile(OPEN_SCOPE);

const firstIndex = (text: string, cues: readonly RegExp[]): number => {
  let earliest = -1;
  for (const cue of cues) {
    const match = cue.exec(text);
    if (match && (earliest === -1 || match.index < earliest)) earliest = match.index;
  }
  return earliest;
};

const lastIndex = (text: string, cues: readonly RegExp[]): number => {
  let latest = -1;
  for (const cue of cues) {
    const scan = new RegExp(cue.source, `${cue.flags}g`);
    for (let match = scan.exec(text); match; match = scan.exec(text)) {
      if (match.index > latest) latest = match.index;
      if (match.index === scan.lastIndex) scan.lastIndex += 1;
    }
  }
  return latest;
};

const matches = (text: string, cues: readonly RegExp[]): boolean => firstIndex(text, cues) !== -1;

export function assessTerminal(prompt: string): TerminalAssessment {
  const raw = prompt.slice(0, MAX_ANALYZED_CHARS);
  const text = raw.replace(QUOTED, ' ');
  const negated = NEGATION.test(text);

  const mutates = !negated && matches(text, MUTATION_RE);
  const kind = terminalKind(text, mutates);

  let complexity: ComplexityBand;
  if (matches(text, FRONTIER_RE)) complexity = 'frontier';
  else if (matches(text, HARD_RE)) complexity = 'hard';
  else if (matches(text, TRIVIAL_RE)) complexity = 'trivial';
  else complexity = 'moderate';

  let scope: TaskScope;
  if (matches(text, OPEN_RE)) scope = 'open-ended';
  // Detect file paths on the pre-strip text: developers most often name a file
  // in backticks (`src/auth.ts`), and QUOTED strips those spans before cue
  // scanning — so a backtick'd path would otherwise lose its only bounded-scope
  // signal. Cue matching still runs on the stripped `text` so quoted prose
  // can't be read as instructions.
  else if (matches(text, BOUNDED_RE) || PATH_LIKE.test(raw)) scope = 'bounded';
  // Unknown scope raises the requirement rather than lowering it.
  else scope = 'open-ended';

  return { kind, complexity, scope };
}

function terminalKind(text: string, mutates: boolean): TaskKind {
  // The final deliverable is the last one stated: "review the auth flow,
  // then fix it" ends in a mutation even though it opens with a review cue.
  if (mutates && lastIndex(text, MUTATION_RE) > Math.max(lastIndex(text, REVIEW_RE), lastIndex(text, PLAN_RE))) {
    return 'implement';
  }
  if (matches(text, REVIEW_RE)) return 'review';
  if (matches(text, PLAN_RE)) return 'plan';
  if (mutates) return 'implement';
  if (text.trim() === '') return 'lightweight';
  if (text.includes('?') || matches(text, GATHER_RE)) return 'gather';
  return 'gather';
}
