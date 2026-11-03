import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { linkedAccountListSchema, linkedAccountSchema } from '@repo/contracts';
import { schema } from '@repo/db';
import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Redis } from 'ioredis';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import { AccountSecretService } from '../../../common/crypto/account-secret';
import { EnvKekProvider } from '../../../common/crypto/env-kek.provider';
import { SecretDecryptionError } from '../../../common/crypto/envelope';
import { DomainError } from '../../../common/errors/domain-error';
import type { Environment } from '../../../config/environment';
import type { ForgeDatabase } from '../../../database/database.types';
import { TenantContext } from '../../../database/tenant-context';
import { TenantTransactionRunner } from '../../../database/tenant-transaction';
import type { CredentialContext, KeyCheck } from '../llm-provider.port';
import type { ByosProviders } from './byos-providers';
import { LinkStateStore } from './link-state.store';
import { LinkedAccountRepository } from './linked-account.repository';
import type { ByosTokenService } from './byos-token.service';
import { type BearerVerifiers, LinkedAccountService } from './linked-account.service';
import {
  type GrantResult,
  type SubscriptionClient,
  SubscriptionFailure,
} from './subscription-client.port';

const postgres = inject('postgresReachable');
const redisReachable = inject('redisReachable');
const APP_URL = 'https://app.forge.test';
const ENDPOINT = { baseURL: 'https://sub.openai.test/api', headers: {} };
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

let issued = 0;
function grant(label = 'ada@example.com'): GrantResult {
  issued += 1;
  return {
    accountLabel: label,
    grant: {
      accessExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      accessToken: `at-secret-${issued}-${randomUUID()}`,
      refreshToken: `rt-secret-${issued}-${randomUUID()}`,
      scopes: ['user:inference'],
    },
  };
}

/**
 * Spec 032 T023: the link service against real Postgres and Redis, the real account-secret seal
 * under the env KEK, and a stub subscription client. Every log line it writes is captured and
 * scanned for every token the stub issued (FR-024, FR-025).
 */
describe.skipIf(!postgres || !redisReachable)('LinkedAccountService', () => {
  let pool: pg.Pool;
  let database: ForgeDatabase;
  let redis: Redis;
  let secrets: AccountSecretService;
  let repository: LinkedAccountRepository;
  let service: LinkedAccountService;
  let client: {
    begin: ReturnType<typeof vi.fn>;
    exchange: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
    revoke: ReturnType<typeof vi.fn>;
  };
  let tokenVerify: ReturnType<typeof vi.fn<ByosTokenService['verify']>>;
  let verifyBearer: ReturnType<typeof vi.fn<(credential: CredentialContext) => Promise<KeyCheck>>>;
  const tokens: string[] = [];
  const lines: string[] = [];
  const userIds: string[] = [];
  const sessionA = sha256(randomUUID());
  let userA: string;
  let userB: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    database = drizzle(pool, { schema });
    redis = new Redis(process.env.REDIS_SESSION_URL!);
    secrets = new AccountSecretService(
      new EnvKekProvider(process.env.KEK_ENV_MASTER_KEY!, 'local'),
    );
    repository = new LinkedAccountRepository(
      new TenantTransactionRunner(database, new TenantContext()),
    );
    const users = await database
      .insert(schema.users)
      .values([
        { email: `t023-a-${randomUUID()}@example.test`, emailVerifiedAt: new Date() },
        { email: `t023-b-${randomUUID()}@example.test`, emailVerifiedAt: new Date() },
      ])
      .returning({ id: schema.users.id });
    userA = users[0]!.id;
    userB = users[1]!.id;
    userIds.push(userA, userB);
  });

  afterAll(async () => {
    if (userIds.length > 0) {
      await database.delete(schema.users).where(inArray(schema.users.id, userIds));
    }
    await pool.end();
    redis.disconnect();
  });

  beforeEach(async () => {
    lines.length = 0;
    await database
      .delete(schema.linkedAccounts)
      .where(inArray(schema.linkedAccounts.userId, userIds));
    for (const method of ['log', 'warn', 'error'] as const) {
      vi.spyOn(Logger.prototype, method).mockImplementation((message: unknown) => {
        lines.push(String(message));
      });
    }
    client = {
      begin: vi.fn(({ state, codeChallenge, redirectUri }) => {
        const url = new URL('https://auth.openai.test/authorize');
        url.searchParams.set('state', state as string);
        url.searchParams.set('code_challenge', codeChallenge as string);
        url.searchParams.set('code_challenge_method', 'S256');
        url.searchParams.set('redirect_uri', redirectUri as string);
        return Promise.resolve({ kind: 'redirect', url: url.toString() });
      }),
      exchange: vi.fn(() => {
        const result = grant();
        tokens.push(result.grant.accessToken, result.grant.refreshToken);
        return Promise.resolve(result);
      }),
      refresh: vi.fn(),
      revoke: vi.fn(() => Promise.resolve()),
    };
    verifyBearer = vi.fn(() => Promise.resolve<KeyCheck>('ok'));
    const providers = {
      endpoint: () => ENDPOINT,
      offered: () => Promise.resolve(true),
      offeredList: () => Promise.resolve(['openai']),
    } as unknown as ByosProviders;
    const config = {
      get: (key: string) => ({ APP_URL, OAUTH_STATE_TTL_SECONDS: 600 })[key],
    } as unknown as ConfigService<Environment, true>;
    tokenVerify = vi.fn();
    const tokenService = { verify: tokenVerify } as unknown as ByosTokenService;
    const verifiers: BearerVerifiers = { anthropic: { verifyBearer }, openai: { verifyBearer } };
    service = new LinkedAccountService(
      providers,
      { openai: client as unknown as SubscriptionClient },
      verifiers,
      new LinkStateStore(redis, config),
      repository,
      secrets,
      new TenantTransactionRunner(database, new TenantContext()),
      { now: () => new Date() },
      tokenService,
      config,
    );
  });

  /** Begins as `userId` in `sessionId` and answers the state from the redirect URL. */
  async function begin(userId = userA, sessionId = sessionA): Promise<string> {
    const started = await service.begin(userId, sessionId, 'openai');
    if (started.kind !== 'redirect') throw new Error('expected a redirect');
    return new URL(started.url).searchParams.get('state')!;
  }

  async function refusal(promise: Promise<unknown>): Promise<DomainError> {
    const error = await promise.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(DomainError);
    return error as DomainError;
  }

  async function rows(userId = userA) {
    return database
      .select()
      .from(schema.linkedAccounts)
      .where(eq(schema.linkedAccounts.userId, userId));
  }

  function expectNoTokenLogged(): void {
    for (const line of lines) {
      for (const token of tokens) expect(line).not.toContain(token);
      expect(line).not.toContain('the-code');
    }
  }

  it('begin returns a redirect with state, an S256 challenge and the callback URI', async () => {
    const started = await service.begin(userA, sessionA, 'openai');

    expect(started.kind).toBe('redirect');
    const url = new URL((started as { url: string }).url);
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe(
      `${APP_URL}/account/connected-accounts/openai/callback`,
    );
  });

  it('complete seals the grant per person, stores one row and logs one line with no token', async () => {
    const state = await begin();
    const account = await service.complete(userA, sessionA, 'openai', { code: 'the-code', state });

    expect(linkedAccountSchema.parse(account)).toEqual(account);
    expect(account).toMatchObject({ accountLabel: 'ada@example.com', health: 'healthy' });
    const [exchanged] = client.exchange.mock.calls[0] as [{ verifier: string; code: string }];
    expect(exchanged.code).toBe('the-code');
    expect(verifyBearer).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: ENDPOINT, mode: 'BYOS', provider: 'openai' }),
    );

    const stored = await rows();
    expect(stored).toHaveLength(1);
    const opened = await secrets.open(
      { purpose: 'byos:openai:grant', userId: userA },
      stored[0]!.grantSealed,
    );
    expect(JSON.parse(Buffer.from(opened as unknown as Buffer).toString('utf8'))).toMatchObject({
      accessToken: tokens.at(-2),
      refreshToken: tokens.at(-1),
    });
    expect(lines).toEqual([`BYOS linked [user=${userA} provider=openai]`]);
    expectNoTokenLogged();
  });

  it.each([
    ['access_denied', 'denied'],
    ['other', 'exchange-refused'],
  ] as const)(
    'complete with error %s refuses as %s without a provider call or a row',
    async (error, reason) => {
      const state = await begin();
      const refused = await refusal(service.complete(userA, sessionA, 'openai', { error, state }));

      expect(refused.type).toBe('oauth-exchange-failed');
      expect(refused.extensions).toEqual({ reason });
      expect(client.exchange).not.toHaveBeenCalled();
      expect(await rows()).toHaveLength(0);
    },
  );

  it.each([
    ['rejected', 'oauth-exchange-failed', 'exchange-refused'],
    ['unreachable', 'service-unavailable', 'provider-unavailable'],
  ] as const)('an exchange failure %s → %s / %s, nothing stored', async (kind, type, reason) => {
    client.exchange.mockRejectedValueOnce(new SubscriptionFailure(kind));
    const state = await begin();
    const refused = await refusal(
      service.complete(userA, sessionA, 'openai', { code: 'the-code', state }),
    );

    expect(refused.type).toBe(type);
    expect(refused.extensions).toMatchObject({ reason });
    expect(await rows()).toHaveLength(0);
  });

  it('a rejected verify of the new token is exchange-refused, nothing stored', async () => {
    verifyBearer.mockResolvedValueOnce('rejected');
    const state = await begin();
    const refused = await refusal(
      service.complete(userA, sessionA, 'openai', { code: 'the-code', state }),
    );

    expect(refused.extensions).toEqual({ reason: 'exchange-refused' });
    expect(await rows()).toHaveLength(0);
  });

  it('a bad, spent or other-session state is oauth-state-invalid', async () => {
    const state = await begin();
    const other = await refusal(
      service.complete(userA, sha256('other'), 'openai', { code: 'the-code', state }),
    );
    expect(other.type).toBe('oauth-state-invalid');
    const spent = await refusal(
      service.complete(userA, sessionA, 'openai', { code: 'the-code', state }),
    );
    expect(spent.type).toBe('oauth-state-invalid');
    expect(client.exchange).not.toHaveBeenCalled();
  });

  it('relink replaces the row in one step and revokes the old refresh token after commit', async () => {
    await service.complete(userA, sessionA, 'openai', { code: 'the-code', state: await begin() });
    const oldRefresh = tokens.at(-1)!;
    const [before] = await rows();
    lines.length = 0;

    await service.complete(userA, sessionA, 'openai', { code: 'the-code', state: await begin() });

    const after = await rows();
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before!.id);
    expect(after[0]!.grantSealed.equals(before!.grantSealed)).toBe(false);
    expect(client.revoke).toHaveBeenCalledTimes(1);
    expect(client.revoke).toHaveBeenCalledWith(oldRefresh);
    expect(lines).toEqual([`BYOS relinked [user=${userA} provider=openai]`]);
    expectNoTokenLogged();
  });

  it('unlink deletes, logs and revokes; a failing revoke still leaves it deleted', async () => {
    await service.complete(userA, sessionA, 'openai', { code: 'the-code', state: await begin() });
    const refresh = tokens.at(-1)!;
    lines.length = 0;
    client.revoke.mockRejectedValueOnce(new SubscriptionFailure('unreachable'));

    await service.unlink(userA, 'openai');

    expect(await rows()).toHaveLength(0);
    expect(client.revoke).toHaveBeenCalledWith(refresh);
    expect(lines).toEqual([
      `BYOS unlinked [user=${userA} provider=openai]`,
      `BYOS revoke failed [user=${userA} provider=openai class=unreachable]`,
    ]);
    expectNoTokenLogged();
    const missing = await refusal(service.unlink(userA, 'openai'));
    expect(missing.type).toBe('not-found');
  });

  it('the AAD probe: a grant moved to another person or relabelled to another provider does not open (SC-004)', async () => {
    await service.complete(userA, sessionA, 'openai', { code: 'the-code', state: await begin() });
    const [row] = await rows();

    await expect(
      secrets.open({ purpose: 'byos:openai:grant', userId: userB }, row!.grantSealed),
    ).rejects.toThrow(/unwrap/i);
    await expect(
      secrets.open({ purpose: 'byos:anthropic:grant', userId: userA }, row!.grantSealed),
    ).rejects.toBeInstanceOf(SecretDecryptionError);
  });

  it('list returns the offered providers and labels and dates only', async () => {
    await service.complete(userA, sessionA, 'openai', { code: 'the-code', state: await begin() });

    const listed = await service.list(userA);
    expect(linkedAccountListSchema.parse(listed)).toEqual(listed);
    expect(listed.offered).toEqual(['openai']);
    expect(Object.keys(listed.accounts[0]!).sort()).toEqual([
      'accountLabel',
      'health',
      'lastCheckedAt',
      'limitedUntil',
      'linkedAt',
      'provider',
    ]);
    expect((await service.list(userB)).accounts).toEqual([]);
  });

  it('a device flow begins with a user code and completes after pending polls', async () => {
    client.begin.mockResolvedValueOnce({
      deviceCode: 'device-secret',
      expiresAt: new Date(Date.now() + 600_000),
      intervalSeconds: 5,
      kind: 'device',
      userCode: 'WDJB-MJHT',
      verificationUri: 'https://auth.openai.test/activate',
    });
    const started = await service.begin(userA, sessionA, 'openai');
    expect(started).toMatchObject({ kind: 'device', userCode: 'WDJB-MJHT' });
    expect(JSON.stringify(started)).not.toContain('device-secret');
    const { state } = started as { state: string };

    client.exchange.mockResolvedValueOnce({ pending: true, retryAfterSeconds: 5 });
    expect(await service.complete(userA, sessionA, 'openai', { state })).toEqual({
      pending: true,
      retryAfterSeconds: 5,
    });
    const account = await service.complete(userA, sessionA, 'openai', { state });
    expect(account).toMatchObject({ accountLabel: 'ada@example.com' });
    expect(client.exchange).toHaveBeenLastCalledWith(
      expect.objectContaining({ deviceCode: 'device-secret' }),
    );
  });

  it('verify (T043) delegates to the token service for the caller and provider', async () => {
    const answer = {
      accountLabel: 'ada@example.com',
      health: 'healthy' as const,
      lastCheckedAt: '2026-09-24T10:00:00.000Z',
      limitedUntil: null,
      linkedAt: '2026-09-24T10:00:00.000Z',
      provider: 'openai' as const,
    };
    tokenVerify.mockResolvedValueOnce(answer);

    expect(await service.verify(userA, 'openai')).toBe(answer);
    expect(tokenVerify).toHaveBeenCalledWith(userA, 'openai');
  });
});
