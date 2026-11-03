import type { MailMessage } from '../mailer.port';
import { formatDuration, renderHtml, renderText } from './layout';
import { verificationUrl } from './links';

export interface VerificationMailInput {
  /** `APP_URL`. The mail module never reads configuration; the adapter's caller supplies this. */
  readonly appUrl: string;
  /**
   * The window T14's token actually enforces, passed in rather than restated here. A mail that
   * promises 24 hours against a token that expires in one is a support ticket with no error in it.
   */
  readonly expiresInMinutes: number;
  /** Spec 031: where the app goes once the address is confirmed. A relative path, or dropped. */
  readonly next?: string;
  readonly to: string;
  /** The raw token. It reaches the link and nothing else — never the subject, never a log. */
  readonly token: string;
}

/**
 * "Confirm your email address" (T14, success criterion 2).
 *
 * The tone assumes the reader may not have signed up. Signup is enumeration-safe (T13): the
 * response is identical whether or not the address already has an account, so this mail is the only
 * thing that distinguishes the two cases — and it is also what arrives when a stranger types
 * somebody else's address into the form. It therefore states what happened and how to ignore it,
 * and asks for nothing.
 */
export function verificationMail(input: VerificationMailInput): MailMessage {
  const url = verificationUrl(input.appUrl, input.token, input.next);
  const body = {
    action: { label: 'Confirm my email address', url },
    closing: [
      `This link works once and expires in ${formatDuration(input.expiresInMinutes)}.`,
      'If you did not create a Forge account, you can safely ignore this message — nothing was set up in your name.',
    ],
    heading: 'Confirm your email address',
    paragraphs: [
      'Welcome to Forge. Confirm this address to finish setting up your account.',
      'Your account already works — confirming unlocks the parts that need a verified address.',
    ],
  } as const;

  return {
    html: renderHtml(body),
    subject: 'Confirm your email address',
    template: 'email-verification',
    text: renderText(body),
    to: input.to,
  };
}
