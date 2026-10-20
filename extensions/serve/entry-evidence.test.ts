import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempRouterDir } from '../test-support/temp-router-dir.js';
import { SessionTree } from '../test-support/session-tree.js';
import { GROUNDING_MAX_BYTES } from '../routing/context/grounding.js';
import { createEntryEvidence, refreshSourceEvidence } from './entry-evidence.js';
import { observeContextGrounding } from './context-grounding.js';
import { RouterSession } from './router-session-state.js';

describe('entry-local source evidence', () => {
  let temp: ReturnType<typeof createTempRouterDir>;
  let session: RouterSession;
  let tree: SessionTree;
  beforeEach(() => { temp = createTempRouterDir(); session = new RouterSession(); tree = new SessionTree(); });
  afterEach(() => temp.cleanup());

  function entry(prompt: string) {
    const sourceEntryId = tree.user(prompt);
    const evidence = createEntryEvidence({ key: sourceEntryId, promptText: prompt }, session.getRoutingEpoch(), temp.path, tree.manager());
    session.commitEntryRoutingState({ intentKey: sourceEntryId, sourceEntryId, routingEpoch: session.getRoutingEpoch(),
      status: 'triage', providerInvocation: 1, observedMutationTools: 0, evidence,
      sourceEvidencePending: evidence.referencedPaths.length > 0 });
    return evidence;
  }
  async function read(path: string, text: string) {
    await observeContextGrounding({ toolName: 'read', input: { path }, content: [{ type: 'text', text }] } as never,
      { cwd: temp.path, sessionManager: tree.manager() } as never, session);
  }

  it('uses only explicit references in the genuine entry, never earlier files or plain path mentions', () => {
    tree.user('@old.ts implement this'); tree.assistant('done');
    const evidence = entry('explain bare.ts and @./source.ts:3 and @source.ts');
    expect(evidence.entryId).toBe(session.getEntryRoutingState()!.sourceEntryId);
    expect(evidence.referencedPaths).toEqual(['source.ts']);
    expect(evidence.observedFiles.size).toBe(0);
    expect(session.getEntryRoutingState()).not.toHaveProperty('workItemId');
  });

  it('does not credit a full read in an earlier entry to the same explicit path', async () => {
    writeFileSync(join(temp.path, 'source.ts'), 'full source');
    entry('@source.ts explain this'); await read('source.ts', 'full source');
    expect(session.getEntryRoutingState()!.sourceEvidencePending).toBe(false);
    entry('@source.ts change this');
    expect(await refreshSourceEvidence(session)).toMatchObject({ fresh: 0, unmet: ['source.ts'] });
    expect(session.getEntryRoutingState()!.sourceEvidencePending).toBe(true);
    expect(session.getEntryRoutingState()!.evidence!.readCoverage.size).toBe(0);
  });

  it('rechecks SHA freshness even when the source was satisfied earlier in the entry', async () => {
    writeFileSync(join(temp.path, 'source.ts'), 'first');
    entry('@source.ts explain this'); await read('source.ts', 'first');
    expect(session.getEntryRoutingState()!.sourceEvidencePending).toBe(false);
    writeFileSync(join(temp.path, 'source.ts'), 'other');
    expect(await refreshSourceEvidence(session)).toMatchObject({ required: 1, fresh: 0, unmet: ['source.ts'] });
    expect(session.getEntryRoutingState()!.sourceEvidencePending).toBe(true);
    await read('source.ts', 'other');
    expect(session.getEntryRoutingState()!.sourceEvidencePending).toBe(false);
  });

  it('retains missing-file, directory, and oversized-source exemptions without manufacturing a read', async () => {
    mkdirSync(join(temp.path, 'scope'));
    writeFileSync(join(temp.path, 'large.ts'), 'x'.repeat(GROUNDING_MAX_BYTES + 1));
    entry('@missing.ts @scope/ @large.ts explain the available context');
    expect(await refreshSourceEvidence(session)).toMatchObject({ required: 3, fresh: 0, oversized: 1, unmet: [] });
    expect(session.getEntryRoutingState()!.evidence!.observedFiles.size).toBe(0);
    writeFileSync(join(temp.path, 'large.ts'), 'x'.repeat(GROUNDING_MAX_BYTES));
    expect(await refreshSourceEvidence(session)).toMatchObject({ oversized: 0, unmet: ['large.ts'] });
  });

  it('discards both entry evidence and a previous flow when routing authority changes', async () => {
    const evidence = entry('@source.ts explain this');
    session.previousFlow = { flowId: 'flow', originEntryId: 'previous', originBoundaryId: 'boundary',
      strikesByModel: { 'a/model': 1 }, excludedModels: [] };
    session.invalidateRouting();
    expect(session.getEntryRoutingState()?.evidence).toBeUndefined();
    expect(session.previousFlow).toBeUndefined();
    expect(session.getRoutingEpoch()).not.toBe(evidence.routingEpoch);
    session.reset();
    expect(session.getEntryRoutingState()).toBeUndefined();
  });
});
