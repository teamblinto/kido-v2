import { describe, expect, it } from 'vitest';

import {
  OAUTH_CODE_MAX_LENGTH,
  OAUTH_PROVIDERS,
  OAUTH_STATE_MAX_LENGTH,
  oauthCallbackQuerySchema,
  oauthProviderParamsSchema,
  oauthProviderSchema,
  oauthStartPath,
} from './oauth';

describe('oauthProviderSchema', () => {
  it.each(OAUTH_PROVIDERS)('accepts %s', (provider) => {
    expect(oauthProviderSchema.parse(provider)).toBe(provider);
  });

  /**
   * The vocabulary is closed on purpose, and this is the assertion that keeps it that way. A
   * provider the server has no configuration for must be refused by the *schema*, not reach a
   * handler that would then have to decide what an unknown provider means — and `saml`, which §11
   * lists as a later phase behind an enterprise flag, is exactly the value somebody would add here
   * first and wire up second.
   */
  it.each(['', 'GitHub', 'gitlab', 'saml', 'facebook'])('refuses %j', (value) => {
    expect(oauthProviderSchema.safeParse(value).success).toBe(false);
  });
});

describe('oauthProviderParamsSchema', () => {
  it('carries the provider from the path', () => {
    expect(oauthProviderParamsSchema.parse({ provider: 'github' })).toEqual({ provider: 'github' });
  });

  it('refuses a second path member', () => {
    expect(oauthProviderParamsSchema.safeParse({ provider: 'github', userId: 'x' }).success).toBe(
      false,
    );
  });
});

describe('oauthCallbackQuerySchema', () => {
  it('carries the code and the state a successful redirect arrives with', () => {
    expect(oauthCallbackQuerySchema.parse({ code: 'abc', state: 'xyz' })).toMatchObject({
      code: 'abc',
      state: 'xyz',
    });
  });

  /**
   * The reason this is the package's one loose request schema. Google sends these unbidden, and a
   * strict schema would turn each into a `422` on a sign-in that was about to succeed — validating
   * somebody else's document against our idea of it.
   */
  it('tolerates the members providers add on their own schedule', () => {
    expect(
      oauthCallbackQuerySchema.safeParse({
        authuser: '0',
        code: 'abc',
        hd: 'example.test',
        prompt: 'consent',
        scope: 'openid email',
        state: 'xyz',
      }).success,
    ).toBe(true);
  });

  /** A user who clicked "Cancel" comes back with an error and a state and no code. */
  it('accepts a refusal that carries no code', () => {
    expect(oauthCallbackQuerySchema.parse({ error: 'access_denied', state: 'xyz' })).toMatchObject({
      error: 'access_denied',
      state: 'xyz',
    });
  });

  /**
   * A bare navigation to the callback parses. It has to: making `state` required would answer that
   * request with a `422` whose `errors` array names the parameter an attacker would then know to
   * supply, where `oauth-state-invalid` says only that the value presented will not work.
   */
  it('accepts an arrival with nothing at all', () => {
    expect(oauthCallbackQuerySchema.parse({})).toEqual({});
  });

  it('refuses an empty code or state rather than treating one as absent', () => {
    expect(oauthCallbackQuerySchema.safeParse({ code: '', state: 'xyz' }).success).toBe(false);
    expect(oauthCallbackQuerySchema.safeParse({ code: 'abc', state: '' }).success).toBe(false);
  });

  /** The ceiling exists so a megabyte of query string is refused before anything hashes it. */
  it('refuses a code or a state past the published ceiling', () => {
    expect(
      oauthCallbackQuerySchema.safeParse({ code: 'a'.repeat(OAUTH_CODE_MAX_LENGTH + 1) }).success,
    ).toBe(false);
    expect(
      oauthCallbackQuerySchema.safeParse({ state: 's'.repeat(OAUTH_STATE_MAX_LENGTH + 1) }).success,
    ).toBe(false);
  });

  it('accepts a code and a state exactly at it', () => {
    expect(
      oauthCallbackQuerySchema.safeParse({
        code: 'a'.repeat(OAUTH_CODE_MAX_LENGTH),
        state: 's'.repeat(OAUTH_STATE_MAX_LENGTH),
      }).success,
    ).toBe(true);
  });
});

describe('oauthStartPath', () => {
  it.each(OAUTH_PROVIDERS)('spells the start route for %s in one place', (provider) => {
    expect(oauthStartPath(provider)).toBe(`/auth/oauth/${provider}`);
  });
});
