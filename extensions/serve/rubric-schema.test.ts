import { describe, expect, it } from 'vitest';
import { changeFactsParameter } from './change-facts-schema.js';
import { CONTRACT_REMINDER } from './execution-contract-tool.js';
import { remainingWorkParameter } from './rubric-schema.js';

describe('implementation evidence guidance', () => {
  it('requires evidence for ratings and preserves missing-rating rules', () => {
    const schema = remainingWorkParameter('Remaining implementation.');
    expect(schema).toHaveProperty('description', expect.stringContaining('Read relevant source before rating a source-dependent change.'));
    expect(schema).toHaveProperty('description', expect.stringContaining('Do not use level 1 for missing evidence.'));
    expect(schema).toHaveProperty('description', expect.stringContaining('If the rubric is optional and still unsupported, omit it.'));
    expect(schema).toHaveProperty('description', expect.stringContaining('Missing criteria inherit the highest supplied level.'));
    expect(schema).toHaveProperty('description', expect.stringContaining('No ratings retain task defaults.'));
    expect(schema.properties.openDecisions).toHaveProperty('description',
      expect.stringContaining('An unknown source location is missing evidence, not a behavior or design choice.'));
  });

  it('separates unresolved choices from missing evidence in the existing facts', () => {
    const facts = changeFactsParameter({ changesAndCheck: true, description: 'Observed facts.' });
    expect(facts.properties.decisions).toHaveProperty('description', expect.stringContaining('Name each unresolved behavior, interface, or design choice.'));
    expect(facts.properties.decisions).toHaveProperty('description', expect.stringContaining('For implementation, support openDecisions levels 4 and 5 with these choices.'));
    // A local choice listed here contradicts an openDecisions rating of 3, and the settled ceiling reads only that rating.
    expect(facts.properties.decisions).toHaveProperty('description', expect.stringContaining('Do not list a local implementation choice, such as helper placement or test selection.'));
    expect(facts.properties.unknowns).toHaveProperty('description', expect.stringContaining('Include missing source evidence here, not in decisions.'));
  });

  it('guides authorized, fully specified edits to a plan before execution', () => {
    expect(CONTRACT_REMINDER).toContain('if the user asked for this change');
    expect(CONTRACT_REMINDER).toContain('every remaining edit and verification command is specified');
    expect(CONTRACT_REMINDER).toContain('call commit_execution before making those edits');
    expect(CONTRACT_REMINDER).toContain('Continue inspecting while decisions remain.');
    expect(CONTRACT_REMINDER).toContain('Rate only the remaining implementation, not the completed investigation.');
  });
});
