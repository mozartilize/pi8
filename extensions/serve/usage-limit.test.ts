import { describe, it, expect } from 'vitest';
import { isUsageLimitErrorMessage } from './usage-limit.js';

describe('isUsageLimitErrorMessage', () => {
  it('matches OpenCode Go usage-limit errors exactly as observed in pi logs', () => {
    expect(
      isUsageLimitErrorMessage(
        '429: {"type":"GoUsageLimitError","message":"Weekly usage limit reached. Resets in 5 days. To continue using this model now, enable usage from your available balance: https://opencode.ai/workspace/wrk_01KVYHA8Y8EPTK1ERCPGYD5MWB/go"}',
      ),
    ).toBe(true);
    expect(
      isUsageLimitErrorMessage(
        'OpenAI API error (429): {"type":"GoUsageLimitError","message":"5-hour usage limit reached. Resets in 1hr 13min. To continue using this model now..."}',
      ),
    ).toBe(true);
    expect(
      isUsageLimitErrorMessage(
        '429: {"message":"Error from provider (Console Go): Provider rate limit exceeded","type":"rate_limit_error","param":null,"code":"provider_rate_limit_exceeded"}',
      ),
    ).toBe(true);
    expect(
      isUsageLimitErrorMessage(
        '401: {"type":"CreditsError","message":"No payment method. Add a payment method here: https://opencode.ai/workspace/x/billing"}',
      ),
    ).toBe(true);
    expect(
      isUsageLimitErrorMessage(
        '401: {"type":"CreditsError","message":"Insufficient balance. Manage your billing here: https://opencode.ai/workspace/x/billing"}',
      ),
    ).toBe(true);
  });

  it('matches Claude Code CLI and Anthropic usage-limit text', () => {
    expect(
      isUsageLimitErrorMessage(
        "Claude Code returned an error result: You've hit your limit · resets 7:20pm (Asia/Ho_Chi_Minh)",
      ),
    ).toBe(true);
    expect(isUsageLimitErrorMessage('Claude Code returned an error result: Usage credits are required for this model.')).toBe(true);
    expect(
      isUsageLimitErrorMessage(
        '400 {"type":"error","error":{"type":"invalid_request_error","message":"Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going."}}',
      ),
    ).toBe(true);
  });

  it('matches documented quota/429/billing surfaces of other providers', () => {
    expect(isUsageLimitErrorMessage('{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}')).toBe(true);
    expect(isUsageLimitErrorMessage('429 RESOURCE_EXHAUSTED: Quota exceeded for metric custom.googleapis.com')).toBe(true);
    expect(isUsageLimitErrorMessage('402 Insufficient Balance')).toBe(true);
    expect(isUsageLimitErrorMessage('OpenRouter: 402 Insufficient Credits')).toBe(true);
    expect(isUsageLimitErrorMessage('429: rate_limit_exceeded')).toBe(true);
    expect(isUsageLimitErrorMessage('429')).toBe(true);
    expect(isUsageLimitErrorMessage('too many requests (429)')).toBe(true);
    expect(isUsageLimitErrorMessage('billing_not_active')).toBe(true);
  });

  it('does not match model-level or non-usage provider failures', () => {
    expect(isUsageLimitErrorMessage('output limit reached before an answer: alpha/model')).toBe(false);
    expect(isUsageLimitErrorMessage('reasoning exhausted the output limit before an answer: alpha/model')).toBe(false);
    expect(isUsageLimitErrorMessage('stream ended before meaningful output: alpha/model')).toBe(false);
    expect(isUsageLimitErrorMessage('421 Misdirected Request')).toBe(false);
    expect(isUsageLimitErrorMessage('Request aborted')).toBe(false);
    expect(isUsageLimitErrorMessage('no response within 30s: alpha/model')).toBe(false);
    expect(isUsageLimitErrorMessage('Provider finish_reason: error')).toBe(false);
    expect(isUsageLimitErrorMessage('503 service unavailable')).toBe(false);
    expect(isUsageLimitErrorMessage('network down')).toBe(false);
    expect(isUsageLimitErrorMessage('No API key found for provider')).toBe(false);
    expect(isUsageLimitErrorMessage(undefined)).toBe(false);
    expect(isUsageLimitErrorMessage(null)).toBe(false);
    expect(isUsageLimitErrorMessage('')).toBe(false);
  });
});
