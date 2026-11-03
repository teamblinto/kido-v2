import { ConfigModule } from '@nestjs/config';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { schema } from '@repo/db';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import { ClockModule } from '../../../common/clock/clock.module';
import { FakeClock } from '../../../common/clock/fake-clock';
import { CryptoModule } from '../../../common/crypto/crypto.module';
import { DekService } from '../../../common/crypto/dek.service';
import { RunProfilesModule } from '../../../common/run-profiles/run-profiles.module';
import { validateEnvironment } from '../../../config/environment';
import { APP_DATABASE } from '../../../database/database.constants';
import { DatabaseModule } from '../../../database/database.module';
import type { ForgeDatabase, TenantTransaction } from '../../../database/database.types';
import { TenantTransactionRunner } from '../../../database/tenant-transaction';
import { AuditService } from '../../audit/audit.service';
import type { Envelope } from '../../outbox/envelope';
import type { KeyCheck, KeyVerifier } from '../llm-provider.port';
import { ProviderKeyHealthConsumer, VERIFIED_WITHIN_MS } from './provider-key-health.consumer';
import { ProviderKeyRepository } from './provider-key.repository';
import { type KeyVerifiers, ProviderKeyService } from './provider-key.service';

const postgres = inject('postgresReachable');

if (!postgres) {
  console.warn('SKIPPING provider-key-health.consumer.spec.ts: Postgres is not reachable');
}

const FROZEN = new Date('2026-09-21T09:00:00.000Z');
const KEY_A = `sk-ant-api03-${'a'.repeat(40)}wxyz`;
const KEY_B = `sk-ant-api03-${'b'.repeat(40)}1234`;

function due(job: Envelope<'maintenance.due'>['payload']['job']): Envelope<'maintenance.due'> {
  const periodStart = FROZEN.toISOString();

  return {
    aggregate: 'maintenance',
    aggregateId: `${job}:${periodStart}`,
    eventId: randomUUID(),
    occurredAt: periodStart,
    orgId: null,
    payload: { job, periodStart },
    traceId: null,
    type: 'maintenance.due',
  };
}

/**
 * Spec 020 US4: the daily sweep driven by hand against Postgres with the adapters doubled — one
 * tenant transaction per organisation, a key verified within the hour left alone, one
 * organisation's failure not stopping the next, and every other maintenance job ignored.
 */
describe('ProviderKeyHealthConsumer', () => {
  describe.skipIf(!postgres)('against Postgres and a real DekService', () => {
    let moduleRef: TestingModule;
    let database: ForgeDatabase;
    let transactions: TenantTransactionRunner;
    let service: ProviderKeyService;
    let consumer: ProviderKeyHealthConsumer;
    let clock: FakeClock;
    let verify: ReturnType<typeof vi.fn<KeyVerifier['verify']>>;
    let orgA: string;
    let orgB: string;
    let userId: string;

    function inTenant<T>(org: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
      return transactions.runInTenantTransaction(org, fn);
    }

    function put(org: string, apiKey: string) {
      return inTenant(org, (tx) => service.put(tx, org, userId, 'anthropic', apiKey));
    }

    function keysOf(org: string) {
      return inTenant(org, (tx) =>
        tx.select().from(schema.providerKeys).where(eq(schema.providerKeys.orgId, org)),
      );
    }

    const tick = async (
      job: Envelope<'maintenance.due'>['payload']['job'] = 'byok.verify',
    ): Promise<void> => {
      const event = due(job);
      await consumer.effect(event, await consumer.handle(event));
    };

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            ignoreEnvFile: true,
            isGlobal: true,
            validate: validateEnvironment,
          }),
          ClockModule,
          RunProfilesModule,
          CryptoModule,
          DatabaseModule,
        ],
      }).compile();
      await moduleRef.init();

      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
      transactions = moduleRef.get(TenantTransactionRunner);
      clock = new FakeClock(FROZEN);
      verify = vi.fn<KeyVerifier['verify']>();
      const verifiers: KeyVerifiers = { anthropic: { verify }, openai: { verify } };
      service = new ProviderKeyService(
        new ProviderKeyRepository(),
        moduleRef.get(DekService, { strict: false }),
        new AuditService(clock),
        clock,
        verifiers,
      );
      consumer = new ProviderKeyHealthConsumer(database, transactions, service, clock);

      const [user] = await database
        .insert(schema.users)
        .values({ email: `020h-${randomUUID()}@example.test`, passwordHash: 'x' })
        .returning({ id: schema.users.id });
      userId = user!.id;

      const suffix = randomUUID().slice(0, 8);
      const orgs = await database
        .insert(schema.orgs)
        .values([
          { name: 'BYOK health A', slug: `020ha-${suffix}` },
          { name: 'BYOK health B', slug: `020hb-${suffix}` },
        ])
        .returning({ id: schema.orgs.id });
      orgA = orgs[0]!.id;
      orgB = orgs[1]!.id;
    }, 60_000);

    afterAll(async () => {
      if (!postgres) return;
      await database.delete(schema.orgs).where(eq(schema.orgs.id, orgA));
      await database.delete(schema.orgs).where(eq(schema.orgs.id, orgB));
      await database.delete(schema.users).where(eq(schema.users.id, userId));
      await moduleRef?.close();
    });

    beforeEach(async () => {
      vi.restoreAllMocks();
      clock.set(FROZEN);
      verify.mockReset();
      verify.mockResolvedValue('ok' satisfies KeyCheck);
      for (const org of [orgA, orgB]) {
        await inTenant(org, async (tx) => {
          await tx.delete(schema.providerKeys).where(eq(schema.providerKeys.orgId, org));
          await tx.delete(schema.secrets).where(eq(schema.secrets.orgId, org));
        });
      }
    });

    it('handles byok.verify and no other job', async () => {
      await expect(consumer.handle(due('byok.verify'))).resolves.toBe(true);
      await expect(consumer.handle(due('sandbox.sweep'))).resolves.toBe(false);
      await expect(consumer.handle(due('connector.verify'))).resolves.toBe(false);
      expect(consumer.jobId(due('byok.verify'))).toBe(
        `byok.verify.${String(FROZEN.getTime())}.health`,
      );
      expect(consumer).toMatchObject({ attempts: 3, profile: 'events', queue: 'byok.health' });
    });

    it('sweeps every organisation that holds a key, one verify each, and stamps lastVerifiedAt', async () => {
      await put(orgA, KEY_A);
      await put(orgB, KEY_B);
      verify.mockClear();
      clock.advance(VERIFIED_WITHIN_MS + 60_000);
      const later = clock.now();

      await tick();

      expect(verify.mock.calls.map(([key]) => key).sort()).toEqual([KEY_A, KEY_B]);
      await expect(keysOf(orgA)).resolves.toMatchObject([{ lastVerifiedAt: later }]);
      await expect(keysOf(orgB)).resolves.toMatchObject([{ lastVerifiedAt: later }]);
    });

    it('a key verified within the hour is left alone', async () => {
      await put(orgA, KEY_A);
      clock.advance(VERIFIED_WITHIN_MS + 60_000);
      await put(orgB, KEY_B);
      verify.mockClear();

      await tick();

      expect(verify.mock.calls.map(([key]) => key)).toEqual([KEY_A]);
    });

    it('one organisation throwing does not stop the next one being verified', async () => {
      await put(orgA, KEY_A);
      await put(orgB, KEY_B);
      verify.mockClear();
      clock.advance(VERIFIED_WITHIN_MS + 60_000);
      const real = service.verify.bind(service);
      vi.spyOn(service, 'verify').mockImplementation((tx, orgId, provider, actorId) =>
        orgId === orgA
          ? Promise.reject(new Error(`org ${orgId} is broken`))
          : real(tx, orgId, provider, actorId),
      );

      await tick();

      expect(verify.mock.calls.map(([key]) => key)).toEqual([KEY_B]);
      await expect(keysOf(orgB)).resolves.toMatchObject([{ lastVerifiedAt: clock.now() }]);
      await expect(keysOf(orgA)).resolves.toMatchObject([{ lastVerifiedAt: FROZEN }]);
    });

    it('a rejected key reads needs_reauth after one tick', async () => {
      await put(orgA, KEY_A);
      clock.advance(VERIFIED_WITHIN_MS + 60_000);
      verify.mockResolvedValue('rejected');

      await tick();

      await expect(keysOf(orgA)).resolves.toMatchObject([{ health: 'needs_reauth' }]);
    });

    it('ignores every other maintenance job', async () => {
      await put(orgA, KEY_A);
      verify.mockClear();
      clock.advance(VERIFIED_WITHIN_MS + 60_000);

      await tick('sandbox.sweep');

      expect(verify).not.toHaveBeenCalled();
    });
  });
});
