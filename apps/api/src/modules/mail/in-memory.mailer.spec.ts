import { describe, expect, it } from 'vitest';

import { InMemoryMailer } from './in-memory.mailer';
import { type MailMessage, mailFailed } from './mailer.port';
import { passwordResetMail, verificationMail } from './templates';

const APP_URL = 'https://app.forge.dev';
const TOKEN = 'PJmOx0m9k-2wQ7bYt1RfZs3aLdN6uVcH';

function verification(to: string): MailMessage {
  return verificationMail({ appUrl: APP_URL, expiresInMinutes: 1_440, to, token: TOKEN });
}

function reset(to: string): MailMessage {
  return passwordResetMail({ appUrl: APP_URL, expiresInMinutes: 30, to, token: TOKEN });
}

describe('InMemoryMailer on a successful send', () => {
  it('reports the mail as sent', async () => {
    expect(await new InMemoryMailer().send(verification('a@example.com'))).toEqual({
      outcome: 'sent',
      providerMessageId: undefined,
    });
  });

  it('keeps every delivered message, in order', async () => {
    const mailer = new InMemoryMailer();

    await mailer.send(verification('first@example.com'));
    await mailer.send(verification('second@example.com'));

    expect(mailer.outbox.map((message) => message.to)).toEqual([
      'first@example.com',
      'second@example.com',
    ]);
  });

  it('starts empty', () => {
    expect(new InMemoryMailer().outbox).toEqual([]);
  });

  /** A test that mutates the outbox it is asserting on is a test that passes for the wrong reason. */
  it('hands out a copy, so a test cannot edit the record it is asserting on', async () => {
    const mailer = new InMemoryMailer();

    await mailer.send(verification('a@example.com'));
    (mailer.outbox as MailMessage[]).length = 0;

    expect(mailer.outbox).toHaveLength(1);
  });
});

describe('InMemoryMailer lookups', () => {
  it('filters by recipient', async () => {
    const mailer = new InMemoryMailer();

    await mailer.send(verification('a@example.com'));
    await mailer.send(verification('b@example.com'));
    await mailer.send(reset('a@example.com'));

    expect(mailer.to('a@example.com').map((message) => message.template)).toEqual([
      'email-verification',
      'password-reset',
    ]);
  });

  /** `users.email` is `citext`, so `Someone@Example.com` and `someone@example.com` are one account. */
  it('matches a recipient case-insensitively, like the column does', async () => {
    const mailer = new InMemoryMailer();

    await mailer.send(verification('Someone@Example.com'));

    expect(mailer.to('someone@example.com')).toHaveLength(1);
  });

  it('returns the most recent message to an address', async () => {
    const mailer = new InMemoryMailer();

    await mailer.send(verification('a@example.com'));
    await mailer.send(reset('a@example.com'));

    expect(mailer.lastTo('a@example.com')?.template).toBe('password-reset');
  });

  it('returns undefined for an address it never wrote to', () => {
    expect(new InMemoryMailer().lastTo('nobody@example.com')).toBeUndefined();
  });

  it('finds by template, which is what an assertion usually means', async () => {
    const mailer = new InMemoryMailer();

    await mailer.send(verification('a@example.com'));
    await mailer.send(reset('a@example.com'));

    expect(mailer.lastOf('email-verification')?.to).toBe('a@example.com');
  });
});

describe('InMemoryMailer scripted failures', () => {
  /**
   * The behaviour T13 has to be able to prove: the account still exists after the mail fails, and
   * the failure was audited rather than swallowed. Without a way to make a send fail, that path is
   * only ever exercised by an outage in production.
   */
  it('fails the next send when one is queued', async () => {
    const mailer = new InMemoryMailer();

    mailer.failNext();

    expect(await mailer.send(verification('a@example.com'))).toMatchObject({ outcome: 'failed' });
  });

  it('fails with the failure it was given', async () => {
    const mailer = new InMemoryMailer();

    mailer.failNext(mailFailed('invalid-recipient', 'the address bounced'));

    expect(await mailer.send(verification('a@example.com'))).toMatchObject({
      failure: { reason: 'invalid-recipient', retryable: false },
      outcome: 'failed',
    });
  });

  it('defaults to a retryable failure, which is the interesting case', async () => {
    const mailer = new InMemoryMailer();

    mailer.failNext();
    const delivery = await mailer.send(verification('a@example.com'));

    expect(delivery.outcome === 'failed' && delivery.failure.retryable).toBe(true);
  });

  it('keeps a failed message out of the outbox, because it was not delivered', async () => {
    const mailer = new InMemoryMailer();

    mailer.failNext();
    await mailer.send(verification('a@example.com'));

    expect(mailer.outbox).toEqual([]);
  });

  /** "It was attempted and it failed" and "it was never attempted" are different bugs. */
  it('records the attempt, so a test can tell a failed send from an absent one', async () => {
    const mailer = new InMemoryMailer();

    mailer.failNext();
    await mailer.send(verification('a@example.com'));

    const [attempt] = mailer.deliveries;

    expect(mailer.deliveries).toHaveLength(1);
    expect(attempt?.delivery.outcome).toBe('failed');
    expect(attempt?.message.template).toBe('email-verification');
  });

  it('applies to one send only', async () => {
    const mailer = new InMemoryMailer();

    mailer.failNext();
    await mailer.send(verification('a@example.com'));

    expect((await mailer.send(verification('a@example.com'))).outcome).toBe('sent');
  });

  it('applies queued failures in the order they were scripted', async () => {
    const mailer = new InMemoryMailer();

    mailer.failNext(mailFailed('throttled', 'first'));
    mailer.failNext(mailFailed('invalid-recipient', 'second'));

    const first = await mailer.send(verification('a@example.com'));
    const second = await mailer.send(verification('a@example.com'));

    expect(first).toMatchObject({ failure: { reason: 'throttled' } });
    expect(second).toMatchObject({ failure: { reason: 'invalid-recipient' } });
  });

  it('never rejects, exactly like the adapters it stands in for', async () => {
    const mailer = new InMemoryMailer();

    mailer.failNext();

    await expect(mailer.send(verification('a@example.com'))).resolves.toBeDefined();
  });
});

describe('InMemoryMailer.clear', () => {
  it('empties the outbox and the attempt record', async () => {
    const mailer = new InMemoryMailer();

    await mailer.send(verification('a@example.com'));
    mailer.clear();

    expect(mailer.outbox).toEqual([]);
    expect(mailer.deliveries).toEqual([]);
  });

  /** A failure left scripted by one test is a failure the next test spends an hour on. */
  it('discards failures that were scripted and never used', async () => {
    const mailer = new InMemoryMailer();

    mailer.failNext();
    mailer.clear();

    expect((await mailer.send(verification('a@example.com'))).outcome).toBe('sent');
  });
});
