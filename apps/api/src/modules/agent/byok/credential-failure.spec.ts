import { describe, expect, it } from 'vitest';

import { credentialFailed } from './credential-failure';

/** 020 R7 and 032 R10: whose credential failed, never what the provider said. */
describe('credentialFailed', () => {
  it("names the organisation's key by its last four (020)", () => {
    expect(
      credentialFailed('unauthorised', {
        keyLastFour: 'ghij',
        mode: 'BYOK',
        provider: 'anthropic',
      }),
    ).toEqual({
      failureClass: 'credential',
      kind: 'failed',
      reason:
        "Anthropic rejected the organisation's key ending ghij — an admin must replace or remove it in Settings › Connectors",
    });
  });

  const account = { accountLabel: 'ada@example.com', mode: 'BYOS', provider: 'openai' } as const;

  it('a rejected subscription names the person’s account and where to reconnect it', () => {
    const outcome = credentialFailed('unauthorised', account);

    expect(outcome).toEqual({
      failureClass: 'credential',
      kind: 'failed',
      reason: 'Your OpenAI account (ada@example.com) needs reconnecting in Settings › Account',
    });
    expect(JSON.stringify(outcome)).not.toMatch(/organisation/i);
  });

  it('a limited subscription names the reset time when there is one', () => {
    const outcome = credentialFailed('rate-limited', account, {
      resetsAt: new Date('2026-09-24T12:00:00.000Z'),
    });

    expect(outcome).toEqual({
      failureClass: 'credential',
      kind: 'failed',
      reason:
        'Your OpenAI account (ada@example.com) is rate-limited until 2026-09-24T12:00:00.000Z',
      // T046: the reset rides to the `state` event.
      resetsAt: new Date('2026-09-24T12:00:00.000Z'),
    });
  });

  it('a limited subscription with no reset says try again later', () => {
    const outcome = credentialFailed('rate-limited', { ...account, provider: 'anthropic' });

    expect(outcome).toMatchObject({
      reason: 'Your Anthropic account (ada@example.com) is rate-limited — try again later',
    });
    expect(JSON.stringify(outcome)).not.toMatch(/organisation/i);
  });
});
