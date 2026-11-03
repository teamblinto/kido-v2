import { describe, expect, it } from 'vitest';

import { domainReleasedMail } from './domain-released';
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

describe('domainReleasedMail', () => {
  it('is the domain-released template, to the recipient it was given', () => {
    const mail = domainReleasedMail(INPUT);

    expect(mail.template).toBe('domain-released');
    expect(mail.to).toBe(INPUT.to);
  });

  it('names the hostname and the project in the subject, unescaped', () => {
    const { subject } = domainReleasedMail(INPUT);

    expect(subject).toContain('app.acme.example');
    expect(subject).toContain('Acme & Co site');
    expect(subject).not.toContain('&amp;');
  });

  it('names the project, says why it was released and what to change to add it again', () => {
    const { text } = domainReleasedMail(INPUT);

    expect(text).toContain('Acme & Co site');
    expect(text).toMatch(/30 days/);
    expect(text).toMatch(/add it again/i);
    expect(text).toMatch(/CNAME record for app\.acme\.example/);
    expect(text).toContain('domains.forge.dev');
  });

  it('links to the project’s domains panel in both parts', () => {
    const mail = domainReleasedMail(INPUT);
    const url = projectDomainsUrl(INPUT.appUrl, PROJECT_ID);

    expect(mail.text).toContain(url);
    expect(mail.html).toContain(url);
  });

  it('escapes the hostname and the project name in the html part', () => {
    const { html } = domainReleasedMail({
      ...INPUT,
      hostname: '<img src=x onerror=alert(1)>.example',
      projectName: '<script>alert(2)</script>',
    });

    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;.example');
  });
});
