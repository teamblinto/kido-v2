import { describe, expect, it } from 'vitest';

import { MAIL_TEMPLATE_IDS, type MailMessage } from '../mailer.port';
import {
  accountExistsMail,
  byosAccountMail,
  domainDriftedMail,
  domainFailedMail,
  domainReleaseWarningMail,
  domainReleasedMail,
  invitationMail,
  passwordResetMail,
  projectInvitationMail,
  verificationMail,
  webhookPausedMail,
} from './index';

const APP_URL = 'https://app.forge.dev';
const TOKEN = 'PJmOx0m9k-2wQ7bYt1RfZs3aLdN6uVcH';
const TO = 'someone@example.com';

/**
 * The mails that carry a token, and the ones that do not.
 *
 * The split arrived with T13. Every mail in spec 001 up to that point was an invitation to complete
 * a flow, so "the link is in both parts" and "the token is not in the subject" could be asserted
 * over the whole catalogue. `account-exists` is the first mail that only *informs* — it is sent to
 * an address somebody else typed, and giving it a token would let an unauthenticated stranger mint
 * live credentials into a mailbox they do not own.
 *
 * Splitting the list rather than loosening the assertion is deliberate: a tokenised template added
 * later still has to satisfy every one of these, and a template that quietly stopped carrying its
 * link would have to be moved between two lists by hand to escape them.
 */
const TOKENISED: readonly MailMessage[] = [
  verificationMail({ appUrl: APP_URL, expiresInMinutes: 1_440, to: TO, token: TOKEN }),
  passwordResetMail({ appUrl: APP_URL, expiresInMinutes: 30, to: TO, token: TOKEN }),
  invitationMail({
    appUrl: APP_URL,
    expiresInMinutes: 10_080,
    invitedBy: 'Dana Okafor',
    orgId: '9c2f7b31-5d84-4a10-bb6e-1f0d2c3e4a55',
    orgName: 'Acme',
    role: 'admin',
    to: TO,
    token: TOKEN,
  }),
  projectInvitationMail({
    appUrl: APP_URL,
    expiresInMinutes: 10_080,
    invitedBy: 'dana@example.com',
    orgId: '9c2f7b31-5d84-4a10-bb6e-1f0d2c3e4a55',
    projectName: 'Launch site',
    role: 'editor',
    to: TO,
    token: TOKEN,
  }),
];

/** Spec 028's custom-domain notices (research R14): they link to a panel, never with a token. */
const DOMAIN_NOTICE = {
  appUrl: APP_URL,
  hostname: 'app.acme.example',
  projectId: '4f7c1d2e-8b9a-4c3d-9e2f-1a0b3c4d5e6f',
  projectName: 'Acme',
  target: 'domains.forge.dev',
  to: TO,
} as const;

const INFORMATIONAL: readonly MailMessage[] = [
  accountExistsMail({ appUrl: APP_URL, to: TO }),
  byosAccountMail({ appUrl: APP_URL, kind: 'needs-reauth', provider: 'anthropic', to: TO }),
  domainDriftedMail(DOMAIN_NOTICE),
  domainFailedMail({ ...DOMAIN_NOTICE, reason: 'verification-timeout' }),
  domainReleaseWarningMail({ ...DOMAIN_NOTICE, releaseInDays: 7 }),
  domainReleasedMail(DOMAIN_NOTICE),
  webhookPausedMail({
    appUrl: APP_URL,
    endpointUrl: 'https://hooks.acme.example/in',
    lastFailure: 'timeout',
    to: TO,
  }),
];

const RENDERED: readonly MailMessage[] = [...TOKENISED, ...INFORMATIONAL];

describe.each(RENDERED.map((message) => [message.template, message] as const))(
  'the %s template',
  (_id, message) => {
    it('addresses the recipient it was given', () => {
      expect(message.to).toBe(TO);
    });

    it('carries a subject that is not empty and not a placeholder', () => {
      expect(message.subject.trim().length).toBeGreaterThan(0);
      expect(message.subject).not.toMatch(/undefined|\[object|\{\{/);
    });

    /** Both parts, always: an HTML-only transactional mail is a deliverability problem. */
    it('carries both an html and a text part', () => {
      expect(message.html.trim().length).toBeGreaterThan(0);
      expect(message.text.trim().length).toBeGreaterThan(0);
    });

    it('renders no unsubstituted placeholder into either part', () => {
      expect(`${message.html}${message.text}`).not.toMatch(/undefined|\[object Object\]|\{\{/);
    });

    it('names a template id from the frozen catalogue', () => {
      expect(MAIL_TEMPLATE_IDS).toContain(message.template);
    });
  },
);

describe.each(TOKENISED.map((message) => [message.template, message] as const))(
  'the tokenised %s template',
  (_id, message) => {
    // A query parameter, or a path segment for spec 031's `/project-invitations/accept/:token`.
    it('puts the action link in both parts, so neither is a dead end', () => {
      const link = new RegExp(`(token=|/)${TOKEN}`);

      expect(message.html).toMatch(link);
      expect(message.text).toMatch(link);
    });

    /**
     * The subject reaches places the body does not: a notification bar, a phone lock screen, a
     * mail-server log, the `Subject` header of every hop in between.
     */
    it('keeps the token out of the subject', () => {
      expect(message.subject).not.toContain(TOKEN);
    });
  },
);

describe.each(INFORMATIONAL.map((message) => [message.template, message] as const))(
  'the informational %s template',
  (_id, message) => {
    /**
     * The inverse of the tokenised rule, asserted rather than assumed. This mail is sent on the
     * say-so of an unauthenticated caller who typed somebody else's address, so a token reaching it
     * — added later by someone making it "more useful" — would be a way to mint live credentials
     * into a mailbox on demand.
     */
    it('carries no token in either part', () => {
      expect(`${message.html}${message.text}`).not.toMatch(/token=/);
    });
  },
);

describe('the template set', () => {
  it('produces a distinct template id per template', () => {
    const ids = RENDERED.map((message) => message.template);

    expect(new Set(ids).size).toBe(RENDERED.length);
  });

  it('covers every id the catalogue publishes', () => {
    expect(RENDERED.map((message) => message.template).sort()).toEqual(
      [...MAIL_TEMPLATE_IDS].sort(),
    );
  });

  it('gives every template a distinct subject, so a client threads them apart', () => {
    const subjects = RENDERED.map((message) => message.subject);

    expect(new Set(subjects).size).toBe(RENDERED.length);
  });
});
