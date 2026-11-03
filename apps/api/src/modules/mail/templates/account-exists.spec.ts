import { describe, expect, it } from 'vitest';

import { accountExistsMail } from './account-exists';
import { signInUrl } from './links';

const APP_URL = 'https://app.forge.dev';
const TO = 'ada@example.com';

const mail = accountExistsMail({ appUrl: APP_URL, to: TO });

describe('accountExistsMail', () => {
  it('goes to the address that was typed, under its own template id', () => {
    expect(mail.to).toBe(TO);
    expect(mail.template).toBe('account-exists');
  });

  it('renders both body parts', () => {
    expect(mail.html).toContain('<!doctype html>');
    expect(mail.text.length).toBeGreaterThan(0);
  });

  /**
   * The mail is the only place the truth is told, so it has to be readable by somebody who has
   * forgotten they ever signed up. It is also read by whoever typed the address — which may not be
   * the owner — so it says what did *not* happen as plainly as what did.
   */
  it('says no second account was created and nothing changed', () => {
    expect(mail.text).toMatch(/already/i);
    expect(mail.text).toMatch(/(unchanged|nothing has changed|no changes)/i);
  });

  it('offers the sign-in page and no tokenised link', () => {
    expect(mail.text).toContain(signInUrl(APP_URL));
    expect(mail.text).not.toMatch(/token=/);
    expect(mail.html).not.toMatch(/token=/);
  });

  /**
   * The subject is the one part of this mail visible without opening it — on a lock screen, in a
   * notification, over somebody's shoulder. "Your Forge account" says nothing to a bystander that
   * the recipient's own inbox does not already say; "Someone tried to sign up as you" announces a
   * security event to the room.
   */
  it('keeps the address and the attempt out of the subject line', () => {
    expect(mail.subject).not.toContain(TO);
    expect(mail.subject).not.toMatch(/sign.?up|attempt|someone/i);
  });

  /**
   * §05: the address is the user's own and belongs in the body it was sent to, but it must not be
   * interpolated raw into HTML — a mailbox is a user-controlled string and this is the one template
   * whose recipient did not necessarily choose it.
   */
  it('escapes an address containing markup', () => {
    const hostile = accountExistsMail({
      appUrl: APP_URL,
      to: '"><script>alert(1)</script>"@example.com',
    });

    expect(hostile.html).not.toContain('<script>');
  });
});
