import type { WebhookAttemptFailure } from '@repo/contracts';

import type { MailMessage } from '../mailer.port';
import { type MailBody, renderHtml, renderText } from './layout';
import { webhooksSettingsUrl } from './links';

export interface WebhookPausedMailInput {
  /** `APP_URL`. */
  readonly appUrl: string;
  /** The endpoint's URL. Only its host is rendered: the path and query can carry a receiver token. */
  readonly endpointUrl: string;
  /** The latest recorded failure, or null when none was recorded. */
  readonly lastFailure: WebhookAttemptFailure | null;
  readonly to: string;
}

/** The same words the settings page shows for each failure (`webhook-reasons.ts` in the web app). */
const FAILURE_COPY: Readonly<Record<WebhookAttemptFailure, string>> = {
  'connection-failed': 'The connection could not be made.',
  'destination-refused': 'The address resolved to a private or reserved network.',
  'dns-failed': 'The host name did not resolve.',
  'http-error': 'The receiver answered with an error status.',
  'redirect-not-followed': 'The receiver redirected. Redirects are not followed.',
  'response-too-large': 'The response was over 64 KB.',
  timeout: 'The receiver did not answer within 10 seconds.',
  'tls-failed': 'The TLS handshake failed.',
};

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'your endpoint';
  }
}

/**
 * "Webhook deliveries to {host} are paused" (spec 029 FR-022, research R9): sent once per owner
 * when an endpoint has failed for 24 hours and a delivery gave up. Informational, with no token;
 * the link opens the webhooks settings page, where the endpoint can be re-enabled.
 */
export function webhookPausedMail(input: WebhookPausedMailInput): MailMessage {
  const host = hostOf(input.endpointUrl);
  const content: MailBody = {
    action: { label: 'Open webhook settings', url: webhooksSettingsUrl(input.appUrl) },
    closing: ['You are receiving this because you are an owner of the organisation.'],
    heading: `Webhook deliveries to ${host} are paused`,
    paragraphs: [
      `Deliveries to the webhook endpoint at ${host} have failed for 24 hours, so the endpoint has been paused. New events are recorded but not sent.`,
      ...(input.lastFailure === null
        ? []
        : [`The last attempt failed: ${FAILURE_COPY[input.lastFailure]}`]),
      'Fix the receiver, then enable the endpoint again. Deliveries recorded while it was paused can be replayed one by one from the delivery log.',
    ],
  };

  return {
    html: renderHtml(content),
    subject: `Webhook deliveries to ${host} are paused`,
    template: 'webhook-paused',
    text: renderText(content),
    to: input.to,
  };
}
