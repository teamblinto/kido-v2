import { describe, expect, it } from 'vitest';

import { domainDriftedMail } from './domain-drifted';
import { projectDomainsUrl } from './links';

const PROJECT_ID = '4f7c1d2e-8b9a-4c3d-9e2f-1a0b3c4d5e6f';

const INPUT = {
  appUrl: 'https://app.forge.dev',
  hostname: 'app.acme.example',
  projectId: PROJECT_ID,
  projectName: 'Acme & Co site',
  target: 'domains.forge.dev',
  to: 'owner@example.com',
} as const;

describe('domainDriftedMail', () => {
  it('is the domain-drifted template, to the recipient it was given', () => {
    const mail = domainDriftedMail(INPUT);

    expect(mail.template).toBe('domain-drifted');
    expect(mail.to).toBe(INPUT.to);
  });

  /** A subject header is not HTML: `&amp;` in a notification bar is a bug, not a defence. */
  it('names the hostname and the project in the subject, unescaped', () => {
    const { subject } = domainDriftedMail(INPUT);

    expect(subject).toContain('app.acme.example');
    expect(subject).toContain('Acme & Co site');
    expect(subject).not.toContain('&amp;');
  });

  it('names the project and says what to change', () => {
    const { text } = domainDriftedMail(INPUT);

    expect(text).toContain('Acme & Co site');
    expect(text).toMatch(/CNAME record for app\.acme\.example/);
    expect(text).toContain('domains.forge.dev');
    expect(text).toMatch(/CAA/);
    expect(text).toMatch(/30 days/);
  });

  it('still says what to change when no target is configured', () => {
    const { text } = domainDriftedMail({ ...INPUT, target: undefined });

    expect(text).toMatch(/CNAME record for app\.acme\.example/);
    expect(text).toMatch(/Domains panel/);
  });

  it('links to the project’s domains panel in both parts', () => {
    const mail = domainDriftedMail(INPUT);
    const url = projectDomainsUrl(INPUT.appUrl, PROJECT_ID);

    expect(mail.text).toContain(url);
    expect(mail.html).toContain(url);
  });

  it('escapes the hostname and the project name in the html part', () => {
    const { html } = domainDriftedMail({
      ...INPUT,
      hostname: '<img src=x onerror=alert(1)>.example',
      projectName: '<script>alert(2)</script>',
    });

    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;.example');
  });
});
