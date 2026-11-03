import { describe, expect, it } from 'vitest';

import { MODEL_CATALOGUE } from '../agent/models';
import {
  BYOS_REFUSAL_REASONS,
  SUBSCRIPTION_MODELS,
  beginLinkResponseSchema,
  completeLinkPendingSchema,
  completeLinkRequestSchema,
  linkedAccountListSchema,
  linkedAccountSchema,
} from './linked-account';

const STATE = 'a'.repeat(40) + '_-9';
const AT = '2026-09-24T10:00:00.000Z';

const account = {
  accountLabel: 'ada@example.com',
  health: 'healthy',
  lastCheckedAt: AT,
  limitedUntil: null,
  linkedAt: AT,
  provider: 'anthropic',
};

describe('linked account', () => {
  it('parses the owner view and refuses an undeclared field', () => {
    expect(linkedAccountSchema.parse(account)).toEqual(account);
    expect(linkedAccountSchema.safeParse({ ...account, grant: 'x' }).success).toBe(false);
    expect(linkedAccountSchema.safeParse({ ...account, health: 'unavailable' }).success).toBe(
      false,
    );
  });

  it('lists offered providers and accounts', () => {
    expect(
      linkedAccountListSchema.parse({ accounts: [account], offered: ['anthropic'] }).offered,
    ).toEqual(['anthropic']);
    expect(linkedAccountListSchema.safeParse({ accounts: [], offered: ['gemini'] }).success).toBe(
      false,
    );
  });
});

describe('begin link', () => {
  it('discriminates redirect and device', () => {
    expect(
      beginLinkResponseSchema.parse({ kind: 'redirect', url: 'https://p.example/a' }).kind,
    ).toBe('redirect');
    const device = {
      expiresAt: AT,
      kind: 'device',
      state: STATE,
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://p.example/device',
    };
    expect(beginLinkResponseSchema.parse(device)).toEqual(device);
    expect(beginLinkResponseSchema.safeParse({ ...device, kind: 'other' }).success).toBe(false);
  });
});

describe('complete link', () => {
  it('accepts a code, an error, or neither (a device poll)', () => {
    expect(completeLinkRequestSchema.safeParse({ code: 'c', state: STATE }).success).toBe(true);
    expect(
      completeLinkRequestSchema.safeParse({ error: 'access_denied', state: STATE }).success,
    ).toBe(true);
    expect(completeLinkRequestSchema.safeParse({ state: STATE }).success).toBe(true);
  });

  it('refuses code and error together', () => {
    expect(
      completeLinkRequestSchema.safeParse({ code: 'c', error: 'other', state: STATE }).success,
    ).toBe(false);
  });

  it('refuses an undeclared field (strict object)', () => {
    expect(completeLinkRequestSchema.safeParse({ extra: 1, state: STATE }).success).toBe(false);
  });

  it('holds the state to 43 base64url characters', () => {
    expect(completeLinkRequestSchema.safeParse({ state: STATE.slice(1) }).success).toBe(false);
    expect(completeLinkRequestSchema.safeParse({ state: `${STATE}a` }).success).toBe(false);
    expect(completeLinkRequestSchema.safeParse({ state: `${'a'.repeat(42)}=` }).success).toBe(
      false,
    );
  });

  it('bounds the code and the error vocabulary', () => {
    expect(completeLinkRequestSchema.safeParse({ code: '', state: STATE }).success).toBe(false);
    expect(
      completeLinkRequestSchema.safeParse({ code: 'x'.repeat(2049), state: STATE }).success,
    ).toBe(false);
    expect(completeLinkRequestSchema.safeParse({ error: 'nope', state: STATE }).success).toBe(
      false,
    );
  });

  it('parses the device-flow pending answer', () => {
    expect(completeLinkPendingSchema.parse({ pending: true, retryAfterSeconds: 5 })).toEqual({
      pending: true,
      retryAfterSeconds: 5,
    });
    expect(
      completeLinkPendingSchema.safeParse({ pending: false, retryAfterSeconds: 5 }).success,
    ).toBe(false);
  });
});

describe('byos constants', () => {
  it('match contracts § 4', () => {
    expect(BYOS_REFUSAL_REASONS).toEqual([
      'denied',
      'exchange-refused',
      'provider-unavailable',
      'subscription-needs-reauth',
      'subscription-limited',
    ]);
  });

  it('serves only catalogue ids of the matching provider', () => {
    for (const [provider, ids] of Object.entries(SUBSCRIPTION_MODELS)) {
      for (const id of ids) {
        expect(MODEL_CATALOGUE.find((model) => model.id === id)?.provider).toBe(provider);
      }
    }
  });
});
