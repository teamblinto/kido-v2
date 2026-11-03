import type { LocalAgentPlatform } from '@repo/contracts';

import type { MailMessage } from '../mailer.port';
import { type MailBody, renderHtml, renderText } from './layout';
import { localAgentsSettingsUrl } from './links';

export interface LocalAgentPairedMailInput {
  /** `APP_URL`. */
  readonly appUrl: string;
  /** The name the companion gave itself; shown so the person recognises their own computer. */
  readonly deviceName: string;
  readonly platform: LocalAgentPlatform;
  readonly to: string;
}

const PLATFORM_NAMES: Readonly<Record<LocalAgentPlatform, string>> = {
  linux: 'Linux',
  macos: 'macOS',
  windows: 'Windows',
};

/**
 * Spec 040 § 3 decision 3: a computer was paired to the person's account, so agent runs can reach
 * it. Informational, with no token; the action opens the page where the device can be revoked —
 * the remedy for a pairing the person did not start (an approved phishing code).
 */
export function localAgentPairedMail(input: LocalAgentPairedMailInput): MailMessage {
  const content: MailBody = {
    action: { label: 'Review your computers', url: localAgentsSettingsUrl(input.appUrl) },
    closing: ['You are receiving this because a computer was paired with your account.'],
    heading: 'A computer was paired with your account',
    paragraphs: [
      `“${input.deviceName}” (${PLATFORM_NAMES[input.platform]}) can now run agents for you with the sign-ins on that computer.`,
      'If you did not pair it, revoke it now: agents will stop reaching it at once.',
    ],
  };

  return {
    html: renderHtml(content),
    subject: content.heading,
    template: 'local-agent-paired',
    text: renderText(content),
    to: input.to,
  };
}
