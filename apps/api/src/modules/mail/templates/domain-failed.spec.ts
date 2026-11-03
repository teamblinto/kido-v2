import { DOMAIN_FAILURE_REASONS, type DomainFailureReason } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import { domainFailedMail } from './domain-failed';
import { projectDomainsUrl } from './links';

const PROJECT_ID = '4f7c1d2e-8b9a-4c3d-9e2f-1a0b3c4d5e6f';

const INPUT = {
  appUrl: 'https://app.forge.dev',
  hostname: 'app.acme.example',
  projectId: PROJECT_ID,
  projectName: 'Acme & Co site',
  reason: 'verification-timeout',
  target: 'domains.forge.dev',
  to: 'owner@example.com',
} as const;

/**
 * The fix each reason names, one sentence each. Keyed by the contract's closed set, so a reason
 * added there fails to compile here until its sentence is written.
 */
const FIXES = {
  'caa-blocked': /Add the CAA record 0 issue "letsencrypt\.org" to acme\.example/,
  'certificate-failed': /certificate .*could not be issued.*CNAME record .*domains\.forge\.dev/,
  'ownership-not-found': /Add the TXT record _forge-challenge\.app\.acme\.example/,
  'provider-refused': /refused .*app\.acme\.example.*another service/,
  'routing-not-found': /Add a CNAME record for app\.acme\.example pointing at domains\.forge\.dev/,
  'verification-timeout': /within 72 hours.*TXT and CNAME records/,
} as const satisfies Record<DomainFailureReason, RegExp>;

function failed(reason: DomainFailureReason) {
  return domainFailedMail({
    ...INPUT,
    caa: { record: '0 issue "letsencrypt.org"', zone: 'acme.example' },
    reason,
  });
}

describe('domainFailedMail', () => {
  it('is the domain-failed template, to the recipient it was given', () => {
    const mail = domainFailedMail(INPUT);

    expect(mail.template).toBe('domain-failed');
    expect(mail.to).toBe(INPUT.to);
  });

  it('names the hostname and the project in the subject, unescaped', () => {
    const { subject } = domainFailedMail(INPUT);

    expect(subject).toContain('app.acme.example');
    expect(subject).toContain('Acme & Co site');
    expect(subject).not.toContain('&amp;');
  });

  it.each(DOMAIN_FAILURE_REASONS)('names the fix for %s', (reason) => {
    const { text } = failed(reason);

    expect(text).toContain('Acme & Co site');
    expect(text.replaceAll('\n', ' ')).toMatch(FIXES[reason]);
  });

  it('gives each reason its own sentence', () => {
    const bodies = DOMAIN_FAILURE_REASONS.map((reason) => failed(reason).text);

    expect(new Set(bodies).size).toBe(DOMAIN_FAILURE_REASONS.length);
  });

  it('still names a CAA fix when the blocking record is not known', () => {
    const { text } = domainFailedMail({ ...INPUT, reason: 'caa-blocked' });

    expect(text).toMatch(/CAA record/);
    expect(text).toMatch(/letsencrypt\.org|Domains panel/);
  });

  it('still names a routing fix when no target is configured', () => {
    const { text } = domainFailedMail({ ...INPUT, reason: 'routing-not-found', target: undefined });

    expect(text).toMatch(/CNAME record for app\.acme\.example/);
    expect(text).toMatch(/Domains panel/);
  });

  /** research R4: `last_check.edgeMessage` keeps the provider's text for this mail. */
  it('quotes the provider’s refusal, escaped in the html part', () => {
    const mail = domainFailedMail({
      ...INPUT,
      edgeMessage: 'Hostname <b>blocked</b> by policy',
      reason: 'provider-refused',
    });

    expect(mail.text).toContain('Hostname <b>blocked</b> by policy');
    expect(mail.html).not.toContain('<b>blocked</b>');
    expect(mail.html).toContain('&lt;b&gt;blocked&lt;/b&gt;');
  });

  it('offers a retry from the project’s domains panel, linked in both parts', () => {
    const mail = domainFailedMail(INPUT);
    const url = projectDomainsUrl(INPUT.appUrl, PROJECT_ID);

    expect(mail.text).toMatch(/retry/i);
    expect(mail.text).toContain(url);
    expect(mail.html).toContain(url);
  });

  it('escapes the hostname and the project name in the html part', () => {
    const { html } = domainFailedMail({
      ...INPUT,
      hostname: '<img src=x onerror=alert(1)>.example',
      projectName: '<script>alert(2)</script>',
    });

    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;.example');
  });
});
