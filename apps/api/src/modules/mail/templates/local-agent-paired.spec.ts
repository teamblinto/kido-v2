import { describe, expect, it } from 'vitest';

import { localAgentPairedMail } from './local-agent-paired';

/** Spec 040: the notice that a computer was paired, so an unexpected pairing is noticed. */
describe('localAgentPairedMail', () => {
  it('names the device and links to the page where it can be revoked', () => {
    const mail = localAgentPairedMail({
      appUrl: 'https://app.forge.dev/',
      deviceName: 'Ada’s laptop',
      platform: 'macos',
      to: 'ada@example.com',
    });

    expect(mail.template).toBe('local-agent-paired');
    expect(mail.to).toBe('ada@example.com');
    expect(mail.subject).toBe('A computer was paired with your account');
    expect(mail.text).toContain('Ada’s laptop');
    expect(mail.text).toContain('macOS');
    expect(mail.text).toContain('revoke');
    expect(mail.text).toContain('https://app.forge.dev/settings/local-agents');
    expect(mail.html).toContain('https://app.forge.dev/settings/local-agents');
  });

  it('escapes a device name in the html part', () => {
    const mail = localAgentPairedMail({
      appUrl: 'https://app.forge.dev',
      deviceName: '<script>x</script>',
      platform: 'linux',
      to: 'ada@example.com',
    });

    expect(mail.html).not.toContain('<script>x</script>');
  });
});
