import type { LlmProvider } from '@repo/contracts';

import type { MailMessage } from '../mailer.port';
import { type MailBody, renderHtml, renderText } from './layout';
import { accountSettingsUrl } from './links';

export interface ByosAccountMailInput {
  /** `APP_URL`. */
  readonly appUrl: string;
  readonly kind: 'needs-reauth' | 'provider-withdrawn';
  readonly provider: LlmProvider;
  readonly to: string;
}

const PROVIDER_NAMES: Readonly<Record<LlmProvider, string>> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
};

/**
 * Spec 032 contracts § 6: the one mail about a person's own linked subscription. Informational,
 * with no token and nothing of the grant; it is about the person's account, so it names no
 * organisation — the input has none to name. The action opens the person's account settings.
 */
export function byosAccountMail(input: ByosAccountMailInput): MailMessage {
  const name = PROVIDER_NAMES[input.provider];
  const url = accountSettingsUrl(input.appUrl);
  const content: MailBody =
    input.kind === 'needs-reauth'
      ? {
          action: { label: 'Reconnect', url },
          closing: ['You are receiving this because you linked this account.'],
          heading: `Your ${name} account needs reconnecting`,
          paragraphs: [
            `Your linked ${name} account can no longer be used: the provider stopped accepting its sign-in.`,
            `Runs that would use your ${name} account will not start until you reconnect it.`,
          ],
        }
      : {
          action: { label: 'Open settings', url },
          closing: ['You are receiving this because you linked this account.'],
          heading: `${name} accounts are no longer supported`,
          paragraphs: [
            `Linking a personal ${name} account is no longer supported, so your linked account will not be used again.`,
            `The organisation's ${name} API key remains available wherever it is set up.`,
          ],
        };

  return {
    html: renderHtml(content),
    subject: content.heading,
    template: 'byos-account',
    text: renderText(content),
    to: input.to,
  };
}
