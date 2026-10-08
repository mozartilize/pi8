import { describe, expect, it } from 'vitest';
import { classifyProviderFailure } from './failure-category.js';

describe('classifyProviderFailure', () => {
  it('names a transcript that a provider rejects for an unpaired tool message', () => {
    expect(classifyProviderFailure(`400: {"message":"Messages with role 'tool' must be a response to a preceding message with 'tool_calls'","type":"invalid_request_error"}`))
      .toEqual({ category: 'tool-sequence', status: 400 });
  });

  it('names a Codex usage limit that has no status', () => {
    expect(classifyProviderFailure('Codex error: The usage limit has been reached')).toEqual({ category: 'usage-limit' });
  });

  it('reads the status of the other classes', () => {
    expect(classifyProviderFailure('429 Too Many Requests')).toEqual({ category: 'usage-limit', status: 429 });
    expect(classifyProviderFailure('401 unauthorized')).toEqual({ category: 'auth', status: 401 });
    expect(classifyProviderFailure('503 service unavailable')).toEqual({ category: 'overloaded', status: 503 });
    expect(classifyProviderFailure('400: bad input')).toEqual({ category: 'invalid-request', status: 400 });
    expect(classifyProviderFailure('stream ended before meaningful output: x/y')).toEqual({ category: 'other' });
  });

  it('keeps no message text', () => {
    expect(JSON.stringify(classifyProviderFailure('400: secret path /home/u/file'))).not.toContain('secret');
  });
});
