import { describe, expect, it } from 'vitest';
import type { Dimension } from '../../types.js';
import {
  actorAllowedForBoundary, createBoundaryAuthorization, settleBoundary,
  type ActualServeReceipt,
} from './boundary-authorization.js';

const actors = ['a/A:low', 'a/A:high', 'b/B:high'];
const flowExclusions = ['a/A:high'];
const authorization = (phase: Dimension = 'implement', available = actors, exclusions = flowExclusions) =>
  createBoundaryAuthorization({ sessionGeneration: 2, profileDigest: 'd', contextRevision: 1, entryId: 'e1', routingEpoch: 3, boundaryId: 'bd', phase, assignmentId: 'as', revision: 1 }, available, exclusions);
const receipt: ActualServeReceipt = {
  sessionGeneration: 2, profileDigest: 'd', contextRevision: 1, entryId: 'e1', routingEpoch: 3, boundaryId: 'bd', phase: 'implement', assignmentId: 'as', revision: 1,
  actualServed: 'b/B:high', answered: true,
};

describe('permissions from callable actions and execution-flow exclusions', () => {
  it('excludes every effort of a struck model only for the implement task type', () => {
    expect(authorization().allowedActors).toEqual(['b/B:high']);
    for (const phase of ['plan', 'review', 'gather'] as const) {
      expect(authorization(phase).allowedActors).toEqual(actors);
    }
    expect(authorization('implement', actors, []).allowedActors).toEqual(actors);
  });

  it('availability applies to every task type but a flow exclusion does not', () => {
    const callable = actors.filter((key) => !key.startsWith('b/B:'));
    expect(authorization('implement', callable).allowedActors).toEqual([]);
    expect(authorization('review', callable).allowedActors).toEqual(['a/A:low', 'a/A:high']);
    expect(authorization('implement', callable, []).allowedActors).toEqual(['a/A:low', 'a/A:high']);
  });

  it('uses the complete callable pool, not the selected model or fallback rank', () => {
    const auth = authorization('plan', [...actors, actors[0]!]);
    expect(auth.allowedActors).toEqual(actors);
  });

  it('copies the input and makes the permission snapshot immutable', () => {
    const input = [...actors];
    const auth = authorization('review', input);
    input.length = 0;
    expect(auth.allowedActors).toEqual(actors);
    expect(Object.isFrozen(auth)).toBe(true);
    expect(Object.isFrozen(auth.allowedActors)).toBe(true);
    expect(Object.isFrozen(auth.excludedModels)).toBe(true);
  });

  it('requires a callable effective effort and a current answered receipt', () => {
    const auth = authorization();
    expect(settleBoundary(auth, receipt).state).toBe('served');
    for (const patch of [
      { sessionGeneration: 3 }, { profileDigest: 'other' }, { contextRevision: 2 }, { flowId: 'other' },
      { entryId: 'e2' }, { routingEpoch: 4 }, { phase: 'review' as const }, { boundaryId: 'other' },
      { assignmentId: 'old' }, { revision: 0 }, { answered: false },
      { actualServed: 'a/A:high' }, { actualServed: 'b/B:max' },
    ]) {
      expect(settleBoundary(auth, { ...receipt, ...patch }), JSON.stringify(patch)).toBe(auth);
    }
    expect(actorAllowedForBoundary({ ...auth, state: 'expired' }, 'b/B:high')).toBe(false);
  });
});
