/**
 * Facts about a change that the handing-off model observed, the facts the
 * router measures itself, and the requirement the router computes from them.
 * The model gives lists and Y/N/U answers, not 1–5 levels or probabilities: a
 * list can be checked and counted, and models give the same answer to a yes/no
 * statement more reliably than they give a calibrated number. Each statement
 * contains its own condition, so a statement whose condition is not present is
 * answered N; U means that the files the model read cannot show the answer.
 *
 * The requirement here is a shadow. It is logged next to the requirement that
 * routing uses and does not route. Its weights are starting values: logged
 * outcomes fit them before routing uses them.
 *
 * Model-written text (paths, commands, labels) stays in the session state.
 * Logs get only `factCodes`: counts and codes.
 *
 * Pure functions only: no I/O.
 */
import type { CapabilityBand, Dimension } from '../../types.js';
import { bandForRequirement, defaultRequirement, FRONTIER_REQUIREMENT } from '../score/scorer.js';

/** Yes/no questions the handing-off model answers; `FACT_STATEMENTS` words each one. */
export const FACT_QUESTIONS = [
  'defect', 'rewrites', 'mapping', 'ordering', 'specMissing', 'reproMissing', 'visual', 'performance', 'security', 'dataIntegrity',
] as const;
export type FactQuestion = typeof FACT_QUESTIONS[number];

/** Y: true. N: false, also when the statement's condition is not present. U: the files read cannot show it. */
export const FACT_ANSWERS = ['Y', 'N', 'U'] as const;
export type FactAnswer = typeof FACT_ANSWERS[number];

/** Defines "the work" for every statement, so code the work does not touch does not count. */
export const FACT_SCOPE = '"The work" is the code that the request tells you to add, change, or review. Answer Y if the statement is true. Answer N if it is false, also when its condition is not present. Answer U only when the files you read cannot show the answer.';

/**
 * The statement for each question. A Y answer can only raise the requirement,
 * so each statement is worded with the harder case as Y. The exclusions in
 * the statements name the readings that models confused in testing.
 */
export const FACT_STATEMENTS: Readonly<Record<FactQuestion, string>> = {
  defect: 'The request reports that behavior that exists now is wrong. A request for new or changed behavior is not a defect report, even when the current behavior is unsafe or slow.',
  rewrites: 'The work changes or removes behavior that exists now. Public names and default values are behavior. New code is not a rewrite. A review with no edits is not a rewrite. A change that keeps every result the same and only makes the code faster is not a rewrite.',
  mapping: 'The work converts data from one format or schema to another. Renaming a code symbol is not a mapping.',
  ordering: 'Correct behavior of the work depends on timing, ordering, retries, or concurrency.',
  specMissing: 'The work depends on behavior outside this repository, such as a vendor service or a format that another party owns, and no file or request text describes that behavior. Standard library and language behavior are not outside behavior.',
  reproMissing: 'The request reports a defect, and the workspace contains no failing test, recorded input, or exact steps that show it.',
  visual: 'Success of the work depends on how the result looks.',
  performance: 'Success of the work depends on speed, memory, or load.',
  security: 'The work changes authentication, authorization, secrets, or the handling of input that an attacker controls.',
  dataIntegrity: 'The work changes how stored data is written, migrated, or deleted.',
};

/** Domains a change touches: a key for local fitting, not a difficulty. */
export const CHANGE_DOMAINS = ['frontend', 'backend', 'database', 'infrastructure', 'integration', 'tooling', 'docs'] as const;
export type ChangeDomain = typeof CHANGE_DOMAINS[number];

/** State of the declared check commands when the model handed off. */
export const CHECK_STATES = ['passes', 'fails', 'none'] as const;
export type CheckState = typeof CHECK_STATES[number];

/** Result of one verifier run: `timeout` is a check that did not finish. */
export type CheckVerdict = 'pass' | 'fail' | 'timeout';

/**
 * What a check can establish, apart from its verdict. `none`: no executable
 * test ran. `partial`: a check ran, but its authority and assertions are not
 * established; this is the default for checks the executor wrote or chose.
 * `contract`: a user or project accepted the check as the acceptance result.
 * The router never assigns `contract` from an observed run.
 */
export type CheckStrength = 'none' | 'partial' | 'contract';

/** Most items kept from one declared list. */
export const MAX_FACT_ITEMS = 20;
/** Longest declared item kept, in characters. */
const MAX_FACT_TEXT = 300;

/**
 * Parsed declaration. An absent field is unknown. An empty list is a fact:
 * for example, no open decisions.
 */
export interface DeclaredFacts {
  checkCommands?: string[];
  checkState?: CheckState;
  modify?: string[];
  create?: string[];
  precedent?: string;
  decisions?: string[];
  unknowns?: string[];
  external?: string[];
  irreversible?: string[];
  answers?: Partial<Record<FactQuestion, FactAnswer>>;
  domains?: ChangeDomain[];
}

export type MeasurementStatus = 'measured' | 'partial' | 'unsupported' | 'unavailable' | 'limit' | 'timeout' | 'cancelled';

/** A version of Git's non-ignored working files, not the commit or the runtime environment. */
export interface WorkspaceSnapshot {
  status: MeasurementStatus;
  scope: 'git-worktree';
  digest?: string;
  files?: number;
}

/** Reported execution evidence. It never establishes semantic coverage or independent authority. */
export interface CheckReceipt {
  id: string;
  kind: 'test' | 'typecheck' | 'lint' | 'build';
  verdict: CheckVerdict;
  strength: CheckStrength;
  report: 'tap' | 'vitest' | 'unknown' | 'truncated';
  tests?: number;
  passed?: number;
  failed?: number;
  skipped?: number;
  cancelled?: number;
  elapsedMs?: number;
  snapshot: WorkspaceSnapshot;
  freshness: 'current' | 'stale' | 'unknown';
  outcome: 'unverified';
}

/** Router measurements. An undefined field is a measurement that failed or did not apply. */
export interface ChangeMeasurements {
  /** Distinct declared targets (modify and create). */
  files?: number;
  /** Distinct parent directories of those targets. */
  directories?: number;
  /** Lines in the modify targets that exist. */
  existingLines?: number;
  /** Modify targets that do not exist. */
  missingTargets?: number;
  commits?: number;
  fixCommits?: number;
  /** Most tracked files that name one modify target's file stem. */
  fanIn?: number;
  /** Tracked test files whose name contains a target's file stem. */
  coveringTests?: number;
  /** The repository has a type checker configuration. */
  typeChecker?: boolean;
  /** The declared precedent exists. */
  precedentExists?: boolean;
  /** A tool that shows a rendered result is declared to the model. */
  visualTool?: boolean;
  /** Files read before the handoff. */
  scoutFiles?: number;
  /** Model requests before the handoff. */
  scoutRequests?: number;
}

/** What logs keep of a declaration: counts and codes only. */
export interface FactCodes {
  checkCommands?: number;
  checkState?: CheckState;
  modify?: number;
  create?: number;
  precedent?: boolean;
  decisions?: number;
  unknowns?: number;
  external?: number;
  irreversible?: number;
  answers?: Partial<Record<FactQuestion, FactAnswer>>;
  /** Answers the router did not use: they do not apply, or a declared list contradicts them. */
  ignored?: FactQuestion[];
  domains?: ChangeDomain[];
}

/** The facts requirement of one handoff, with the requirement routing used. */
export interface ShadowRequirement {
  requirement: number;
  band: CapabilityBand;
  /** Requirement routing used for the same step: the handoff minimum, or the task type's default. */
  used: number;
}

/** Logged once per accepted handoff or plan. */
export interface FactsLog {
  declared: FactCodes;
  measured: ChangeMeasurements;
  shadow: ShadowRequirement;
}

/** The facts of an entry's accepted handoff. The declaration keeps model text; it stays in memory. */
export interface ChangeFactsState {
  declared?: DeclaredFacts;
  log: FactsLog;
}

/**
 * Verifier results of one entry: the last one before the accepted handoff,
 * and the last one after it with the count of runs after it.
 */
export interface CheckVerdicts {
  beforeHandoff?: CheckVerdict;
  afterHandoff?: CheckVerdict;
  runsAfterHandoff: number;
  /** Bounded evidence from observed checks. No paths, commands, or test names. */
  receipts?: CheckReceipt[];
}

/** Record one verifier result. A result after the accepted handoff counts as a run of the next step. */
export function noteCheckVerdict(verdicts: CheckVerdicts | undefined, verdict: CheckVerdict, afterHandoff: boolean): CheckVerdicts {
  const current = verdicts ?? { runsAfterHandoff: 0 };
  return afterHandoff
    ? { ...current, afterHandoff: verdict, runsAfterHandoff: current.runsAfterHandoff + 1 }
    : { ...current, beforeHandoff: verdict };
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed.slice(0, MAX_FACT_TEXT);
}

function list(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.map(text).filter((item): item is string => item !== undefined))].slice(0, MAX_FACT_ITEMS);
}

function member<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return values.includes(value as T) ? value as T : undefined;
}

/** Keep the fields that parse; drop the rest. Undefined when nothing parses. */
export function parseDeclaredFacts(input: unknown): DeclaredFacts | undefined {
  const raw = record(input);
  if (!raw) return undefined;
  const facts: DeclaredFacts = {};
  const check = record(raw.check);
  const checkCommands = list(check?.commands);
  if (checkCommands) facts.checkCommands = checkCommands;
  const checkState = member(CHECK_STATES, check?.state);
  if (checkState) facts.checkState = checkState;
  const changes = record(raw.changes);
  const modify = list(changes?.modify);
  if (modify) facts.modify = modify;
  const create = list(changes?.create);
  if (create) facts.create = create;
  const precedent = text(raw.precedent);
  if (precedent) facts.precedent = precedent;
  for (const key of ['decisions', 'unknowns', 'external', 'irreversible'] as const) {
    const items = list(raw[key]);
    if (items) facts[key] = items;
  }
  const answersRaw = record(raw.answers);
  if (answersRaw) {
    const answers: Partial<Record<FactQuestion, FactAnswer>> = {};
    for (const question of FACT_QUESTIONS) {
      const answer = member(FACT_ANSWERS, answersRaw[question]);
      if (answer) answers[question] = answer;
    }
    if (Object.keys(answers).length > 0) facts.answers = answers;
  }
  if (Array.isArray(raw.domains)) {
    const domains = [...new Set(raw.domains.map((d) => member(CHANGE_DOMAINS, d)).filter((d): d is ChangeDomain => d !== undefined))];
    if (domains.length > 0) facts.domains = domains;
  }
  return Object.keys(facts).length > 0 ? facts : undefined;
}

/**
 * The answers the router uses, after it checks them against the declared
 * lists. An answer that a list contradicts, or that does not apply, is
 * unknown:
 * - rewrites Y: a declared empty `modify` list changes no file that exists;
 * - specMissing Y: a declared empty `external` list has no outside behavior;
 * - reproMissing Y: applies only to a reported defect.
 */
export function checkedAnswers(facts: DeclaredFacts | undefined): { answers: Partial<Record<FactQuestion, FactAnswer>>; ignored: FactQuestion[] } {
  const answers = { ...facts?.answers };
  const ignored: FactQuestion[] = [];
  const ignore = (question: FactQuestion, when: boolean) => {
    if (when && answers[question] !== undefined) {
      delete answers[question];
      ignored.push(question);
    }
  };
  ignore('rewrites', facts?.modify?.length === 0 && answers.rewrites === 'Y');
  ignore('specMissing', facts?.external?.length === 0 && answers.specMissing === 'Y');
  ignore('reproMissing', answers.defect === 'N' && answers.reproMissing === 'Y');
  return { answers, ignored };
}

/** The loggable form of a declaration. */
export function factCodes(facts: DeclaredFacts | undefined): FactCodes {
  if (!facts) return {};
  const { ignored } = checkedAnswers(facts);
  const count = (items: string[] | undefined) => items?.length;
  const codes: FactCodes = {
    checkCommands: count(facts.checkCommands),
    checkState: facts.checkState,
    modify: count(facts.modify),
    create: count(facts.create),
    precedent: facts.precedent !== undefined ? true : undefined,
    decisions: count(facts.decisions),
    unknowns: count(facts.unknowns),
    external: count(facts.external),
    irreversible: count(facts.irreversible),
    answers: facts.answers ? { ...facts.answers } : undefined,
    ignored: ignored.length > 0 ? ignored : undefined,
    domains: facts.domains ? [...facts.domains] : undefined,
  };
  return Object.fromEntries(Object.entries(codes).filter(([, value]) => value !== undefined)) as FactCodes;
}

/** Lowest facts requirement: the `economy` executor minimum. */
const LOWEST_REQUIREMENT = 0.30;

/** Sign of an answer: Y is 1, N is -1, U and no answer are 0. */
const sign = (answer: FactAnswer | undefined): number => answer === 'Y' ? 1 : answer === 'N' ? -1 : 0;

/**
 * Starting weights. Each term adds to or subtracts from the task type's
 * default requirement; an unknown fact adds nothing, so missing information
 * keeps the default band. The evidence the weights encode: open design
 * decisions and the shape of the edits predict a weaker model's failure;
 * a pattern to follow and a mapping between known formats predict success;
 * a rewrite of existing behavior is harder than new code. Answers about the
 * check, the look, speed, reproduction, security, stored data, and
 * irreversible effects do not change the requirement: they decide how much
 * the result must be checked. Only checked answers count (`checkedAnswers`).
 */
function difficultyTerms(facts: DeclaredFacts | undefined, measured: ChangeMeasurements): number[] {
  const terms: number[] = [];
  const { answers } = checkedAnswers(facts);
  const decisions = facts?.decisions?.length;
  if (decisions !== undefined) terms.push(decisions === 0 ? -0.08 : decisions === 1 ? 0 : decisions === 2 ? 0.06 : 0.12);
  // A precedent the router could not find gives no credit.
  if (facts?.precedent !== undefined && measured.precedentExists !== false) terms.push(-0.06);
  const unknowns = facts?.unknowns?.length;
  if (unknowns !== undefined) terms.push(0.04 * Math.min(unknowns, 3));
  // Outside behavior that no file describes is harder; an unknown description counts as missing.
  if ((facts?.external?.length ?? 0) > 0 || answers.specMissing === 'Y') terms.push(answers.specMissing === 'N' ? 0 : 0.05);
  terms.push(0.08 * sign(answers.rewrites));
  terms.push(-0.08 * sign(answers.mapping));
  terms.push(0.10 * sign(answers.ordering));
  if (measured.files !== undefined) terms.push(measured.files <= 1 ? -0.03 : measured.files >= 6 ? 0.06 : 0);
  if (measured.directories !== undefined && measured.directories >= 4) terms.push(0.05);
  if (measured.existingLines !== undefined && measured.existingLines > 2000) terms.push(0.04);
  if (measured.fixCommits !== undefined && measured.fixCommits >= 3) terms.push(0.03);
  if (measured.fanIn !== undefined && measured.fanIn >= 10) terms.push(0.04);
  if (measured.scoutFiles !== undefined && measured.scoutFiles >= 15) terms.push(0.04);
  return terms;
}

/** The facts requirement for `dimension`, between the economy minimum and the frontier requirement. */
export function factsRequirement(dimension: Dimension, facts: DeclaredFacts | undefined, measured: ChangeMeasurements): number {
  const sum = difficultyTerms(facts, measured).reduce((total, term) => total + term, defaultRequirement(dimension));
  return Math.round(Math.max(LOWEST_REQUIREMENT, Math.min(FRONTIER_REQUIREMENT, sum)) * 1000) / 1000;
}

/** Build the log record of one accepted handoff or plan. `used` defaults to the task type's default requirement. */
export function factsLog(
  dimension: Dimension,
  facts: DeclaredFacts | undefined,
  measured: ChangeMeasurements,
  used?: number,
): FactsLog {
  const requirement = factsRequirement(dimension, facts, measured);
  return {
    declared: factCodes(facts),
    measured,
    shadow: { requirement, band: bandForRequirement(requirement), used: used ?? defaultRequirement(dimension) },
  };
}
