import type { MailMessage } from '../mailer.port';
import { renderHtml, renderText } from './layout';
import { signInUrl } from './links';

export interface AccountExistsMailInput {
  /** `APP_URL`. The mail module never reads configuration; the caller supplies this. */
  readonly appUrl: string;
  /** Spec 031: the same return address the verification mail would have carried. */
  readonly next?: string;
  readonly to: string;
}

/**
 * "You already have a Forge account" (T13, ADR 007).
 *
 * This mail is the entire cost of enumeration-safe signup, and the reason the endpoint can answer a
 * known and an unknown address identically. `POST /auth/signup` never says an account exists, so
 * this is the only channel that does — and it reaches the mailbox rather than the caller, which is
 * exactly the property that makes it useless to somebody probing for registered addresses.
 *
 * Two audiences read it and it is written for both. The account owner who forgot they had signed up
 * needs to be told they already have one and pointed at the way in. Someone who typed this address
 * without owning it needs to learn nothing except that they should stop — which is why there is no
 * token, no account detail, and no statement of when the account was created or what is in it.
 *
 * There is deliberately no mention of the password that was submitted, not even that one was. A
 * line like "the password you entered was not saved" is reassuring to the owner and confirms to a
 * prober that their request reached a real account.
 */
export function accountExistsMail(input: AccountExistsMailInput): MailMessage {
  const body = {
    action: { label: 'Sign in', url: signInUrl(input.appUrl, input.next) },
    closing: [
      'If you did not try to sign up, you can ignore this message — nothing has changed and no new account was created.',
    ],
    heading: 'You already have a Forge account',
    paragraphs: [
      `Someone just tried to sign up with ${input.to}, and that address already has a Forge account.`,
      'No second account was created and your password was not changed. If it was you, sign in below — and if you have forgotten your password, you can reset it from the sign-in page.',
    ],
  } as const;

  return {
    html: renderHtml(body),
    // Says nothing a bystander could read off a lock screen. The signup attempt is a security
    // event, and announcing it in the subject broadcasts it to whoever can see the notification.
    subject: 'Your Forge account',
    template: 'account-exists',
    text: renderText(body),
    to: input.to,
  };
}
