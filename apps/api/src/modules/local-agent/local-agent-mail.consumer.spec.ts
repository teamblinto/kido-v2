import type { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Environment } from '../../config/environment';
import type { TenantTransaction } from '../../database/database.types';
import type { AccountService } from '../identity/services/account.service';
import { InMemoryMailer } from '../mail/in-memory.mailer';
import type { Envelope } from '../outbox/envelope';
import { LocalAgentMailConsumer } from './local-agent-mail.consumer';
import type { LocalAgentRepository } from './local-agent.repository';

const APP_URL = 'https://app.forge.test';
const USER = '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5a';
const DEVICE = '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5b';

function event(): Envelope<'mail.local-agent-paired'> {
  return {
    aggregate: 'local-agent-device',
    aggregateId: DEVICE,
    eventId: '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5c',
    occurredAt: '2026-11-02T10:00:00.000Z',
    orgId: null,
    payload: { deviceId: DEVICE, recipientUserId: USER },
    traceId: null,
    type: 'mail.local-agent-paired',
  };
}

/** Spec 040: the pairing notice, so a pairing the person did not start does not go unnoticed. */
describe('LocalAgentMailConsumer', () => {
  let mailer: InMemoryMailer;
  let device:
    { name: string; platform: string; revokedAt: Date | null; userId: string } | undefined;
  let consumer: LocalAgentMailConsumer;
  const tx = {} as TenantTransaction;

  beforeEach(() => {
    mailer = new InMemoryMailer();
    device = { name: 'Ada’s laptop', platform: 'windows', revokedAt: null, userId: USER };
    const accounts = {
      noticeAddress: (userId: string) =>
        Promise.resolve(userId === USER ? 'ada@example.com' : undefined),
    } as unknown as AccountService;
    const repository = {
      byId: () => Promise.resolve(device),
    } as unknown as LocalAgentRepository;
    const config = {
      get: (key: string) => (key === 'APP_URL' ? APP_URL : undefined),
    } as unknown as ConfigService<Environment, true>;
    consumer = new LocalAgentMailConsumer(mailer, accounts, repository, config);
  });

  it('is on the mail lane, keyed by event id', () => {
    expect(consumer.queue).toBe('mail');
    expect(consumer.types).toEqual(['mail.local-agent-paired']);
    expect(consumer.jobId(event())).toBe(
      'mail.local-agent-paired.4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5c',
    );
  });

  it('mails the owner, naming the device and linking to where it is revoked', async () => {
    const message = await consumer.handle(event(), tx);

    expect(message).toMatchObject({ template: 'local-agent-paired', to: 'ada@example.com' });
    await consumer.effect(event(), message);
    expect(mailer.outbox).toHaveLength(1);
    expect(mailer.outbox[0]!.text).toContain('Ada’s laptop');
    expect(mailer.outbox[0]!.text).toContain(`${APP_URL}/settings/local-agents`);
  });

  it('sends nothing for a device already revoked or gone', async () => {
    device = { ...device!, revokedAt: new Date() };
    await expect(consumer.handle(event(), tx)).resolves.toBeUndefined();

    device = undefined;
    await expect(consumer.handle(event(), tx)).resolves.toBeUndefined();
  });
});
