import { ConfigModule } from '@nestjs/config';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { schema } from '@repo/db';
import { and, asc, eq, gt } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import { ClockModule } from '../../../common/clock/clock.module';
import { FakeClock } from '../../../common/clock/fake-clock';
import { revealPlaintext } from '../../../common/crypto/branded';
import { CryptoModule } from '../../../common/crypto/crypto.module';
import { DekService } from '../../../common/crypto/dek.service';
import { SecretDecryptionError } from '../../../common/crypto/envelope';
import { RunProfilesModule } from '../../../common/run-profiles/run-profiles.module';
import { validateEnvironment } from '../../../config/environment';
import { APP_DATABASE } from '../../../database/database.constants';
import { DatabaseModule } from '../../../database/database.module';
import type { ForgeDatabase, TenantTransaction } from '../../../database/database.types';
import { TenantTransactionRunner } from '../../../database/tenant-transaction';
import { AuditService } from '../../audit/audit.service';
import type { KeyCheck, KeyVerifier } from '../llm-provider.port';
import { purposeFor } from './key-shapes';
import { ProviderKeyRepository } from './provider-key.repository';
import { type KeyVerifiers, ProviderKeyService } from './provider-key.service';

const postgres = inject('postgresReachable');

if (!postgres) {
  console.warn('SKIPPING provider-key.service.spec.ts: Postgres is not reachable');
}

const FROZEN = new Date('2026-09-21T09:00:00.000Z');
const ANTHROPIC_KEY = `sk-ant-api03-${'a'.repeat(40)}wxyz`;
const ANTHROPIC_KEY_2 = `sk-ant-api03-${'b'.repeat(40)}1234`;
const OPENAI_KEY = `sk-proj-${'c'.repeat(40)}5678`;

/**
 * Spec 020 US1 through a real `DekService` against Postgres, the two adapters replaced by verifier
 * doubles: the seal/open round trip, the replace that never leaves zero or two keys, the AAD probe
 * (SC-003) and the list that carries the two §05 derivatives and nothing else (SC-002).
 */
describe('ProviderKeyService', () => {
  describe.skipIf(!postgres)('against Postgres and a real DekService', () => {
    let moduleRef: TestingModule;
    let database: ForgeDatabase;
    let transactions: TenantTransactionRunner;
    let dek: DekService;
    let service: ProviderKeyService;
    let clock: FakeClock;
    let verify: ReturnType<typeof vi.fn<KeyVerifier['verify']>>;
    let orgId: string;
    let otherOrgId: string;
    let userId: string;
    let auditSince = new Date();

    function inTenant<T>(org: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
      return transactions.runInTenantTransaction(org, fn);
    }

    function put(provider: 'anthropic' | 'openai', apiKey: string) {
      return inTenant(orgId, (tx) => service.put(tx, orgId, userId, provider, apiKey));
    }

    function secretsOf(org: string) {
      return inTenant(org, (tx) =>
        tx.select().from(schema.secrets).where(eq(schema.secrets.orgId, org)),
      );
    }

    function keysOf(org: string) {
      return inTenant(org, (tx) =>
        tx.select().from(schema.providerKeys).where(eq(schema.providerKeys.orgId, org)),
      );
    }

    /** The trail is append-only, so each test reads only what it wrote. */
    function auditRows(org: string) {
      return inTenant(org, (tx) =>
        tx
          .select({ action: schema.auditLog.action, metadata: schema.auditLog.metadata })
          .from(schema.auditLog)
          .where(and(eq(schema.auditLog.orgId, org), gt(schema.auditLog.createdAt, auditSince)))
          .orderBy(asc(schema.auditLog.createdAt)),
      );
    }

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
      dek = moduleRef.get(DekService, { strict: false });
      clock = new FakeClock(FROZEN);
      verify = vi.fn<KeyVerifier['verify']>();
      const verifiers: KeyVerifiers = { anthropic: { verify }, openai: { verify } };
      service = new ProviderKeyService(
        new ProviderKeyRepository(),
        dek,
        new AuditService(clock),
        clock,
        verifiers,
      );

      const [user] = await database
        .insert(schema.users)
        .values({ email: `020s-${randomUUID()}@example.test`, passwordHash: 'x' })
        .returning({ id: schema.users.id });
      userId = user!.id;

      const suffix = randomUUID().slice(0, 8);
      const orgs = await database
        .insert(schema.orgs)
        .values([
          { name: 'BYOK fixture', slug: `020s-${suffix}` },
          { name: 'Other tenant', slug: `020o-${suffix}` },
        ])
        .returning({ id: schema.orgs.id });
      orgId = orgs[0]!.id;
      otherOrgId = orgs[1]!.id;
    }, 60_000);

    afterAll(async () => {
      if (!postgres) return;
      await database.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
      await database.delete(schema.orgs).where(eq(schema.orgs.id, otherOrgId));
      await database.delete(schema.users).where(eq(schema.users.id, userId));
      await moduleRef?.close();
    });

    beforeEach(async () => {
      verify.mockReset();
      verify.mockResolvedValue('ok' satisfies KeyCheck);
      for (const org of [orgId, otherOrgId]) {
        await inTenant(org, async (tx) => {
          await tx.delete(schema.providerKeys).where(eq(schema.providerKeys.orgId, org));
          await tx.delete(schema.secrets).where(eq(schema.secrets.orgId, org));
        });
      }
      auditSince = new Date();
    });

    it('put refuses a wrong-shape key as validation-failed / wrong-shape before any provider call (FR-008)', async () => {
      for (const [provider, key] of [
        ['anthropic', 'not-a-key-but-long-enough-to-pass'],
        ['anthropic', OPENAI_KEY],
        ['openai', 'https://example.test/not-a-key-at-all'],
      ] as const) {
        await expect(put(provider, key)).rejects.toMatchObject({
          extensions: { reason: 'wrong-shape' },
          type: 'validation-failed',
        });
      }
      expect(verify).not.toHaveBeenCalled();
      await expect(keysOf(orgId)).resolves.toEqual([]);
    });

    it('put on a rejected key is validation-failed / key-rejected: no row, no secret, no audit', async () => {
      verify.mockResolvedValue('rejected');

      await expect(put('anthropic', ANTHROPIC_KEY)).rejects.toMatchObject({
        extensions: { reason: 'key-rejected' },
        type: 'validation-failed',
      });
      expect(verify).toHaveBeenCalledWith(ANTHROPIC_KEY);
      await expect(keysOf(orgId)).resolves.toEqual([]);
      await expect(secretsOf(orgId)).resolves.toEqual([]);
      await expect(auditRows(orgId)).resolves.toEqual([]);
    });

    it('put on an unreachable provider is service-unavailable / could-not-verify with Retry-After 30, nothing stored', async () => {
      verify.mockResolvedValue('unreachable');

      await expect(put('openai', OPENAI_KEY)).rejects.toMatchObject({
        extensions: { reason: 'could-not-verify', retryAfter: 30 },
        retryAfterSeconds: 30,
        type: 'service-unavailable',
      });
      await expect(keysOf(orgId)).resolves.toEqual([]);
      await expect(secretsOf(orgId)).resolves.toEqual([]);
    });

    it('put on a verified key seals it under byok:anthropic:api-key, stamps lastVerifiedAt from the clock, audits provider-key.added without the key', async () => {
      const record = await put('anthropic', ANTHROPIC_KEY);

      expect(record).toMatchObject({
        addedBy: userId,
        health: 'healthy',
        lastFour: 'wxyz',
        lastVerifiedAt: FROZEN,
        orgId,
        provider: 'anthropic',
      });

      const keys = await keysOf(orgId);
      const secrets = await secretsOf(orgId);

      expect(keys).toHaveLength(1);
      expect(secrets).toHaveLength(1);
      expect(secrets[0]).toMatchObject({
        alg: 'AES-256-GCM',
        id: keys[0]!.secretId,
        purpose: 'byok:anthropic:api-key',
      });
      expect(record.fingerprint).toBe(secrets[0]!.fingerprint);

      const opened = await inTenant(orgId, (tx) =>
        dek.openSecret(tx, orgId, purposeFor('anthropic'), secrets[0]!),
      );
      expect(revealPlaintext(opened).toString('utf8')).toBe(ANTHROPIC_KEY);

      const audit = await auditRows(orgId);
      expect(audit).toEqual([
        {
          action: 'provider-key.added',
          metadata: { fingerprint: record.fingerprint, lastFour: 'wxyz', provider: 'anthropic' },
        },
      ]);
      expect(JSON.stringify(audit)).not.toContain(ANTHROPIC_KEY);
    });

    it('a second put for the same provider replaces: one row, one secret, the old secret gone, provider-key.replaced with both fingerprints', async () => {
      const first = await put('anthropic', ANTHROPIC_KEY);
      const second = await put('anthropic', ANTHROPIC_KEY_2);

      expect(second.id).not.toBe(first.id);
      expect(second.lastFour).toBe('1234');

      const keys = await keysOf(orgId);
      const secrets = await secretsOf(orgId);

      expect(keys).toHaveLength(1);
      expect(keys[0]!.id).toBe(second.id);
      expect(secrets).toHaveLength(1);
      expect(secrets[0]!.id).toBe(second.secretId);
      expect(secrets[0]!.id).not.toBe(first.secretId);

      const audit = await auditRows(orgId);
      expect(audit.map((row) => row.action)).toEqual([
        'provider-key.added',
        'provider-key.replaced',
      ]);
      expect(audit[1]!.metadata).toEqual({
        fingerprint: second.fingerprint,
        lastFour: '1234',
        previousFingerprint: first.fingerprint,
        provider: 'anthropic',
      });
    });

    it('put for the other provider is a second row; list answers both with last four and fingerprint and never the key (SC-002)', async () => {
      await put('anthropic', ANTHROPIC_KEY);
      await put('openai', OPENAI_KEY);

      const listed = await inTenant(orgId, (tx) => service.list(tx, orgId));

      expect(listed.map((row) => row.provider)).toEqual(['anthropic', 'openai']);
      expect(listed.map((row) => row.lastFour)).toEqual(['wxyz', '5678']);
      expect(listed.every((row) => /^sha256:[0-9a-f]+$/.test(row.fingerprint))).toBe(true);
      expect(listed[0]!.addedByName).toContain('@example.test');

      const json = JSON.stringify(listed);
      expect(json).not.toContain(ANTHROPIC_KEY);
      expect(json).not.toContain(OPENAI_KEY);
      expect(json).not.toContain('ciphertext');
    });

    it('remove deletes the row and its secret and audits provider-key.removed; a second remove is not-found', async () => {
      const record = await put('anthropic', ANTHROPIC_KEY);

      await inTenant(orgId, (tx) => service.remove(tx, orgId, userId, 'anthropic'));

      await expect(keysOf(orgId)).resolves.toEqual([]);
      await expect(secretsOf(orgId)).resolves.toEqual([]);

      const audit = await auditRows(orgId);
      expect(audit.map((row) => row.action)).toEqual([
        'provider-key.added',
        'provider-key.removed',
      ]);
      expect(audit[1]!.metadata).toEqual({
        fingerprint: record.fingerprint,
        provider: 'anthropic',
      });

      await expect(
        inTenant(orgId, (tx) => service.remove(tx, orgId, userId, 'anthropic')),
      ).rejects.toMatchObject({ type: 'not-found' });
    });

    /** SC-003: the org id and the purpose are both bound into the seal. */
    it('refuses the ciphertext copied into a second org, and relabelled to another provider (AAD probe)', async () => {
      await put('anthropic', ANTHROPIC_KEY);

      const [sealed] = await secretsOf(orgId);
      const copied = await inTenant(otherOrgId, async (tx) => {
        const { dekId } = await dek.ensureDek(tx, otherOrgId);
        const [row] = await tx
          .insert(schema.secrets)
          .values({ ...sealed!, dekId, id: undefined, orgId: otherOrgId })
          .returning();

        return row!;
      });

      await expect(
        inTenant(otherOrgId, (tx) =>
          dek.openSecret(tx, otherOrgId, purposeFor('anthropic'), copied),
        ),
      ).rejects.toBeInstanceOf(SecretDecryptionError);
      await expect(
        inTenant(orgId, (tx) => dek.openSecret(tx, orgId, purposeFor('openai'), sealed!)),
      ).rejects.toBeInstanceOf(SecretDecryptionError);
      await expect(
        inTenant(orgId, (tx) => dek.openSecret(tx, orgId, purposeFor('anthropic'), sealed!)),
      ).resolves.toBeDefined();
    });

    describe('markRejected (US3)', () => {
      it('moves a healthy key to needs_reauth once, audited with cause run; a second call and a missing row are no-ops', async () => {
        const record = await put('anthropic', ANTHROPIC_KEY);
        const runId = randomUUID();

        await inTenant(orgId, (tx) => service.markRejected(tx, orgId, 'anthropic', { runId }));
        await inTenant(orgId, (tx) => service.markRejected(tx, orgId, 'anthropic', { runId }));
        await inTenant(orgId, (tx) => service.markRejected(tx, orgId, 'openai', { runId }));

        const [row] = await keysOf(orgId);
        expect(row!.health).toBe('needs_reauth');

        const audit = await auditRows(orgId);
        expect(audit.map((r) => r.action)).toEqual([
          'provider-key.added',
          'provider-key.health-changed',
        ]);
        expect(audit[1]!.metadata).toEqual({
          cause: 'run',
          from: 'healthy',
          provider: 'anthropic',
          runId,
          to: 'needs_reauth',
        });
        expect(record.health).toBe('healthy');
      });
    });

    describe('verify (US4)', () => {
      it.each([
        ['healthy', 'ok', 'healthy', 0],
        ['healthy', 'rejected', 'needs_reauth', 1],
        ['healthy', 'unreachable', 'healthy', 0],
        ['needs_reauth', 'ok', 'healthy', 1],
        ['needs_reauth', 'rejected', 'needs_reauth', 0],
        ['needs_reauth', 'unreachable', 'needs_reauth', 0],
      ] as const)(
        'from %s a check answering %s leaves the key %s (%i health-changed audit rows)',
        async (from, answer, to, audits) => {
          const stored = await put('anthropic', ANTHROPIC_KEY);
          if (from === 'needs_reauth') {
            await inTenant(orgId, (tx) =>
              service.markRejected(tx, orgId, 'anthropic', { runId: randomUUID() }),
            );
          }
          verify.mockReset();
          verify.mockResolvedValue(answer);
          clock.advance(60_000);

          const record = await inTenant(orgId, (tx) =>
            service.verify(tx, orgId, 'anthropic', userId),
          );

          // The sealed key was opened and handed to the verifier — the plaintext round trip.
          expect(verify).toHaveBeenCalledWith(ANTHROPIC_KEY);
          expect(record.health).toBe(to);
          expect(record.lastVerifiedAt?.getTime()).toBe(
            answer === 'ok' ? clock.now().getTime() : stored.lastVerifiedAt?.getTime(),
          );

          const changed = (await auditRows(orgId)).filter(
            (row) =>
              row.action === 'provider-key.health-changed' && row.metadata.cause === 'verify',
          );
          expect(changed).toHaveLength(audits);
          if (audits === 1) {
            expect(changed[0]!.metadata).toEqual({
              cause: 'verify',
              from,
              provider: 'anthropic',
              to,
            });
          }
        },
      );

      it('verify with no key for the provider is not-found', async () => {
        await expect(
          inTenant(orgId, (tx) => service.verify(tx, orgId, 'openai', null)),
        ).rejects.toMatchObject({ type: 'not-found' });
      });
    });
  });
});
