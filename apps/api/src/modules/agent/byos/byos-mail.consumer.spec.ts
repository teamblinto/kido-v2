import type { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Environment } from '../../../config/environment';
import type { TenantTransaction } from '../../../database/database.types';
import type { AccountService } from '../../identity/services/account.service';
import { InMemoryMailer } from '../../mail/in-memory.mailer';
import { mailFailed } from '../../mail/mailer.port';
import { MailNotDeliveredError, RetryableFailure } from '../../outbox/consumer';
import type { Envelope } from '../../outbox/envelope';
import { ByosMailConsumer } from './byos-mail.consumer';

const APP_URL = 'https://app.forge.test';
const USER = '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5a';
const ACCOUNT = '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5b';

function event(
  kind: 'needs-reauth' | 'provider-withdrawn' = 'needs-reauth',
): Envelope<'mail.byos'> {
  return {
    aggregate: 'linked-account',
    aggregateId: ACCOUNT,
    eventId: '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5c',
    occurredAt: '2026-09-24T10:00:00.000Z',
    orgId: null,
    payload: { kind, provider: 'anthropic', recipientUserId: USER },
    traceId: null,
    type: 'mail.byos',
  };
}

/**
 * Spec 032 T014: the `mail.byos` consumer, modelled on `WebhookMailConsumer`. It asks identity for
 * the address (`AccountService.noticeAddress`, R1) and never reads `users` itself — the
 * transaction it is handed is a sentinel that throws if touched.
 */
describe('ByosMailConsumer', () => {
  let mailer: InMemoryMailer;
  let addresses: Map<string, string>;
  let asked: string[];
  let consumer: ByosMailConsumer;
  const untouchable = new Proxy({} as TenantTransaction, {
    get() {
      throw new Error('the consumer must not read the database');
    },
  });

  beforeEach(() => {
    mailer = new InMemoryMailer();
    addresses = new Map([[USER, 'ada@example.com']]);
    asked = [];
    const accounts = {
      noticeAddress: (userId: string) => {
        asked.push(userId);
        return Promise.resolve(addresses.get(userId));
      },
    } as unknown as AccountService;
    const config = {
      get: (key: string) => (key === 'APP_URL' ? APP_URL : undefined),
    } as unknown as ConfigService<Environment, true>;
    consumer = new ByosMailConsumer(mailer, accounts, config);
  });

  it('is on the mail lane for mail.byos, keyed by event id', () => {
    expect(consumer.queue).toBe('mail');
    expect(consumer.types).toEqual(['mail.byos']);
    expect(consumer.jobId(event())).toBe('mail.byos.4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5c');
  });

  it.each(['needs-reauth', 'provider-withdrawn'] as const)(
    'renders the %s variant to the address identity gives, and sends it after commit',
    async (kind) => {
      const message = await consumer.handle(event(kind), untouchable);

      expect(asked).toEqual([USER]);
      expect(message).toMatchObject({ template: 'byos-account', to: 'ada@example.com' });
      expect(mailer.outbox).toHaveLength(0);

      await consumer.effect(event(kind), message);
      expect(mailer.outbox).toHaveLength(1);
      expect(mailer.outbox[0]!.text).toContain(`${APP_URL}/settings/account`);
    },
  );

  it('records the event without a send when there is no address', async () => {
    addresses.clear();

    const message = await consumer.handle(event(), untouchable);
    await consumer.effect(event(), message);

    expect(message).toBeUndefined();
    expect(mailer.deliveries).toHaveLength(0);
  });

  it('classifies a failed send: retryable is retried, permanent is not', async () => {
    const message = await consumer.handle(event(), untouchable);

    mailer.failNext();
    await expect(consumer.effect(event(), message)).rejects.toBeInstanceOf(RetryableFailure);
    mailer.failNext(mailFailed('invalid-recipient', 'no such mailbox'));
    await expect(consumer.effect(event(), message)).rejects.toBeInstanceOf(MailNotDeliveredError);
  });
});
