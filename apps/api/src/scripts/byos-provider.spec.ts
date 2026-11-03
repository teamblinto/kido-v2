import type { ConfigService } from '@nestjs/config';
import { schema } from '@repo/db';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { ClockPort } from '../common/clock/clock.port';
import type { Environment } from '../config/environment';
import type { ForgeDatabase, TenantTransaction } from '../database/database.types';
import type { TenantTransactionRunner } from '../database/tenant-transaction';
import { ByosProviders } from '../modules/agent/byos/byos-providers';
import { LinkedAccountRepository } from '../modules/agent/byos/linked-account.repository';
import { OutboxWriter } from '../modules/outbox/outbox-writer';
import { UsageError, parseArgs, runCommand } from './byos-provider';

const postgres = inject('postgresReachable');

const OPENAI_SET: Record<string, string> = {
  BYOS_OPENAI_API_BASE_URL: 'https://sub.openai.test/api',
  BYOS_OPENAI_AUTHORIZE_URL: 'https://auth.openai.test/authorize',
  BYOS_OPENAI_CLIENT_ID: 'client',
  BYOS_OPENAI_SCOPES: 'openid email',
  BYOS_OPENAI_TOKEN_URL: 'https://auth.openai.test/token',
};

class Rollback extends Error {}

describe('parseArgs', () => {
  it('reads the two forms and refuses everything else as usage', () => {
    expect(parseArgs(['openai', 'in-force', '--record', 'docs/byos/openai.md'])).toEqual({
      provider: 'openai',
      record: 'docs/byos/openai.md',
      status: 'in-force',
    });
    expect(parseArgs(['anthropic', 'withdrawn'])).toEqual({
      provider: 'anthropic',
      status: 'withdrawn',
    });
    for (const argv of [
      [],
      ['gemini', 'withdrawn'],
      ['openai', 'in-force'],
      ['openai', 'withdrawn', '--record', 'x'],
      ['openai', 'paused'],
    ]) {
      expect(() => parseArgs(argv)).toThrow(UsageError);
    }
  });
});

/**
 * Spec 032 T018 against Postgres. `forge_app` may not DELETE from `byos_providers`, so each case
 * runs inside an outer transaction that is rolled back; the command's own transaction is a
 * savepoint in it.
 */
describe.skipIf(!postgres)('byos:provider', () => {
  let pool: pg.Pool;
  let database: ForgeDatabase;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    database = drizzle(pool, { schema });
  });

  afterAll(() => pool.end());

  async function within(check: (tx: TenantTransaction) => Promise<void>): Promise<void> {
    await database
      .transaction(async (tx) => {
        await check(tx);
        throw new Rollback();
      })
      .catch((error: unknown) => {
        if (!(error instanceof Rollback)) throw error;
      });
  }

  const SWITCHED_AT = new Date('2026-09-22T00:00:00.000Z');

  function deps(tx: TenantTransaction, lines: string[]) {
    const config = {
      get: (key: string) => OPENAI_SET[key],
    } as unknown as ConfigService<Environment, true>;
    const clock: ClockPort = { now: () => new Date() };
    return {
      accounts: new LinkedAccountRepository({} as TenantTransactionRunner),
      database: tx,
      now: () => SWITCHED_AT,
      out: (line: string) => lines.push(`out ${line}`),
      outbox: new OutboxWriter(clock),
      providers: new ByosProviders(tx, config),
    };
  }

  it('switches in force, then withdraws with one mail.byos per link', async () => {
    await within(async (tx) => {
      const lines: string[] = [];
      const inForce = await runCommand(deps(tx, lines), {
        provider: 'openai',
        record: 'docs/byos/openai.md',
        status: 'in-force',
      });
      expect(inForce).toBe(0);
      expect(await deps(tx, []).providers.offeredList()).toEqual(['openai']);
      const [row] = await tx
        .select()
        .from(schema.byosProviders)
        .where(eq(schema.byosProviders.provider, 'openai'));
      expect(row).toMatchObject({
        record: 'docs/byos/openai.md',
        signedOffAt: SWITCHED_AT,
        status: 'in_force',
        withdrawnAt: null,
      });

      const users = await tx
        .insert(schema.users)
        .values([
          { email: `t018-a-${randomUUID()}@example.test` },
          { email: `t018-b-${randomUUID()}@example.test` },
        ])
        .returning({ id: schema.users.id });
      const now = new Date();
      await tx.insert(schema.linkedAccounts).values(
        users.map((user) => ({
          accessExpiresAt: now,
          accountLabel: 'someone@example.com',
          grantSealed: Buffer.from('sealed'),
          health: 'healthy' as const,
          lastCheckedAt: now,
          linkedAt: now,
          provider: 'openai' as const,
          userId: user.id,
        })),
      );

      const withdrawn = await runCommand(deps(tx, lines), {
        provider: 'openai',
        status: 'withdrawn',
      });
      expect(withdrawn).toBe(0);
      expect(await deps(tx, []).providers.offeredList()).toEqual([]);

      const events = await tx
        .select({ payload: schema.outbox.payload })
        .from(schema.outbox)
        .where(and(eq(schema.outbox.type, 'mail.byos')));
      const mine = events.filter((event) =>
        users.some(
          (user) => (event.payload as { recipientUserId: string }).recipientUserId === user.id,
        ),
      );
      expect(mine).toHaveLength(2);
      expect(mine[0]!.payload).toMatchObject({ kind: 'provider-withdrawn', provider: 'openai' });
      expect(lines.at(-1)).toBe('out openai withdrawn (2 linked account(s) told)');
    });
  });

  it('never refuses a withdrawal, even of a provider never in force', async () => {
    await within(async (tx) => {
      const lines: string[] = [];
      expect(
        await runCommand(deps(tx, lines), { provider: 'anthropic', status: 'withdrawn' }),
      ).toBe(0);
      expect(lines).toEqual(['out anthropic withdrawn (0 linked account(s) told)']);
    });
  });
});
