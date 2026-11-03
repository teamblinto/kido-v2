import { describe, expect, it } from 'vitest';

import { webhooksSettingsUrl } from './links';
import { webhookPausedMail } from './webhook-paused';

const INPUT = {
  appUrl: 'https://app.forge.dev',
  endpointUrl: 'https://hooks.acme.example/forge/in?token=s3cr3t',
  lastFailure: 'timeout',
  to: 'owner@example.com',
} as const;

/** Spec 029 T066 — the mail an owner gets when an endpoint is paused after 24 h of failures. */
describe('webhookPausedMail', () => {
  it('is the webhook-paused template, to the recipient it was given', () => {
    const mail = webhookPausedMail(INPUT);

    expect(mail.template).toBe('webhook-paused');
    expect(mail.to).toBe(INPUT.to);
  });

  it("names the endpoint URL's host, never its path or query", () => {
    const mail = webhookPausedMail(INPUT);
    const all = `${mail.subject}${mail.html}${mail.text}`;

    expect(mail.subject).toContain('hooks.acme.example');
    expect(mail.text).toContain('hooks.acme.example');
    expect(all).not.toContain('/forge/in');
    expect(all).not.toContain('s3cr3t');
  });

  it("carries the last failure's copy", () => {
    expect(webhookPausedMail(INPUT).text).toContain('did not answer within 10 seconds');
    expect(webhookPausedMail({ ...INPUT, lastFailure: 'dns-failed' }).text).toContain(
      'did not resolve',
    );
  });

  it('still reads when no failure was recorded', () => {
    const { text } = webhookPausedMail({ ...INPUT, lastFailure: null });

    expect(text).toMatch(/paused/);
    expect(text).not.toMatch(/undefined|null/);
  });

  it('links to the webhooks settings page in both parts', () => {
    const mail = webhookPausedMail(INPUT);
    const url = webhooksSettingsUrl(INPUT.appUrl);

    expect(url).toBe('https://app.forge.dev/settings/webhooks');
    expect(mail.text).toContain(url);
    expect(mail.html).toContain(url);
  });

  it('escapes the host in the html part', () => {
    const { html } = webhookPausedMail({
      ...INPUT,
      endpointUrl: 'https://xn--<script>.example/',
    });

    expect(html).not.toContain('<script>');
  });
});
