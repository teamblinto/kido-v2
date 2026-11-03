import { describe, expect, it } from 'vitest';

import { scrubSecrets } from '../../../common/telemetry/scrubber';
import {
  MAIL_LINK_TOKEN_PARAM,
  invitationUrl,
  passwordResetUrl,
  projectDomainsUrl,
  signInUrl,
  verificationUrl,
} from './links';

const APP_URL = 'https://app.forge.dev';
const TOKEN = 'PJmOx0m9k-2wQ7bYt1RfZs3aLdN6uVcH';
const ORG_ID = '9c2f7b31-5d84-4a10-bb6e-1f0d2c3e4a55';

/**
 * The invitation link takes an organisation as well, so it is adapted to the shared `(appUrl,
 * token)` shape here rather than given its own copy of the six properties every tokenised link has.
 */
const BUILDERS = [
  ['verificationUrl', verificationUrl],
  ['passwordResetUrl', passwordResetUrl],
  ['invitationUrl', (appUrl: string, token: string) => invitationUrl(appUrl, ORG_ID, token)],
] as const;

describe.each(BUILDERS)('%s', (_name, build) => {
  it('puts the token in a query parameter, never in a path segment', () => {
    const url = new URL(build(APP_URL, TOKEN));

    expect(url.searchParams.get(MAIL_LINK_TOKEN_PARAM)).toBe(TOKEN);
    expect(url.pathname).not.toContain(TOKEN);
  });

  /**
   * The reason the parameter is spelled `token` and the token is not a path segment.
   *
   * T09's transport scrubber censors `?…token=…` by parameter name, and pino-http logs `req.url`
   * in full — so a user who pastes a verification link into a support ticket, or a proxy that logs
   * the request line, produces a log record the scrubber can already clean. `/verify/<token>` is
   * indistinguishable from any other path and would sail straight through.
   */
  it('produces a link the log scrubber censors', () => {
    const scrubbed = scrubSecrets(`GET ${build(APP_URL, TOKEN)}`);

    expect(scrubbed).not.toContain(TOKEN);
    expect(scrubbed).toContain('[Redacted:query-credential]');
  });

  it('percent-encodes a token containing url-significant characters', () => {
    const awkward = 'a+b/c=d&e?f';

    expect(new URL(build(APP_URL, awkward)).searchParams.get(MAIL_LINK_TOKEN_PARAM)).toBe(awkward);
  });

  it('does not double up the slash when APP_URL carries a trailing one', () => {
    expect(build('https://app.forge.dev/', TOKEN)).toBe(build(APP_URL, TOKEN));
  });

  it('keeps a base path, so an app mounted under a prefix still resolves', () => {
    expect(new URL(build('https://forge.dev/app', TOKEN)).pathname).toMatch(/^\/app\//);
  });

  it('stays on the origin it was given', () => {
    expect(new URL(build(APP_URL, TOKEN)).origin).toBe(APP_URL);
  });
});

/**
 * The one tokenised link that carries a second value, and the reason it has to.
 *
 * Every tenant-owned read runs under row-level security, so accepting an invitation has to open a
 * tenant transaction *before* it can look the invitation up at all — and the only input the tenant
 * resolver reads is a route parameter. `schema/rbac.ts` states the consequence: "the invitation link
 * therefore carries the organisation id alongside the token". The id is not the secret; the token
 * is, and a link without the id is one the web app cannot act on.
 */
describe('invitationUrl', () => {
  it('carries the organisation acceptance has to open a tenant transaction on', () => {
    expect(new URL(invitationUrl(APP_URL, ORG_ID, TOKEN)).searchParams.get('org')).toBe(ORG_ID);
  });

  it('still keeps the token in the parameter the scrubber censors', () => {
    const url = new URL(invitationUrl(APP_URL, ORG_ID, TOKEN));

    expect(url.searchParams.get(MAIL_LINK_TOKEN_PARAM)).toBe(TOKEN);
    expect(scrubSecrets(`GET ${url.toString()}`)).not.toContain(TOKEN);
  });

  /** The org id is not a credential and must survive the scrubber, or the link arrives unusable. */
  it('leaves the organisation id legible, because it is an identifier and not a secret', () => {
    expect(scrubSecrets(`GET ${invitationUrl(APP_URL, ORG_ID, TOKEN)}`)).toContain(ORG_ID);
  });
});

describe('the three links', () => {
  it('are distinct paths, so one token cannot be replayed against another flow', () => {
    const paths = BUILDERS.map(([, build]) => new URL(build(APP_URL, TOKEN)).pathname);

    expect(new Set(paths).size).toBe(paths.length);
  });
});

/**
 * The one link in this file that carries no token, and the only one T13's "account already exists"
 * mail is allowed to offer.
 *
 * A tokenised reset link here would be a password reset nobody asked for, minted on the say-so of
 * an unauthenticated stranger who typed an address into a signup form. The mail points at the sign
 * in page and lets the account owner start a reset themselves if that is what they need.
 */
describe('signInUrl', () => {
  it('carries no token of any kind', () => {
    expect(new URL(signInUrl(APP_URL)).search).toBe('');
  });

  it('does not double up the slash when APP_URL carries a trailing one', () => {
    expect(signInUrl('https://app.forge.dev/')).toBe(signInUrl(APP_URL));
  });

  it('keeps a base path, so an app mounted under a prefix still resolves', () => {
    expect(new URL(signInUrl('https://forge.dev/app')).pathname).toMatch(/^\/app\//);
  });

  it('stays on the origin it was given', () => {
    expect(new URL(signInUrl(APP_URL)).origin).toBe(APP_URL);
  });

  it('is a different page from any of the tokenised flows', () => {
    const tokenised = BUILDERS.map(([, build]) => new URL(build(APP_URL, TOKEN)).pathname);

    expect(tokenised).not.toContain(new URL(signInUrl(APP_URL)).pathname);
  });
});

/**
 * Spec 028's domain notices (research R14): the project page with its Domains panel open. No token
 * — the reader signs in as usual and the panel is behind the same permission as the page.
 */
describe('projectDomainsUrl', () => {
  const PROJECT_ID = '4f7c1d2e-8b9a-4c3d-9e2f-1a0b3c4d5e6f';

  it('opens the project page with the domains panel', () => {
    const url = new URL(projectDomainsUrl(APP_URL, PROJECT_ID));

    expect(url.pathname).toBe(`/projects/${PROJECT_ID}`);
    expect(url.searchParams.get('panel')).toBe('domains');
  });

  it('carries no token of any kind', () => {
    expect(projectDomainsUrl(APP_URL, PROJECT_ID)).not.toMatch(/token=/);
  });

  it('does not double up the slash when APP_URL carries a trailing one', () => {
    expect(projectDomainsUrl('https://app.forge.dev/', PROJECT_ID)).toBe(
      projectDomainsUrl(APP_URL, PROJECT_ID),
    );
  });

  it('keeps a base path, so an app mounted under a prefix still resolves', () => {
    expect(new URL(projectDomainsUrl('https://forge.dev/app', PROJECT_ID)).pathname).toBe(
      `/app/projects/${PROJECT_ID}`,
    );
  });

  it('percent-encodes the project id into its path segment', () => {
    expect(new URL(projectDomainsUrl(APP_URL, 'a/b')).pathname).toBe('/projects/a%2Fb');
  });
});
