import { describe, expect, it } from 'vitest';

import { invitationMail } from './invitation';

const ORG_ID = '9c2f7b31-5d84-4a10-bb6e-1f0d2c3e4a55';

const INPUT = {
  appUrl: 'https://app.forge.dev',
  expiresInMinutes: 10_080,
  invitedBy: 'Dana Okafor',
  orgId: ORG_ID,
  orgName: 'Acme',
  role: 'admin',
  to: 'someone@example.com',
  token: 'PJmOx0m9k-2wQ7bYt1RfZs3aLdN6uVcH',
} as const;

describe('invitationMail', () => {
  it('is the invitation template', () => {
    expect(invitationMail(INPUT).template).toBe('invitation');
  });

  it('points at the accept route', () => {
    expect(invitationMail(INPUT).text).toContain('/invitations/accept?token=');
  });

  /**
   * Acceptance opens a tenant transaction before it reads anything, and the resolver takes the
   * organisation from the request rather than from a lookup — so a link without the id is one the
   * recipient cannot act on. `links.ts` argues why handing it out costs nothing.
   */
  it('carries the organisation the accept route has to open a transaction on', () => {
    expect(invitationMail(INPUT).text).toContain(`org=${ORG_ID}`);
  });

  it('names the organisation, the inviter and the role', () => {
    const { text } = invitationMail(INPUT);

    expect(text).toContain('Acme');
    expect(text).toContain('Dana Okafor');
    expect(text).toContain('admin');
  });

  it('states the expiry it was given', () => {
    expect(invitationMail(INPUT).text).toContain('7 days');
  });

  /**
   * The organisation name, the inviter's display name and the role all originate with a user, and
   * this is the one template in the set that interpolates values a stranger chose. An org named
   * `<img src=x onerror=…>` must reach the recipient as text.
   */
  it('escapes organisation and inviter names in the html part', () => {
    const { html } = invitationMail({
      ...INPUT,
      invitedBy: '<script>alert(1)</script>',
      orgName: '<img src=x onerror=alert(2)>',
    });

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes a name that would otherwise close the subject line into the html', () => {
    expect(invitationMail({ ...INPUT, orgName: '"><b>x</b>' }).html).not.toContain('<b>x</b>');
  });

  /**
   * The subject reaches a notification bar and a mail-server log. It carries the organisation name
   * because that is what makes the mail recognisable, but it is not HTML and must not be escaped
   * into gibberish there.
   */
  it('names the organisation in the subject, unescaped, because a subject is not html', () => {
    expect(invitationMail({ ...INPUT, orgName: 'Acme & Co' }).subject).toContain('Acme & Co');
  });

  it('omits the inviter gracefully when there is no display name to show', () => {
    const { text } = invitationMail({ ...INPUT, invitedBy: undefined });

    expect(text).toContain('Acme');
    expect(text).not.toMatch(/undefined|\bby\s*$/m);
  });
});
