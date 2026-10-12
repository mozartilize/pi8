import { describe, expect, it } from 'vitest';
import type { Dimension } from '../../types.js';
import {
  actorAllowedForBoundary, authorizedFallbacks, createBoundaryAuthorization, settleBoundary,
  type ActualServeReceipt,
} from './boundary-authorization.js';

const actors = ['a/A:low', 'a/A:high', 'b/B:high'];
const exclusions = [{ workItemId: 'W', phase: 'implement' as const, model: 'a/A:high' }];
const authorization = (workItemId = 'W', phase: Dimension = 'implement', available = actors) =>
  createBoundaryAuthorization({ boundaryId: 'bd', workItemId, phase, assignmentId: 'as', revision: 1 }, available, exclusions);
const receipt: ActualServeReceipt = {
  boundaryId: 'bd', workItemId: 'W', phase: 'implement', assignmentId: 'as', revision: 1,
  actualServed: 'b/B:high', answered: true,
};

describe('permissions from callable actions and work/phase exclusions', () => {
  it('excludes every effort of a failed model only for the named work and phase', () => {
    expect(authorization().allowedActors).toEqual(['b/B:high']);
    for (const phase of ['plan', 'review', 'gather'] as const) {
      expect(authorization('W', phase).allowedActors).toEqual(actors);
    }
    expect(authorization('other').allowedActors).toEqual(actors);
  });

  it('availability applies to every phase but a work failure does not', () => {
    const callable = actors.filter((key) => !key.startsWith('b/B:'));
    expect(authorization('W', 'implement', callable).allowedActors).toEqual([]);
    expect(authorization('W', 'review', callable).allowedActors).toEqual(['a/A:low', 'a/A:high']);
    expect(authorization('other', 'implement', callable).allowedActors).toEqual(['a/A:low', 'a/A:high']);
  });

  it('uses the complete callable pool, not the selected model or fallback rank', () => {
    const auth = authorization('W', 'plan', [...actors, actors[0]!]);
    expect(auth.allowedActors).toEqual(actors);
    expect(authorizedFallbacks(auth, ['x/X:high', 'b/B:high', 'a/A:low'])).toEqual(['b/B:high', 'a/A:low']);
  });

  it('copies the input and makes the permission snapshot immutable', () => {
    const input = [...actors];
    const auth = authorization('W', 'review', input);
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
      { workItemId: 'other' }, { phase: 'review' as const }, { boundaryId: 'other' },
      { assignmentId: 'old' }, { revision: 0 }, { answered: false },
      { actualServed: 'a/A:high' }, { actualServed: 'b/B:max' },
    ]) {
      expect(settleBoundary(auth, { ...receipt, ...patch })).toBe(auth);
    }
    expect(actorAllowedForBoundary({ ...auth, state: 'expired' }, 'b/B:high')).toBe(false);
  });
});
