import { describe, expect, it } from 'vitest';

import { ConsoleMailer, ConsoleMailerRefusedError, firstUrlIn } from './console.mailer';
import type { MailMessage } from './mailer.port';
import { verificationMail } from './templates';

const FROM = 'Forge <noreply@forge.dev>';
const TOKEN = 'PJmOx0m9k-2wQ7bYt1RfZs3aLdN6uVcH';

const MESSAGE: MailMessage = verificationMail({
  appUrl: 'https://app.forge.dev',
  expiresInMinutes: 1_440,
  to: 'someone@example.com',
  token: TOKEN,
});

function printing(): { lines: string[]; mailer: ConsoleMailer } {
  const lines: string[] = [];

  return {
    lines,
    mailer: new ConsoleMailer({
      deployEnv: 'local',
      from: FROM,
      write: (line) => lines.push(line),
    }),
  };
}

describe('ConsoleMailer on a real deployment', () => {
  /**
   * The same shape `EnvKekProvider` uses, for the same kind of reason. A deployment configured to
   * "send" its mail into a log file is one where nobody receives a verification link and nothing
   * reports a failure — every send answers `sent`. That is worse than not booting, and it is only
   * discovered when a user says they never got the mail.
   *
   * It is also what makes writing the rendered mail straight to stdout acceptable: that output
   * carries a live token, and this refusal is what confines it to a developer's own terminal.
   */
  it.each(['staging', 'production'] as const)('refuses to construct on %s', (deployEnv) => {
    expect(() => new ConsoleMailer({ deployEnv, from: FROM })).toThrow(ConsoleMailerRefusedError);
  });

  it('names both DEPLOY_ENV and MAIL_PROVIDER, so the fix is obvious from the boot log', () => {
    let caught: unknown;

    try {
      new ConsoleMailer({ deployEnv: 'production', from: FROM });
    } catch (error) {
      caught = error;
    }

    expect((caught as Error).message).toContain('DEPLOY_ENV');
    expect((caught as Error).message).toContain('MAIL_PROVIDER');
  });

  it('constructs on local', () => {
    expect(new ConsoleMailer({ deployEnv: 'local', from: FROM })).toBeInstanceOf(ConsoleMailer);
  });
});

describe('ConsoleMailer.send', () => {
  it('reports the mail as sent', async () => {
    const { mailer } = printing();

    expect(await mailer.send(MESSAGE)).toEqual({ outcome: 'sent', providerMessageId: undefined });
  });

  it('never fails, because there is nothing between it and the terminal', async () => {
    const { mailer } = printing();

    for (const to of ['a@example.com', 'not-an-address', '']) {
      expect((await mailer.send({ ...MESSAGE, to })).outcome).toBe('sent');
    }
  });

  it('prints the recipient, the sender, the subject and the template id', async () => {
    const { lines, mailer } = printing();

    await mailer.send(MESSAGE);

    const printed = lines.join('\n');

    expect(printed).toContain(MESSAGE.to);
    expect(printed).toContain(FROM);
    expect(printed).toContain(MESSAGE.subject);
    expect(printed).toContain(MESSAGE.template);
  });

  /**
   * The point of this adapter. A developer signing up locally has to be able to click through to
   * verification without opening a database, so the link is printed alone on its line — terminals
   * linkify a bare URL, and one with anything trailing it is one that does not open.
   */
  it('prints the action link alone on a line, so the terminal makes it clickable', async () => {
    const { lines, mailer } = printing();

    await mailer.send(MESSAGE);

    expect(lines.join('\n').split('\n')).toContain(
      `https://app.forge.dev/auth/verify?${new URLSearchParams({ token: TOKEN }).toString()}`,
    );
  });

  it('prints the text body, so a mail with no link is still readable', async () => {
    const { lines, mailer } = printing();

    await mailer.send({ ...MESSAGE, html: '<p>ignored</p>', text: 'Nothing to click here.' });

    expect(lines.join('\n')).toContain('Nothing to click here.');
  });

  /** The HTML part is noise in a terminal, and printing it buries the link it exists to show. */
  it('does not print the html part', async () => {
    const { lines, mailer } = printing();

    await mailer.send(MESSAGE);

    expect(lines.join('\n')).not.toContain('<!doctype html>');
  });

  it('keeps sends in order and separate', async () => {
    const { lines, mailer } = printing();

    await mailer.send({ ...MESSAGE, to: 'first@example.com' });
    await mailer.send({ ...MESSAGE, to: 'second@example.com' });

    const printed = lines.join('\n');

    expect(printed.indexOf('first@example.com')).toBeLessThan(
      printed.indexOf('second@example.com'),
    );
  });
});

describe('firstUrlIn', () => {
  it('finds an http and an https url', () => {
    expect(firstUrlIn('go to https://a.test/x?token=1 now')).toBe('https://a.test/x?token=1');
    expect(firstUrlIn('go to http://a.test/x now')).toBe('http://a.test/x');
  });

  it('returns the first when there are several', () => {
    expect(firstUrlIn('https://a.test/1 and https://b.test/2')).toBe('https://a.test/1');
  });

  it('stops at whitespace and at a newline', () => {
    expect(firstUrlIn('https://a.test/x\nmore text')).toBe('https://a.test/x');
  });

  /** A link at the end of an English sentence must not swallow the full stop and 404. */
  it('does not take a trailing sentence-ending punctuation mark', () => {
    expect(firstUrlIn('Open https://a.test/x.')).toBe('https://a.test/x');
    expect(firstUrlIn('Open https://a.test/x, then')).toBe('https://a.test/x');
  });

  it('returns undefined when there is no url', () => {
    expect(firstUrlIn('no links here')).toBeUndefined();
  });

  it('ignores a scheme it cannot open in a browser', () => {
    expect(firstUrlIn('otpauth://totp/Forge:someone')).toBeUndefined();
  });
});
