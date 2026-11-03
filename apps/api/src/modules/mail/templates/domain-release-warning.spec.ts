import { describe, expect, it } from 'vitest';

import { domainReleaseWarningMail } from './domain-release-warning';
import { projectDomainsUrl } from './links';

const PROJECT_ID = '4f7c1d2e-8b9a-4c3d-9e2f-1a0b3c4d5e6f';

const INPUT = {
  appUrl: 'https://app.forge.dev',
  hostname: 'app.acme.example',
  projectId: PROJECT_ID,
  projectName: 'Acme & Co site',
  releaseInDays: 7,
  target: 'domains.forge.dev',
  to: 'owner@example.com',
} as const;

describe('domainReleaseWarningMail', () => {
  it('is the domain-release-warning template, to the recipient it was given', () => {
    const mail = domainReleaseWarningMail(INPUT);

    expect(mail.template).toBe('domain-release-warning');
    expect(mail.to).toBe(INPUT.to);
  });

  it('names the hostname, the project and the days left in the subject, unescaped', () => {
    const { subject } = domainReleaseWarningMail(INPUT);

    expect(subject).toContain('app.acme.example');
    expect(subject).toContain('Acme & Co site');
    expect(subject).toContain('7 days');
    expect(subject).not.toContain('&amp;');
  });

  it('names the project, when it will be released and what to change', () => {
    const { text } = domainReleaseWarningMail(INPUT);

    expect(text).toContain('Acme & Co site');
    expect(text).toMatch(/released .*in 7 days/);
    expect(text).toMatch(/CNAME record for app\.acme\.example/);
    expect(text).toContain('domains.forge.dev');
  });

  it('says one day, not one days', () => {
    expect(domainReleaseWarningMail({ ...INPUT, releaseInDays: 1 }).subject).toContain('1 day');
    expect(domainReleaseWarningMail({ ...INPUT, releaseInDays: 1 }).subject).not.toContain(
      '1 days',
    );
  });

  it('links to the project’s domains panel in both parts', () => {
    const mail = domainReleaseWarningMail(INPUT);
    const url = projectDomainsUrl(INPUT.appUrl, PROJECT_ID);

    expect(mail.text).toContain(url);
    expect(mail.html).toContain(url);
  });

  it('escapes the hostname and the project name in the html part', () => {
    const { html } = domainReleaseWarningMail({
      ...INPUT,
      hostname: '<img src=x onerror=alert(1)>.example',
      projectName: '<script>alert(2)</script>',
    });

    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;.example');
  });
});
