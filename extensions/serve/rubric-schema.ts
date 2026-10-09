/**
 * The rubric parameters of `hand_off_context`, `reopen_work`, and `commit_execution`. Each tool asks
 * for the same rubric of a task type, with the same criteria and levels, so the router values every
 * declaration of that task type in one way.
 */
import { Type } from '@earendil-works/pi-ai';

const LEVELS = '1 (easiest) to 5 (hardest)';
const level = (description: string) => Type.Integer({ minimum: 1, maximum: 5, description });

/** Built at registration, not import. The reasoning left for a plan or review. */
export function difficultyParameter(description: string) {
  return Type.Object({
    alternatives: level(`Viable approaches, ${LEVELS}. 1: one obvious approach or a clear-cut review; 5: several viable designs with real trade-offs, or a judgement-heavy review.`),
    stakes: level(`Cost of a wrong call, ${LEVELS}. 1: local and easy to undo; 5: a public interface, data format, migration, or security.`),
    spread: level(`Where the effects land, ${LEVELS}. 1: one file; 5: across the codebase.`),
    knowledge: level(`Knowledge needed beyond the evidence, ${LEVELS}. 1: none; 5: invariants across modules or external systems.`),
    uncertainty: level(`Open facts, ${LEVELS}. 1: the findings answer every question; 5: key facts are unknown and need experiments.`),
  }, { description });
}

/** Built at registration, not import. The implementation work left. */
export function remainingWorkParameter(description: string) {
  return Type.Object({
    openDecisions: level(
      'What the executor must still decide. 1: every change is specified down to the code. 2: only naming or ' +
      'formatting choices. 3: local implementation choices, no behavior choices. 4: some behavior or interface ' +
      'choices. 5: design choices. An unknown source location is missing evidence, not a behavior or design choice.',
    ),
    spread: level(
      'Where the changes are. 1: one function; 2: one file; 3: a few files in one module; 4: several modules; ' +
      '5: across the codebase.',
    ),
    verification: level(
      'How the result can be checked. 1: an existing test or type check proves it; 2: one small new test; ' +
      '3: new tests for several cases; 4: edge cases that tests cover poorly; 5: hard to check (timing, ' +
      'concurrency, environment).',
    ),
    knowledge: level(
      'Code the executor must understand beyond the listed files. 1: none; 2: nearby code; 3: one ' +
      'subsystem\'s conventions; 4: invariants across modules; 5: the whole codebase or external systems.',
    ),
    coupling: level(
      'What else the change can affect. 1: nothing outside the change; 2: a few local callers; 3: a shared ' +
      'helper with several callers; 4: a public interface or shared state; 5: cross-cutting behavior ' +
      '(concurrency, persistence, security).',
    ),
  }, { description: `${description} Base ratings on inspected source or explicit requirements. ` +
    'Read relevant source before rating a source-dependent change. Do not use level 1 for missing evidence. ' +
    'Collect missing evidence before rating. If the rubric is optional and still unsupported, omit it. ' +
    'Missing criteria inherit the highest supplied level. No ratings retain task defaults.' });
}
