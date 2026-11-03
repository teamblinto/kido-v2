import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { OauthProvider } from '@repo/contracts';
import { schema } from '@repo/db';
import { eq, inArray } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import { ClockModule } from '../../../common/clock/clock.module';
import { CLOCK } from '../../../common/clock/clock.port';
import { FakeClock } from '../../../common/clock/fake-clock';
import { SESSION_REDIS } from '../../../common/redis/redis.constants';
import { RedisModule } from '../../../common/redis/redis.module';
import { validateEnvironment } from '../../../config/environment';
import { APP_DATABASE } from '../../../database/database.constants';
import { DatabaseModule } from '../../../database/database.module';
import type { ForgeDatabase } from '../../../database/database.types';
import { deviceFingerprintOf } from '../device-fingerprint';
import {
  OAUTH_PROVIDERS_PORT,
  type AuthorizationRequest,
  type ExchangeRequest,
  type OauthProviderPort,
  type ProviderIdentity,
} from './oauth-provider.port';
import {
  OauthAccountAlreadyLinkedError,
  OauthDeniedError,
  OauthEmailUnverifiedError,
  OauthProviderNotConfiguredError,
  OauthService,
  OauthStateError,
  oauthStateKey,
} from './oauth.service';
import { SessionService } from './session.service';

const STATE_TTL_SECONDS = 600;

vi.hoisted(() => {
  process.env.API_PREFIX = 'api';
  process.env.API_VERSION = '1';
  process.env.APP_URL = 'https://app.forge.test';
  process.env.OAUTH_STATE_TTL_SECONDS = '600';
  process.env.SESSION_TTL_SECONDS = '900';
});

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const START = '2026-08-16T10:00:00.000Z';
const DEVICE = deviceFingerprintOf({ ip: '203.0.113.9', userAgent: 'forge-spec/1.0' });

/**
 * A provider adapter whose answers the test dictates.
 *
 * The port is four members wide precisely so this is a class and not a mocking framework: the whole
 * of "what GitHub said" is one field, which keeps every test below about the *core's* rules rather
 * than about how a provider was persuaded to say something.
 */
class StubProvider implements OauthProviderPort {
  configured = true;
  identity: ProviderIdentity = {
    email: 'nobody@example.test',
    kind: 'verified',
    providerUserId: 'p-0',
  };
  lastExchange: ExchangeRequest | null = null;

  constructor(readonly provider: OauthProvider) {}

  authorizationUrl(request: AuthorizationRequest): string {
    const url = new URL(`https://provider.test/${this.provider}/authorize`);

    url.search = new URLSearchParams({
      code_challenge: request.codeChallenge,
      redirect_uri: request.redirectUri,
      state: request.state,
    }).toString();

    return url.toString();
  }

  async identify(request: ExchangeRequest): Promise<ProviderIdentity> {
    this.lastExchange = request;

    return Promise.resolve(this.identity);
  }

  isConfigured(): boolean {
    return this.configured;
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** The state out of an authorization URL the service just built. */
function stateOf(authorizationUrl: string): string {
  return new URL(authorizationUrl).searchParams.get('state') ?? expect.unreachable('no state');
}

describe('OauthService', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and Redis', () => {
    let service: OauthService;
    let sessions: SessionService;
    let database: ForgeDatabase;
    let store: Redis;
    let clock: FakeClock;
    let github: StubProvider;
    let google: StubProvider;
    const created: string[] = [];

    function mailbox(): string {
      return `t22-${randomUUID()}@example.test`;
    }

    async function seedUser(email: string, options: { verified?: boolean } = {}): Promise<string> {
      const [user] = await database
        .insert(schema.users)
        .values({
          email,
          emailVerifiedAt: options.verified === true ? new Date(START) : null,
          passwordHash: 'not-a-real-hash',
        })
        .returning({ id: schema.users.id });

      created.push(user!.id);

      return user!.id;
    }

    /** Start a flow and hand back the state it minted, ready to be spent. */
    async function startedState(provider: OauthProvider = 'github'): Promise<string> {
      return stateOf((await service.begin(provider)).authorizationUrl);
    }

    beforeAll(async () => {
      clock = new FakeClock(START);

      const moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            ignoreEnvFile: true,
            isGlobal: true,
            validate: validateEnvironment,
          }),
          ClockModule,
          DatabaseModule,
          RedisModule,
        ],
        providers: [
          OauthService,
          SessionService,
          {
            provide: OAUTH_PROVIDERS_PORT,
            useFactory: () => [new StubProvider('github'), new StubProvider('google')],
          },
        ],
      })
        .overrideProvider(CLOCK)
        .useValue(clock)
        .compile();

      await moduleRef.init();

      service = moduleRef.get(OauthService);
      sessions = moduleRef.get(SessionService);
      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
      store = moduleRef.get<Redis>(SESSION_REDIS);

      const adapters = moduleRef.get<StubProvider[]>(OAUTH_PROVIDERS_PORT);

      github = adapters.find((adapter) => adapter.provider === 'github')!;
      google = adapters.find((adapter) => adapter.provider === 'google')!;
    }, 60_000);

    beforeEach(() => {
      clock.set(START);
      github.configured = true;
      google.configured = true;
      github.identity = { email: mailbox(), kind: 'verified', providerUserId: `p-${randomUUID()}` };
    });

    afterAll(async () => {
      if (created.length > 0) {
        // `oauth_identities` cascades on the user, so one delete clears both tables.
        await database.delete(schema.users).where(inArray(schema.users.id, created));
      }
    }, 60_000);

    describe('begin', () => {
      it('refuses a provider this deployment has not configured', async () => {
        github.configured = false;

        await expect(service.begin('github')).rejects.toBeInstanceOf(
          OauthProviderNotConfiguredError,
        );
      });

      /**
       * A provider the vocabulary publishes but no adapter answers for — Google, until T23 — is
       * answered as unconfigured rather than as a 500. That is what makes T23 an additive change.
       */
      it('refuses a provider with no adapter at all the same way', async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [
            ConfigModule.forRoot({
              ignoreEnvFile: true,
              isGlobal: true,
              validate: validateEnvironment,
            }),
            ClockModule,
            DatabaseModule,
            RedisModule,
          ],
          providers: [
            OauthService,
            SessionService,
            { provide: OAUTH_PROVIDERS_PORT, useFactory: () => [] },
          ],
        }).compile();

        await expect(moduleRef.get(OauthService).begin('github')).rejects.toBeInstanceOf(
          OauthProviderNotConfiguredError,
        );

        await moduleRef.close();
      });

      it('stores the flow under the digest of the state, never under the state', async () => {
        const state = await startedState();

        await expect(store.exists(oauthStateKey(sha256(state)))).resolves.toBe(1);
        await expect(store.exists(oauthStateKey(state))).resolves.toBe(0);
      });

      it('gives the record the configured short TTL', async () => {
        const state = await startedState();
        const ttl = await store.ttl(oauthStateKey(sha256(state)));

        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(STATE_TTL_SECONDS);
      });

      /** 32 bytes of `randomBytes`: no two flows collide, and neither is guessable from the other. */
      it('mints a fresh unguessable state per flow', async () => {
        const states = await Promise.all([startedState(), startedState(), startedState()]);

        expect(new Set(states).size).toBe(3);

        for (const state of states) {
          expect(Buffer.from(state, 'base64url').length).toBe(32);
        }
      });

      /**
       * RFC 7636 §4.2. The challenge in the URL is the base64url SHA-256 of the verifier the record
       * holds — asserted by completing the flow and comparing what the adapter was handed, because
       * the verifier deliberately never leaves the service any other way.
       */
      it('sends the S256 challenge of the verifier it kept', async () => {
        const started = await service.begin('github');
        const challenge = new URL(started.authorizationUrl).searchParams.get('code_challenge');

        await service.complete('github', {
          code: 'the-code',
          device: DEVICE,
          state: stateOf(started.authorizationUrl),
        });

        const verifier = github.lastExchange?.codeVerifier ?? '';

        expect(createHash('sha256').update(verifier).digest('base64url')).toBe(challenge);
      });

      /**
       * §03 settles this: the API is same-origin under `APP_URL/api/v1` precisely so the session
       * cookie can be `__Host-`. A redirect URI derived from anything else is a callback whose
       * response cannot write the cookie it exists to write.
       */
      it('derives the redirect URI from APP_URL and the API prefix', async () => {
        const started = await service.begin('github');

        expect(new URL(started.authorizationUrl).searchParams.get('redirect_uri')).toBe(
          'https://app.forge.test/api/v1/auth/oauth/github/callback',
        );
      });
    });

    describe('complete', () => {
      it('refuses a callback with no state', async () => {
        await expect(
          service.complete('github', { code: 'c', device: DEVICE }),
        ).rejects.toBeInstanceOf(OauthStateError);
      });

      it('refuses a state this server never minted', async () => {
        await expect(
          service.complete('github', { code: 'c', device: DEVICE, state: 'invented' }),
        ).rejects.toBeInstanceOf(OauthStateError);
      });

      /**
       * The replay, at the unit level. The second call is refused because the record is *gone* —
       * `complete` consumes it with an `HGETALL` and a `DEL` in one `MULTI` — not because a flag was
       * read and checked.
       */
      it('spends the state, so the same callback cannot be replayed', async () => {
        const state = await startedState();

        await service.complete('github', { code: 'c', device: DEVICE, state });

        await expect(store.exists(oauthStateKey(sha256(state)))).resolves.toBe(0);
        await expect(
          service.complete('github', { code: 'c', device: DEVICE, state }),
        ).rejects.toBeInstanceOf(OauthStateError);
      });

      /**
       * Two callbacks racing on one state. Exactly one may win: the `MULTI` is what makes the loser
       * read an empty hash rather than the same record.
       */
      it('lets exactly one of two concurrent callbacks spend a state', async () => {
        const state = await startedState();
        const outcomes = await Promise.allSettled([
          service.complete('github', { code: 'c', device: DEVICE, state }),
          service.complete('github', { code: 'c', device: DEVICE, state }),
        ]);

        expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      });

      /**
       * A state minted at `/auth/oauth/github` cannot be completed at `/auth/oauth/google/callback`.
       * It would never succeed — the code is wrong for that token endpoint — but it would fail as a
       * 502 pointing at an innocent provider, and a mechanism only caught downstream is one change
       * away from not being caught at all.
       */
      it('refuses a state minted for a different provider, and spends it anyway', async () => {
        const state = await startedState('github');

        await expect(
          service.complete('google', { code: 'c', device: DEVICE, state }),
        ).rejects.toBeInstanceOf(OauthStateError);
        await expect(store.exists(oauthStateKey(sha256(state)))).resolves.toBe(0);
      });

      it('refuses a state that has expired', async () => {
        const state = await startedState();

        await store.del(oauthStateKey(sha256(state)));

        await expect(
          service.complete('github', { code: 'c', device: DEVICE, state }),
        ).rejects.toBeInstanceOf(OauthStateError);
      });

      /** A cancelled flow is a finished flow: the state does not survive the refusal. */
      it('reports a provider-side refusal and spends the state', async () => {
        const state = await startedState();

        await expect(
          service.complete('github', { device: DEVICE, error: 'access_denied', state }),
        ).rejects.toBeInstanceOf(OauthDeniedError);
        await expect(store.exists(oauthStateKey(sha256(state)))).resolves.toBe(0);
      });

      it('refuses a callback with a good state and no code', async () => {
        const state = await startedState();

        await expect(service.complete('github', { device: DEVICE, state })).rejects.toBeInstanceOf(
          OauthStateError,
        );
      });

      it('never contacts the provider for a state it could not resolve', async () => {
        github.lastExchange = null;

        await expect(
          service.complete('github', { code: 'c', device: DEVICE, state: 'invented' }),
        ).rejects.toBeInstanceOf(OauthStateError);

        expect(github.lastExchange).toBeNull();
      });
    });

    describe('resolving an account', () => {
      /**
       * Criterion 9's central refusal. The provider proved nothing, so there is nothing to link —
       * and the account whose address the provider merely *claimed* is untouched.
       */
      it('refuses to link when the provider vouched for no address', async () => {
        github.identity = { kind: 'unverified', providerUserId: `p-${randomUUID()}` };

        await expect(
          service.complete('github', { code: 'c', device: DEVICE, state: await startedState() }),
        ).rejects.toBeInstanceOf(OauthEmailUnverifiedError);
      });

      it('creates no account and no identity on that refusal', async () => {
        const providerUserId = `p-${randomUUID()}`;

        github.identity = { kind: 'unverified', providerUserId };

        await expect(
          service.complete('github', { code: 'c', device: DEVICE, state: await startedState() }),
        ).rejects.toBeInstanceOf(OauthEmailUnverifiedError);

        const rows = await database
          .select()
          .from(schema.oauthIdentities)
          .where(eq(schema.oauthIdentities.providerUserId, providerUserId));

        expect(rows).toHaveLength(0);
      });

      /** The third case: a proved address nobody here holds becomes an OAuth-only account. */
      it('creates an account with no password and a verified address', async () => {
        const email = mailbox();

        github.identity = { email, kind: 'verified', providerUserId: `p-${randomUUID()}` };

        const { userId } = await service.complete('github', {
          code: 'c',
          device: DEVICE,
          state: await startedState(),
        });

        created.push(userId);

        const [user] = await database
          .select()
          .from(schema.users)
          .where(eq(schema.users.id, userId));

        expect(user?.email).toBe(email);
        // §11's OAuth-only account. A password hash here would be one nobody set and nobody knows.
        expect(user?.passwordHash).toBeNull();
        // The provider proved control of exactly this address; asking for it again by mail would be
        // re-proving through a weaker channel what was just proved through a stronger one.
        expect(user?.emailVerifiedAt).not.toBeNull();
      });

      /** The second case, and the only one that may link: a proved address we already hold. */
      it('links a proved address to the account that already holds it', async () => {
        const email = mailbox();
        const userId = await seedUser(email);

        github.identity = { email, kind: 'verified', providerUserId: `p-${randomUUID()}` };

        const completed = await service.complete('github', {
          code: 'c',
          device: DEVICE,
          state: await startedState(),
        });

        expect(completed.userId).toBe(userId);
      });

      /** The address the provider asserted is recorded on the link, for the audit trail. */
      it('records the asserted address on the identity row', async () => {
        const email = mailbox();
        const providerUserId = `p-${randomUUID()}`;

        await seedUser(email);
        github.identity = { email, kind: 'verified', providerUserId };

        await service.complete('github', {
          code: 'c',
          device: DEVICE,
          state: await startedState(),
        });

        const [row] = await database
          .select()
          .from(schema.oauthIdentities)
          .where(eq(schema.oauthIdentities.providerUserId, providerUserId));

        expect(row?.email).toBe(email);
      });

      /** The first case: an identity that is already linked resolves straight to its account. */
      it('signs an already-linked identity in without touching the link', async () => {
        const email = mailbox();
        const userId = await seedUser(email);
        const providerUserId = `p-${randomUUID()}`;

        github.identity = { email, kind: 'verified', providerUserId };

        await service.complete('github', {
          code: 'c',
          device: DEVICE,
          state: await startedState(),
        });

        const second = await service.complete('github', {
          code: 'c',
          device: DEVICE,
          state: await startedState(),
        });

        expect(second.userId).toBe(userId);

        const rows = await database
          .select()
          .from(schema.oauthIdentities)
          .where(eq(schema.oauthIdentities.providerUserId, providerUserId));

        expect(rows).toHaveLength(1);
      });

      /**
       * The distinction the whole `ProviderIdentity` union exists for.
       *
       * A link made on proof is not unmade by the provider later declining to vouch — the user
       * removed the address from GitHub, or changed it and has not re-confirmed. Signing in still
       * works, because the link is the proof and it already happened. What must not work is
       * *creating* a link on the same answer, which the test above asserts.
       */
      it('still signs in an already-linked identity the provider no longer vouches for', async () => {
        const email = mailbox();
        const userId = await seedUser(email);
        const providerUserId = `p-${randomUUID()}`;

        github.identity = { email, kind: 'verified', providerUserId };
        await service.complete('github', {
          code: 'c',
          device: DEVICE,
          state: await startedState(),
        });

        github.identity = { kind: 'unverified', providerUserId };

        const later = await service.complete('github', {
          code: 'c',
          device: DEVICE,
          state: await startedState(),
        });

        expect(later.userId).toBe(userId);
      });

      /** `unique (user_id, provider)`: one account federates to one account per provider. */
      it('refuses a second identity for an account that already has one', async () => {
        const email = mailbox();

        await seedUser(email);
        github.identity = { email, kind: 'verified', providerUserId: `p-${randomUUID()}` };
        await service.complete('github', {
          code: 'c',
          device: DEVICE,
          state: await startedState(),
        });

        // A different GitHub account whose verified address is the same mailbox.
        github.identity = { email, kind: 'verified', providerUserId: `p-${randomUUID()}` };

        await expect(
          service.complete('github', { code: 'c', device: DEVICE, state: await startedState() }),
        ).rejects.toBeInstanceOf(OauthAccountAlreadyLinkedError);
      });
    });

    describe('the session it establishes', () => {
      it('authenticates as the account the identity resolved to', async () => {
        const email = mailbox();
        const userId = await seedUser(email);

        github.identity = { email, kind: 'verified', providerUserId: `p-${randomUUID()}` };

        const completed = await service.complete('github', {
          code: 'c',
          device: DEVICE,
          state: await startedState(),
        });

        await expect(sessions.authenticate(completed.session.token)).resolves.toMatchObject({
          pendingMfa: false,
          userId,
        });
      });

      /**
       * Session fixation, exactly as `LoginService` handles it: a cookie planted on a shared machine
       * before the sign-in must not survive it.
       */
      it('revokes whatever session the browser arrived holding', async () => {
        const email = mailbox();
        const userId = await seedUser(email);
        const planted = await sessions.create(userId, DEVICE);

        github.identity = { email, kind: 'verified', providerUserId: `p-${randomUUID()}` };

        const completed = await service.complete('github', {
          code: 'c',
          currentToken: planted.token,
          device: DEVICE,
          state: await startedState(),
        });

        await expect(sessions.authenticate(planted.token)).resolves.toBeNull();
        expect(completed.session.token).not.toBe(planted.token);
      });
    });
  });
});
