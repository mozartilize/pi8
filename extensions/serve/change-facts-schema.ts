/** The `facts` parameter of `hand_off_context` and `commit_execution`. */
import { Type } from '@earendil-works/pi-ai';
import {
  CHANGE_DOMAINS,
  CHECK_STATES,
  FACT_ANSWERS,
  FACT_QUESTIONS,
  FACT_SCOPE,
  FACT_STATEMENTS,
  MAX_FACT_ITEMS,
} from '../routing/policy/change-facts.js';

const oneOf = (values: readonly string[], description: string) =>
  Type.Union(values.map((value) => Type.Literal(value)), { description });
const items = (description: string) => Type.Optional(Type.Array(Type.String(), { maxItems: MAX_FACT_ITEMS, description }));

/**
 * Built at registration, not import. A plan lists its changes and checks in
 * its steps, so `commit_execution` asks only for the other facts.
 */
export function changeFactsParameter(options: { changesAndCheck: boolean; description: string }) {
  const answers = Type.Object(
    Object.fromEntries(FACT_QUESTIONS.map((question) => [
      question,
      Type.Optional(oneOf(FACT_ANSWERS, FACT_STATEMENTS[question])),
    ])),
    { description: FACT_SCOPE },
  );
  return Type.Optional(Type.Object({
    ...(options.changesAndCheck ? {
      check: Type.Optional(Type.Object({
        commands: Type.Array(Type.String(), {
          maxItems: MAX_FACT_ITEMS,
          description: 'Commands that show that the result works: tests, build, type check. An empty list: no such command.',
        }),
        state: oneOf(CHECK_STATES, 'The result of these commands now.'),
      })),
      changes: Type.Optional(Type.Object({
        modify: Type.Array(Type.String(), { maxItems: MAX_FACT_ITEMS, description: 'Files that exist and that the work changes or deletes.' }),
        create: Type.Array(Type.String(), { maxItems: MAX_FACT_ITEMS, description: 'Files to create.' }),
      })),
    } : {}),
    precedent: Type.Optional(Type.String({ description: 'An existing file that does the same kind of thing. Omit it when there is none.' })),
    decisions: items('Name each unresolved behavior, interface, or design choice. ' +
      'For implementation, support openDecisions levels 4 and 5 with these choices. ' +
      'Do not list a local implementation choice, such as helper placement or test selection. ' +
      'An empty list means these choices are settled.'),
    unknowns: items('Facts that are not known yet and that change the result. ' +
      'Include missing source evidence here, not in decisions.'),
    external: items('Libraries, APIs, or services outside the repository that the result depends on.'),
    irreversible: items('Effects that are hard to undo: migrations, public API changes, deletions, external side effects.'),
    answers: Type.Optional(answers),
    domains: Type.Optional(Type.Array(oneOf(CHANGE_DOMAINS, 'A domain.'), { description: 'Domains that the change touches.' })),
  }, { description: options.description }));
}
