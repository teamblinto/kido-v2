import { describe, expect, it } from 'vitest';

import { byosAccountMail } from './byos-account';
import { accountSettingsUrl } from './links';

const APP_URL = 'https://app.forge.dev';
const TO = 'ada@example.com';

/** Spec 032 contracts § 6: the one mail about a person's linked subscription. */
describe('byosAccountMail', () => {
  it('needs-reauth: asks to reconnect the named provider, linking to the account settings page', () => {
    const mail = byosAccountMail({
      appUrl: APP_URL,
      kind: 'needs-reauth',
      provider: 'anthropic',
      to: TO,
    });

    expect(mail.template).toBe('byos-account');
    expect(mail.to).toBe(TO);
    expect(mail.subject).toBe('Your Anthropic account needs reconnecting');
    expect(mail.text).toContain('Reconnect');
    expect(mail.text).toContain('https://app.forge.dev/settings/account');
    expect(mail.html).toContain('https://app.forge.dev/settings/account');
  });

  it('provider-withdrawn: says the organisation’s API key remains available', () => {
    const mail = byosAccountMail({
      appUrl: APP_URL,
      kind: 'provider-withdrawn',
      provider: 'openai',
      to: TO,
    });

    expect(mail.subject).toBe('OpenAI accounts are no longer supported');
    expect(mail.text).toContain('API key');
    expect(mail.text).toContain('Open settings');
    expect(mail.text).toContain('https://app.forge.dev/settings/account');
  });

  it.each(['needs-reauth', 'provider-withdrawn'] as const)(
    // The input has no organisation field at all, so no organisation can be named (§ 6).
    '%s carries no credential or token',
    (kind) => {
      const mail = byosAccountMail({ appUrl: APP_URL, kind, provider: 'anthropic', to: TO });
      const all = `${mail.subject}${mail.html}${mail.text}`;

      expect(all).not.toMatch(/token=|sk-|Bearer|refresh/i);
    },
  );

  it('accountSettingsUrl joins APP_URL with or without a trailing slash', () => {
    expect(accountSettingsUrl('https://app.forge.dev/')).toBe(
      'https://app.forge.dev/settings/account',
    );
    expect(accountSettingsUrl('https://x.dev/prefix')).toBe(
      'https://x.dev/prefix/settings/account',
    );
  });
});
