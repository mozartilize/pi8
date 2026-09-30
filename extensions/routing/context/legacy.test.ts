import { describe, it, expect, vi } from 'vitest';
import { COMPACTION_SUMMARY_PREFIX } from '@earendil-works/pi-agent-core';

import { buildLegacyIndex, findLegacyCandidates, LEGACY_LIMITS, tokenize, type LegacyIndex } from './legacy.js';
import { extractPromptAnchors } from './anchors.js';
import { RoutingContextState } from '../../serve/router-session-state.js';
import { SessionTree } from '../../test-support/session-tree.js';

/** A branch of alternating requests and replies; returns the tree and each request's entry id. */
function history(turns: Array<string | [string, string]>): { tree: SessionTree; ids: string[] } {
  const tree = new SessionTree();
  const ids: string[] = [];
  for (const turn of turns) {
    const [request, reply] = typeof turn === 'string' ? [turn, 'ok'] : turn;
    ids.push(tree.user(request));
    tree.assistant(reply);
  }
  return { tree, ids };
}

const index = (tree: SessionTree): LegacyIndex => buildLegacyIndex(tree.getBranch(), tree.getLeafId()!);
const search = (idx: LegacyIndex, prompt: string, listed?: Set<string>) =>
  findLegacyCandidates(idx, { prompt, anchors: extractPromptAnchors(prompt) }, listed);

const FILLER = ['rename the footer component', 'bump the lint config', 'tidy the changelog'];

describe('legacy index', () => {
  it('reads Chinese and Japanese requests by word', () => {
    expect(tokenize('修复登录缓存的问题').length).toBeGreaterThan(2);
    expect(tokenize('ログインのキャッシュを直す')).toContain('キャッシュ');
    const { tree, ids } = history(['修复登录缓存的问题', ...FILLER, ...FILLER, 'ログインのキャッシュを直す']);
    const idx = index(tree);
    expect(search(idx, '回到登录的工作').map((c) => c.seedEntryId)).toEqual([ids[0]]);
    expect(search(idx, 'キャッシュの続き').map((c) => c.seedEntryId)).toEqual([ids.at(-1)]);
  });

  it('ranks requests naming the prompt\'s file first, newest first, over better lexical hits', () => {
    const { tree, ids } = history([
      'wire the session store into src/auth/session.ts',
      ...FILLER,
      'auth auth auth: the auth login auth flow',
      ...FILLER,
      'handle expiry in src/auth/session.ts',
    ]);
    const found = search(index(tree), 'back to the auth work in src/auth/session.ts');
    expect(found.map((c) => c.seedEntryId)).toEqual([ids[8], ids[0], ids[4]]);
    expect(found.map((c) => c.id)).toEqual(['l_1', 'l_2', 'l_3']);
  });

  it('offers at most three candidates, dropping a hit near a better one', () => {
    const { tree, ids } = history([
      'billing invoices export', 'billing invoices totals', ...FILLER,
      'billing invoices tax', ...FILLER, 'billing invoices currency', ...FILLER, 'billing invoices refunds',
    ]);
    const found = search(index(tree), 'billing invoices');
    expect(found).toHaveLength(LEGACY_LIMITS.candidates);
    const ordinals = found.map((c) => ids.indexOf(c.seedEntryId));
    for (const a of ordinals) {
      for (const b of ordinals) if (a !== b) expect(Math.abs(a - b)).toBeGreaterThan(LEGACY_LIMITS.neighbourGap);
    }
  });

  it('does not offer a request whose work is listed, nor the requests beside it', () => {
    const { tree, ids } = history(['payments retry queue', 'payments retry backoff', ...FILLER, 'payments ledger export']);
    const found = search(index(tree), 'payments retry', new Set([ids[0]!]));
    expect(found.map((c) => c.seedEntryId)).toEqual([ids.at(-1)]);
  });

  it('indexes only genuine user requests, and excerpts only their text and the first reply text', () => {
    const tree = new SessionTree();
    tree.message({ role: 'user', content: `${COMPACTION_SUMMARY_PREFIX}oauth summary`, timestamp: 1 });
    const request = tree.user('refactor the oauth callback');
    tree.message({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'oauth private reasoning' },
        { type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'secret-oauth.env' } },
      ],
    });
    tree.message({ role: 'toolResult', content: [{ type: 'text', text: 'OAUTH_FILE_CONTENTS' }] });
    tree.assistant('The callback now validates state.');
    tree.assistant('A later oauth note.');
    tree.message({ role: 'user', content: 'oauth reminder injected without a timestamp' });
    tree.custom('other-extension', { text: 'oauth' });

    const idx = index(tree);
    expect(idx.requests.map((r) => r.entryId)).toEqual([request]);
    const [candidate] = search(idx, 'the oauth work');
    expect(candidate?.excerpt).toBe('User: refactor the oauth callback\nAssistant: The callback now validates state.');
  });

  it('skips requests from a known integration', () => {
    const { tree } = history(['[bot] oauth digest', 'refactor the oauth callback']);
    const idx = buildLegacyIndex(tree.getBranch(), tree.getLeafId()!, { syntheticPrefixes: ['[bot]'] });
    expect(idx.requests.map((r) => r.text)).toEqual(['refactor the oauth callback']);
  });

  it('bounds each excerpt and scrubs credentials before clipping', () => {
    const secret = `sk-${'a'.repeat(40)}`;
    const { tree } = history([[`deploy notes ${'x '.repeat(110)}key ${secret} end`, `reply ${'y'.repeat(400)}`]]);
    const [candidate] = search(index(tree), 'deploy notes');
    expect(candidate!.excerpt.length).toBeLessThan(400);
    expect(candidate!.excerpt).not.toContain('sk-a');
    const { tree: short } = history([[`deploy with API_KEY=${'z'.repeat(300)}`, 'done']]);
    expect(search(index(short), 'deploy')[0]!.excerpt).not.toContain('zzz');
  });

  it('builds a boundary\'s index once, across /tree, and again only after a reset', () => {
    const { tree } = history(['refactor the oauth callback', ...FILLER]);
    const state = new RoutingContextState();
    const build = vi.fn(() => index(tree));
    const head = tree.getLeafId()!;
    state.legacyIndexFor(head, build);
    tree.navigate(null);
    state.restore(tree.getBranch());
    state.legacyIndexFor(head, build);
    expect(build).toHaveBeenCalledTimes(1);
    state.reset();
    state.legacyIndexFor(head, build);
    expect(build).toHaveBeenCalledTimes(2);
  });
});
