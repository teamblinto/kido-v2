import type { MailMessage } from '../mailer.port';
import { formatDuration, renderHtml, renderText } from './layout';
import { passwordResetUrl } from './links';

export interface PasswordResetMailInput {
  /** `APP_URL`. The mail module never reads configuration; the adapter's caller supplies this. */
  readonly appUrl: string;
  /** The window T19's token enforces — 30 minutes — passed in rather than restated here. */
  readonly expiresInMinutes: number;
  readonly to: string;
  /** The raw token. It reaches the link and nothing else — never the subject, never a log. */
  readonly token: string;
}

/**
 * "Reset your password" (T19, success criterion 7).
 *
 * Two sentences here are load-bearing rather than polite. It says that ignoring the mail leaves the
 * password unchanged, because `POST /auth/password/reset` answers identically for a known and an
 * unknown address and this mail is the only signal a real account owner gets — including when the
 * person who asked was not them. And it says that completing the reset signs every device out,
 * because §11 requires exactly that and a user who is silently logged out everywhere files a bug.
 */
export function passwordResetMail(input: PasswordResetMailInput): MailMessage {
  const url = passwordResetUrl(input.appUrl, input.token);
  const body = {
    action: { label: 'Choose a new password', url },
    closing: [
      `This link works once and expires in ${formatDuration(input.expiresInMinutes)}.`,
      'If you did not request this, you can ignore this message — your password is unchanged and nobody was given access.',
    ],
    heading: 'Reset your password',
    paragraphs: [
      'Someone asked to reset the password for this Forge account.',
      'Choosing a new password signs you out on every device, so you will need to sign in again wherever you use Forge.',
    ],
  } as const;

  return {
    html: renderHtml(body),
    subject: 'Reset your Forge password',
    template: 'password-reset',
    text: renderText(body),
    to: input.to,
  };
}
