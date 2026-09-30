import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RouterSession } from './router-session-state.js';
import { observeContextGrounding } from './context-grounding.js';
import { GROUNDING_MAX_BYTES, isFresh, resultText } from '../routing/context/grounding.js';
import { activateEvent, createEvent, workItem } from '../test-support/context-fixtures.js';
import { SessionTree } from '../test-support/session-tree.js';

describe('grounding from tool results', () => {
  let cwd: string;
  let session: RouterSession;
  let tree: SessionTree;
  const text = (t: string) => [{ type: 'text', text: t }];

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'pi8-ground-'));
    mkdirSync(join(cwd, 'requirements'));
    writeFileSync(join(cwd, 'requirements', 'foo.md'), 'CSV with a header row\n');
    writeFileSync(join(cwd, 'src.ts'), 'export {};\n');
    writeFileSync(join(cwd, 'other.md'), 'unrelated\n');
    tree = new SessionTree();
    session = new RouterSession();
    const u = tree.user('@requirements/foo.md implement this in src.ts');
    session.context.append(createEvent(workItem('w_1', 't_1', {
      anchors: [
        { kind: 'path', value: 'requirements/foo.md', source: 'user' },
        { kind: 'path', value: 'src.ts', source: 'user' },
      ],
    }), u));
    session.context.append(activateEvent('w_1', u));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  const ctx = () => ({ cwd, sessionManager: tree.manager() }) as never;
  const grounding = () => session.context.getLedger().items.get('w_1')!.grounding;

  it('records a SHA-256 fingerprint for a successful whole-file read of an anchor', async () => {
    await observeContextGrounding(
      { toolName: 'read', input: { path: 'requirements/foo.md' }, content: text('CSV with a header row\n'), isError: false } as never,
      ctx(), session,
    );
    expect(grounding()).toEqual([expect.objectContaining({ anchorValue: 'requirements/foo.md', observedBy: 'read', observedAtEntryId: 'e1' })]);
    expect(await isFresh(cwd, grounding()[0]!)).toBe(true);
  });

  it('records nothing for a partial, failed, or unanchored read', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
    writeFileSync(join(cwd, 'requirements', 'foo.md'), lines);
    await observeContextGrounding({ toolName: 'read', input: { path: 'requirements/foo.md', offset: 3, limit: 2 }, content: text('line 2\nline 3') } as never, ctx(), session);
    await observeContextGrounding({ toolName: 'read', input: { path: 'requirements/foo.md' }, content: text(lines), isError: true } as never, ctx(), session);
    await observeContextGrounding({ toolName: 'read', input: { path: 'other.md' }, content: text('unrelated\n') } as never, ctx(), session);
    expect(grounding()).toEqual([]);
  });

  it('grounds a file read in chunks once the chunks cover every line of it as it is now', async () => {
    const lines = Array.from({ length: 5 }, (_, i) => `line ${i}`);
    writeFileSync(join(cwd, 'requirements', 'foo.md'), lines.join('\n'));
    const read = (offset: number, limit: number, notice: string) => observeContextGrounding({
      toolName: 'read',
      input: { path: 'requirements/foo.md', offset, limit },
      content: text(`${lines.slice(offset - 1, offset - 1 + limit).join('\n')}${notice}`),
    } as never, ctx(), session);

    await read(1, 2, '\n\n[3 more lines in file. Use offset=3 to continue.]');
    await read(3, 2, '\n\n[1 more lines in file. Use offset=5 to continue.]');
    expect(grounding()).toEqual([]);
    await read(5, 1, '');
    expect(grounding()).toEqual([expect.objectContaining({ anchorValue: 'requirements/foo.md', observedBy: 'read' })]);
    expect(await isFresh(cwd, grounding()[0]!)).toBe(true);
  });

  it('grounds files larger than one Pi read returns, read through Pi\'s own read tool', async () => {
    const { createReadTool } = await import('@earendil-works/pi-coding-agent');
    const tool = createReadTool(cwd);
    const byLines = Array.from({ length: 2600 }, (_, i) => `line ${i}`).join('\n');
    const byBytes = Array.from({ length: 1200 }, (_, i) => `${String(i).padStart(4, '0')} ${'x'.repeat(70)}`).join('\n');
    for (const body of [byLines, byBytes]) {
      writeFileSync(join(cwd, 'requirements', 'foo.md'), body);
      const sha = createHash('sha256').update(body).digest('hex');
      let offset: number | undefined;
      let reads = 0;
      do {
        const input = { path: 'requirements/foo.md', ...(offset ? { offset } : {}) };
        const result = await tool.execute(`r${reads}`, input as never);
        expect(grounding().some((g) => g.sha256 === sha)).toBe(false);
        await observeContextGrounding({ toolName: 'read', input, content: result.content, details: result.details } as never, ctx(), session);
        const next = /Use offset=(\d+) to continue/u.exec(resultText(result.content) ?? '');
        offset = next ? Number(next[1]) : undefined;
        reads += 1;
      } while (offset != null);
      expect(reads).toBeGreaterThan(1);
      expect(grounding()).toEqual([expect.objectContaining({ anchorValue: 'requirements/foo.md', sha256: sha, observedBy: 'read' })]);
    }
  });

  it('starts over when the file changes between chunks', async () => {
    const first = ['a', 'b', 'c', 'd'];
    writeFileSync(join(cwd, 'requirements', 'foo.md'), first.join('\n'));
    await observeContextGrounding({
      toolName: 'read', input: { path: 'requirements/foo.md', limit: 2 },
      content: text('a\nb\n\n[2 more lines in file. Use offset=3 to continue.]'),
    } as never, ctx(), session);
    writeFileSync(join(cwd, 'requirements', 'foo.md'), 'a\nb\nC\nD');
    await observeContextGrounding({
      toolName: 'read', input: { path: 'requirements/foo.md', offset: 3 }, content: text('C\nD'),
    } as never, ctx(), session);
    expect(grounding()).toEqual([]);
  });

  it('records nothing when the read returned other text than the file now holds', async () => {
    await observeContextGrounding({ toolName: 'read', input: { path: 'requirements/foo.md' }, content: text('an older version') } as never, ctx(), session);
    expect(grounding()).toEqual([]);
  });

  it('keeps an anchor grounded through the model\'s own writes and edits', async () => {
    writeFileSync(join(cwd, 'src.ts'), 'export const a = 1;\n');
    await observeContextGrounding({ toolName: 'write', input: { path: 'src.ts' }, content: text('ok') } as never, ctx(), session);
    expect(grounding()).toEqual([expect.objectContaining({ anchorValue: 'src.ts', observedBy: 'self-edit' })]);
    writeFileSync(join(cwd, 'src.ts'), 'export const a = 2;\n');
    await observeContextGrounding({ toolName: 'edit', input: { path: 'src.ts' }, content: text('ok') } as never, ctx(), session);
    expect(await isFresh(cwd, grounding()[0]!)).toBe(true);
  });

  it('never grounds from an edit of a file the model has not seen whole', async () => {
    await observeContextGrounding({ toolName: 'edit', input: { path: 'requirements/foo.md' }, content: text('ok') } as never, ctx(), session);
    expect(grounding()).toEqual([]);
  });

  it('never grounds a file above the size cap or outside the working directory', async () => {
    const big = 'x'.repeat(GROUNDING_MAX_BYTES + 1);
    writeFileSync(join(cwd, 'requirements', 'foo.md'), big);
    await observeContextGrounding({ toolName: 'read', input: { path: 'requirements/foo.md' }, content: text(big) } as never, ctx(), session);
    await observeContextGrounding({ toolName: 'write', input: { path: '../elsewhere.md' }, content: text('ok') } as never, ctx(), session);
    expect(grounding()).toEqual([]);
  });

  it('leaves an anchor the model only named ungrounded', () => {
    expect(session.context.getLedger().items.get('w_1')!.anchors).toHaveLength(2);
    expect(grounding()).toEqual([]);
  });

  describe('from other tools', () => {
    const body = `${Array.from({ length: 30 }, (_, i) => `requirement ${i}: rows are comma separated`).join('\n')}\n`;
    const lines = body.split('\n').slice(0, 30);
    beforeEach(() => writeFileSync(join(cwd, 'requirements', 'foo.md'), body));
    const abs = () => join(cwd, 'requirements', 'foo.md');
    const result = (toolName: string, input: unknown, out: string) =>
      observeContextGrounding({ toolName, input, content: text(out), isError: false } as never, ctx(), session);

    it('grounds a whole file another reader returned, whatever its header', async () => {
      await result('tilth_read', { path: abs(), mode: 'full' }, `# ${abs()} (31 lines, ~300 tokens) [full]\n\n${body}`);
      expect(grounding()).toEqual([expect.objectContaining({ anchorValue: 'requirements/foo.md', observedBy: 'read' })]);
      expect(await isFresh(cwd, grounding()[0]!)).toBe(true);
    });

    it('never grounds from a result cut short, even one still tagged as full', async () => {
      await result('tilth_read', { path: abs(), budget: 200 },
        `# ${abs()} (31 lines) [full]\n\n${lines.slice(0, 12).join('\n')}\n\n... truncated (900 tokens omitted, budget: 200)`);
      expect(grounding()).toEqual([]);
    });

    it('grounds once sections across results cover the file, behind line numbers', async () => {
      const section = (from: number, to: number) =>
        `# ${abs()} [section]\n\n─── lines ${from + 1}-${to} ───\n` +
        lines.slice(from, to).map((line, i) => `${String(from + i + 1).padStart(2)}  ${line}`).join('\n');
      await result('tilth_read', { path: 'requirements/foo.md', section: '1-15' }, section(0, 15));
      expect(grounding()).toEqual([]);
      await result('some_future_reader', { file: 'requirements/foo.md' }, section(15, 30));
      expect(grounding()).toEqual([expect.objectContaining({ anchorValue: 'requirements/foo.md', observedBy: 'read' })]);
    });

    it('never grounds from derived output, and does when the output is the file itself', async () => {
      await result('ctx_execute_file', { path: abs(), language: 'python', code: 'print(len(FILE_CONTENT))' },
        `path=${abs()}\n\`\`\`python\nprint(len(FILE_CONTENT))\n\`\`\`\n\n1290`);
      expect(grounding()).toEqual([]);
      await result('ctx_execute_file', { path: abs(), language: 'python', code: 'print(FILE_CONTENT)' },
        `path=${abs()}\n\`\`\`python\nprint(FILE_CONTENT)\n\`\`\`\n\n${body}`);
      expect(grounding()).toHaveLength(1);
    });

    it('checks only anchors the result names, and never a failed result', async () => {
      await result('bash', { command: 'cat notes.txt' }, body);
      await observeContextGrounding({ toolName: 'bash', input: { command: 'cat requirements/foo.md' }, content: text(body), isError: true } as never, ctx(), session);
      expect(grounding()).toEqual([]);
      await result('bash', { command: 'cat requirements/foo.md' }, body);
      expect(grounding()).toHaveLength(1);
    });

    it('never grounds from text of another version of the file', async () => {
      await result('tilth_read', { path: abs() }, body.replace('requirement 7', 'requirement seven'));
      expect(grounding()).toEqual([]);
    });
  });

  it('drops a fingerprint that lands after the session was reset', async () => {
    const pending = observeContextGrounding(
      { toolName: 'read', input: { path: 'requirements/foo.md' }, content: text('CSV with a header row\n') } as never,
      ctx(), session,
    );
    session.reset();
    await pending;
    expect(session.context.getLedger().items.size).toBe(0);
  });
});
