import { describe, expect, it } from 'vitest';
import { redactSecrets } from './secret-redact.js';

describe('redactSecrets', () => {
  it('redacts credential-shaped tokens while leaving surrounding prose', () => {
    const secret = `sk-${'s'.repeat(40)}`;
    expect(redactSecrets(`key ${secret} in the prompt`)).toBe('key [redacted] in the prompt');
  });

  it('redacts a KEY=VALUE assignment to the end of the line', () => {
    expect(redactSecrets('API_KEY=abc123 rest of line')).toBe('[redacted]');
    expect(redactSecrets('PASSWORD: my secret phrase')).toBe('[redacted]');
    expect(redactSecrets('API_KEY=abc123\nnext line stays')).toBe('[redacted]\nnext line stays');
  });

  it('does not redact lowercase bearer prose', () => {
    expect(redactSecrets('the bearer shareholding account was closed')).toBe(
      'the bearer shareholding account was closed',
    );
  });
});
