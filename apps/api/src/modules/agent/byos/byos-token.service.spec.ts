import { Logger } from '@nestjs/common';
import { schema } from '@repo/db';
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  inject,
  it,
  vi,
} from 'vitest';

import {
  type FakeByosProvider,
  startFakeByosProvider,
} from '../../../../test/support/fake-byos-provider';
import { NotFoundError } from '../../../common/errors/domain-error';
import { AccountSecretService } from '../../../common/crypto/account-secret';
import { plaintext } from '../../../common/crypto/branded';
import { EnvKekProvider } from '../../../common/crypto/env-kek.provider';
import { SystemClock } from '../../../common/clock/system-clock';
import type { ForgeDatabase } from '../../../database/database.types';
import { TenantContext } from '../../../database/tenant-context';
import { TenantTransactionRunner } from '../../../database/tenant-transaction';
import { OutboxWriter } from '../../outbox/outbox-writer';
import type { KeyCheck } from '../llm-provider.port';
import { ProviderError } from '../provider-error';
import type { ByosClientConfig } from './byos-config';
import type { ByosProviders } from './byos-providers';
import { ByosTokenService } from './byos-token.service';
import { GenericOAuthSubscription } from './generic-oauth.subscription';
import { LinkedAccountRepository } from './linked-account.repository';
import { grantPurpose } from './linked-account.service';
import {
  type ByosGrant,
  type SubscriptionClient,
  SubscriptionFailure,
} from './subscription-client.port';

const postgres = inject('postgresReachable');
const REDIRECT = 'http://app.local/account/connected-accounts/openai/callback';

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

/**
 * Spec 032 T031 (US4, SC-007): the token service against real Postgres, the real account-secret
 * seal and the provider double through the generic client. The double rotates refresh tokens and
 * revokes a family on reuse, so a second refresh with a spent token would show as `needs_reauth`.
 */
describe.skipIf(!postgres)('ByosTokenService', () => {
  let pool: pg.Pool;
  let holderPool: pg.Pool;
  let database: ForgeDatabase;
  let secrets: AccountSecretService;
  let fake: FakeByosProvider;
  let config: ByosClientConfig;
  let lines: string[];
  let userId: string;
  const userIds: string[] = [];

  const providers = (): Pick<ByosProviders, 'endpoint'> => ({
    endpoint: () => ({ baseURL: fake.apiBaseURL, headers: {} }),
  });

  /** The adapters' bearer check, as the double answers it: 200 ok, 401 rejected, else unreachable. */
  let bearer: (apiKey: string) => Promise<KeyCheck>;
  const doubleBearer = async (apiKey: string): Promise<KeyCheck> => {
    const response = await fetch(`${fake.apiBaseURL}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (response.status === 200) return 'ok';
    return response.status === 401 ? 'rejected' : 'unreachable';
  };

  function service(client: SubscriptionClient, on: pg.Pool = pool): ByosTokenService {
    const db = drizzle(on, { schema });
    const runner = new TenantTransactionRunner(db, new TenantContext());
    const clock = new SystemClock();
    return new ByosTokenService(
      providers() as ByosProviders,
      { openai: client },
      new LinkedAccountRepository(runner),
      secrets,
      runner,
      new OutboxWriter(clock),
      clock,
      {
        anthropic: { verifyBearer: (credential) => bearer(credential.apiKey) },
        openai: { verifyBearer: (credential) => bearer(credential.apiKey) },
      },
    );
  }

  const client = () => new GenericOAuthSubscription(config);

  async function link(options: { lifetime: number; sealWith?: AccountSecretService }) {
    fake.setAccessLifetime(options.lifetime);
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const oauth = client();
    const begun = await oauth.begin({
      codeChallenge: challenge,
      redirectUri: REDIRECT,
      state: 's',
    });
    if (begun.kind !== 'redirect') throw new Error('expected a redirect');
    const back = await fetch(begun.url, { redirect: 'manual' });
    const code = new URL(back.headers.get('location')!).searchParams.get('code')!;
    const result = await oauth.exchange({ code, redirectUri: REDIRECT, state: 's', verifier });
    if ('pending' in result) throw new Error('expected a grant');
    const sealed = await (options.sealWith ?? secrets).seal(
      { purpose: grantPurpose('openai'), userId },
      plaintext(JSON.stringify(result.grant satisfies ByosGrant)),
    );
    const runner = new TenantTransactionRunner(database, new TenantContext());
    const past = new Date(Date.now() - 86_400_000);
    await runner.runInUserTransaction(userId, (tx) =>
      new LinkedAccountRepository(runner).upsert(tx, {
        accessExpiresAt: new Date(result.grant.accessExpiresAt),
        accountLabel: result.accountLabel,
        grantSealed: sealed,
        lastCheckedAt: past,
        linkedAt: past,
        provider: 'openai',
        userId,
      }),
    );
    fake.setAccessLifetime(3600);
    return result;
  }

  async function row() {
    const [found] = await database
      .select()
      .from(schema.linkedAccounts)
      .where(
        and(eq(schema.linkedAccounts.userId, userId), eq(schema.linkedAccounts.provider, 'openai')),
      );
    return found!;
  }

  async function mails(aggregateId: string) {
    return database
      .select()
      .from(schema.outbox)
      .where(and(eq(schema.outbox.type, 'mail.byos'), eq(schema.outbox.aggregateId, aggregateId)));
  }

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 12 });
    holderPool = new pg.Pool({
      application_name: 't031-holder',
      connectionString: process.env.DATABASE_URL,
      max: 1,
    });
    // The dead-holder case terminates this pool's backend on purpose.
    holderPool.on('error', () => undefined);
    holderPool.on('connect', (connection) => connection.on('error', () => undefined));
    database = drizzle(pool, { schema });
    secrets = new AccountSecretService(
      new EnvKekProvider(process.env.KEK_ENV_MASTER_KEY!, 'local'),
    );
  });

  afterAll(async () => {
    if (userIds.length > 0) {
      await database.delete(schema.users).where(inArray(schema.users.id, userIds));
    }
    await holderPool.end().catch(() => undefined);
    await pool.end();
  });

  beforeEach(async () => {
    fake = startFakeByosProvider();
    await fake.start();
    config = {
      apiBaseUrl: fake.apiBaseURL,
      authorizeUrl: fake.authorizeURL,
      clientId: fake.clientId,
      revokeUrl: fake.revokeURL,
      scopes: ['user:inference'],
      tokenUrl: fake.tokenURL,
    };
    const [user] = await database
      .insert(schema.users)
      .values({ email: `t031-${randomUUID()}@example.test`, emailVerifiedAt: new Date() })
      .returning({ id: schema.users.id });
    userId = user!.id;
    userIds.push(userId);
    bearer = doubleBearer;
    lines = [];
    for (const method of ['log', 'warn', 'error'] as const) {
      vi.spyOn(Logger.prototype, method).mockImplementation((message: unknown) => {
        lines.push(String(message));
      });
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fake.close();
  });

  it('answers a fresh token without refreshing', async () => {
    const linked = await link({ lifetime: 3600 });

    const credential = await service(client()).current(userId, 'openai');

    expect(fake.refreshCount()).toBe(0);
    expect(credential).toEqual({
      accountLabel: linked.accountLabel,
      apiKey: linked.grant.accessToken,
      endpoint: { baseURL: fake.apiBaseURL, headers: {} },
      expiresAt: new Date(linked.grant.accessExpiresAt),
      mode: 'BYOS',
      provider: 'openai',
    });
    expect(lines).toEqual([]);
  });

  it('refreshes an expired token once, seals the new grant and advances the row', async () => {
    const linked = await link({ lifetime: 60 });
    const before = await row();

    const credential = await service(client()).current(userId, 'openai');

    expect(fake.refreshCount()).toBe(1);
    expect(credential.apiKey).not.toBe(linked.grant.accessToken);
    const after = await row();
    expect(after.grantSealed.equals(before.grantSealed)).toBe(false);
    expect(after.accessExpiresAt.getTime()).toBeGreaterThan(before.accessExpiresAt.getTime());
    expect(after.lastCheckedAt.getTime()).toBeGreaterThan(before.lastCheckedAt.getTime());
    expect(after.accessExpiresAt).toEqual(credential.expiresAt);
    expect(lines).toEqual([`BYOS refreshed [user=${userId} provider=openai]`]);
    expect(lines.join('\n')).not.toContain(credential.apiKey);
  });

  it('ten concurrent callers on an expired token cost one refresh (SC-007)', async () => {
    for (let repetition = 0; repetition < 20; repetition += 1) {
      await link({ lifetime: 60 });
      const start = fake.refreshCount();
      const tokens = service(client());

      const answers = await Promise.all(
        Array.from({ length: 10 }, () => tokens.current(userId, 'openai')),
      );

      expect(fake.refreshCount() - start).toBe(1);
      expect(new Set(answers.map((answer) => answer.apiKey)).size).toBe(1);
      expect((await row()).health).toBe('healthy');
    }
  });

  it('force: true refreshes a fresh token', async () => {
    const linked = await link({ lifetime: 3600 });

    const credential = await service(client()).current(userId, 'openai', { force: true });

    expect(fake.refreshCount()).toBe(1);
    expect(credential.apiKey).not.toBe(linked.grant.accessToken);
  });

  it('a revoked grant moves to needs_reauth once, with one mail, for every waiter', async () => {
    const linked = await link({ lifetime: 60 });
    const before = await row();
    fake.revoke(linked.accountLabel);
    const tokens = service(client());

    const failures = await Promise.all(
      Array.from({ length: 5 }, () => caught(tokens.current(userId, 'openai'))),
    );

    for (const failure of failures) {
      expect(failure).toBeInstanceOf(SubscriptionFailure);
      expect((failure as SubscriptionFailure).kind).toBe('rejected');
    }
    expect(fake.refreshCount()).toBe(0);
    const after = await row();
    expect(after.health).toBe('needs_reauth');
    expect(after.healthChanges).toBe(before.healthChanges + 1);
    expect(lines).toEqual([
      `BYOS health [user=${userId} provider=openai from=healthy to=needs_reauth]`,
    ]);
    const mailed = await mails(after.id);
    expect(mailed).toHaveLength(1);
    expect(mailed[0]!.payload).toEqual({
      kind: 'needs-reauth',
      provider: 'openai',
      recipientUserId: userId,
    });
  });

  it('every waiter behind a rejected refresh sees the same failure with one refresh', async () => {
    await link({ lifetime: 60 });
    // The first refresh rotates; the double is then told to refuse the family.
    const inner = client();
    let calls = 0;
    const refusing: SubscriptionClient = {
      ...inner,
      begin: (input) => inner.begin(input),
      exchange: (input) => inner.exchange(input),
      refresh: async (token) => {
        calls += 1;
        await inner.refresh(token);
        throw new SubscriptionFailure('rejected');
      },
    };
    const tokens = service(refusing);

    const failures = await Promise.all(
      Array.from({ length: 10 }, () => caught(tokens.current(userId, 'openai'))),
    );

    expect(calls).toBe(1);
    expect(fake.refreshCount()).toBe(1);
    expect(failures.every((failure) => failure instanceof SubscriptionFailure)).toBe(true);
    expect((await row()).health).toBe('needs_reauth');
    expect(await mails((await row()).id)).toHaveLength(1);
  });

  it('an unreachable provider answers ProviderError(unavailable) and leaves health alone', async () => {
    await link({ lifetime: 60 });
    const before = await row();
    const unreachable = new GenericOAuthSubscription(
      { ...config, tokenUrl: 'http://127.0.0.1:1/token' },
      { timeoutMs: 2_000 },
    );

    const failure = await caught(service(unreachable).current(userId, 'openai'));

    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).class).toBe('unavailable');
    const after = await row();
    expect(after.health).toBe('healthy');
    expect(after.healthChanges).toBe(before.healthChanges);
    expect(after.grantSealed.equals(before.grantSealed)).toBe(true);
  });

  it('a dead holder releases the row and the next caller refreshes with the stored token', async () => {
    await link({ lifetime: 60 });
    const inner = client();
    let release!: (error: Error) => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => (entered = resolve));
    const hanging: SubscriptionClient = {
      ...inner,
      begin: (input) => inner.begin(input),
      exchange: (input) => inner.exchange(input),
      // Never reaches the double: the holder dies "waiting on the provider".
      refresh: () => {
        entered();
        return new Promise((_, reject) => (release = reject));
      },
    };

    const holder = caught(service(hanging, holderPool).current(userId, 'openai'));
    await waiting;
    await pool.query(
      `select pg_terminate_backend(pid) from pg_stat_activity where application_name = 't031-holder'`,
    );
    release(new Error('holder connection gone'));
    expect(await holder).toBeInstanceOf(Error);

    const credential = await service(client()).current(userId, 'openai');

    expect(fake.refreshCount()).toBe(1);
    expect((await row()).health).toBe('healthy');
    // The refreshed token works: the double did not see a reused (rotated) refresh token.
    const response = await fetch(`${fake.apiBaseURL}/models`, {
      headers: { authorization: `Bearer ${credential.apiKey}` },
    });
    expect(response.status).toBe(200);
  });

  it('a grant sealed under an unknown KEK reads needs_reauth', async () => {
    const stranger = new AccountSecretService(
      new EnvKekProvider(randomBytes(32).toString('base64'), 'local'),
    );
    await link({ lifetime: 3600, sealWith: stranger });

    const failure = await caught(service(client()).current(userId, 'openai'));

    expect(failure).toBeInstanceOf(SubscriptionFailure);
    expect((failure as SubscriptionFailure).kind).toBe('rejected');
    expect(fake.refreshCount()).toBe(0);
    const after = await row();
    expect(after.health).toBe('needs_reauth');
    expect(await mails(after.id)).toHaveLength(1);
  });

  describe('verify (T043)', () => {
    it('a good account reads healthy and last_checked_at advances; nothing is logged', async () => {
      await link({ lifetime: 3600 });
      const before = await row();

      const answer = await service(client()).verify(userId, 'openai');

      expect(answer.health).toBe('healthy');
      const after = await row();
      expect(after.health).toBe('healthy');
      expect(after.lastCheckedAt.getTime()).toBeGreaterThan(before.lastCheckedAt.getTime());
      expect(answer.lastCheckedAt).toBe(after.lastCheckedAt.toISOString());
      expect(fake.refreshCount()).toBe(0);
      expect(lines).toEqual([]);
    });

    it('a revoked account reads needs_reauth with one mail; a second verify sends none', async () => {
      const linked = await link({ lifetime: 3600 });
      fake.revoke(linked.accountLabel);
      const tokens = service(client());

      expect((await tokens.verify(userId, 'openai')).health).toBe('needs_reauth');
      expect((await tokens.verify(userId, 'openai')).health).toBe('needs_reauth');

      const after = await row();
      expect(after.health).toBe('needs_reauth');
      expect(await mails(after.id)).toHaveLength(1);
      expect(lines).toEqual([
        `BYOS health [user=${userId} provider=openai from=healthy to=needs_reauth]`,
      ]);
    });

    it('an expiring token is refreshed before the check', async () => {
      await link({ lifetime: 60 });

      expect((await service(client()).verify(userId, 'openai')).health).toBe('healthy');
      expect(fake.refreshCount()).toBe(1);
    });

    it('a needs_reauth account that checks ok again reads healthy, logged as the transition', async () => {
      await link({ lifetime: 3600 });
      await database
        .update(schema.linkedAccounts)
        .set({ health: 'needs_reauth' })
        .where(eq(schema.linkedAccounts.userId, userId));

      expect((await service(client()).verify(userId, 'openai')).health).toBe('healthy');
      expect((await row()).health).toBe('healthy');
      expect(lines).toEqual([
        `BYOS health [user=${userId} provider=openai from=needs_reauth to=healthy]`,
      ]);
      expect(await mails((await row()).id)).toHaveLength(0);
    });

    it('an unreachable check changes nothing but last_checked_at', async () => {
      await link({ lifetime: 3600 });
      const before = await row();
      bearer = () => Promise.resolve('unreachable');

      expect((await service(client()).verify(userId, 'openai')).health).toBe('healthy');
      const after = await row();
      expect(after.health).toBe('healthy');
      expect(after.healthChanges).toBe(before.healthChanges);
      expect(await mails(after.id)).toHaveLength(0);
    });

    it('no linked account is not-found', async () => {
      expect(await caught(service(client()).verify(userId, 'openai'))).toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  it('markRejected (T041) moves a healthy account once, with one mail', async () => {
    await link({ lifetime: 3600 });
    const tokens = service(client());

    await tokens.markRejected(userId, 'openai');
    await tokens.markRejected(userId, 'openai');

    expect((await row()).health).toBe('needs_reauth');
    expect(await mails((await row()).id)).toHaveLength(1);
  });

  it('setLimitedUntil and clearLimit (T046) touch limited_until and never health', async () => {
    await link({ lifetime: 3600 });
    const tokens = service(client());
    const at = new Date('2030-01-01T09:22:00.000Z');

    await tokens.setLimitedUntil(userId, 'openai', at);
    expect(await row()).toMatchObject({ health: 'healthy', limitedUntil: at });
    await tokens.clearLimit(userId, 'openai');
    expect(await row()).toMatchObject({ health: 'healthy', limitedUntil: null });
  });
});
