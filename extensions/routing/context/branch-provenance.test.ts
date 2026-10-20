import { describe, expect, it } from 'vitest';
import { latestGenuineUserEntry, messageText, readBranch } from './branch-provenance.js';

const user = (id: string, timestamp: number, content: unknown) => ({ type: 'message', id, message: { role: 'user', timestamp, content } });
describe('branch provenance', () => {
  const branch = [user('first', 100, 'same prompt'), user('second', 200, [{ type: 'text', text: 'different prompt' }])];
  it('uses the exact timestamp before text, then the newest genuine user entry', () => {
    expect(latestGenuineUserEntry(branch, { key: '2:100:hash', promptText: 'different prompt' })).toBe('first');
    expect(latestGenuineUserEntry(branch, { promptText: 'different prompt' })).toBe('second');
    expect(latestGenuineUserEntry(branch, { promptText: 'unmatched' })).toBe('second');
    expect(latestGenuineUserEntry([...branch, { type: 'custom_message', id: 'settle', message: { role: 'user', content: 'reminder' } }])).toBe('second');
  });
  it('ignores malformed records and reads only text blocks in their original order', () => {
    expect(latestGenuineUserEntry([null, {}, { type: 'message', message: { role: 'user' } }])).toBeUndefined();
    expect(messageText([{ type: 'text', text: 'one' }, { type: 'image', data: 'private' }, { type: 'text', text: 'two' }])).toBe('one\ntwo');
    expect(messageText('plain')).toBe('plain');
    expect(messageText(undefined)).toBe('');
  });
  it('treats an unreadable or unavailable branch as absent', () => {
    expect(readBranch(undefined)).toBeUndefined();
    expect(readBranch({ getBranch: () => { throw new Error('unreadable'); } })).toBeUndefined();
    expect(readBranch({ getBranch: (id) => id === 'head' ? branch : [] }, 'head')).toBe(branch);
  });
});
