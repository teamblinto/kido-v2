import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { schema } from '@repo/db';
import { inArray } from 'drizzle-orm';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import type { Environment } from '../src/config/environment';
import { APP_DATABASE } from '../src/database/database.constants';
import type { ForgeDatabase } from '../src/database/database.types';
import { GOOGLE_ENDPOINTS } from '../src/modules/identity/services/google.provider';

/**
 * Google is configured for this suite and GitHub deliberately is not — the mirror image of T22,
 * and for the same reason.
 *
 * "Cleanly disabled when unconfigured" is proved over real HTTP, against the real router, in the
 * same application instance that completes a working Google sign-in. Having each suite switch off
 * the *other* provider means the property is asserted twice from opposite directions, and neither
 * assertion can be passing because of something peculiar to one adapter.
 */
vi.hoisted(() => {
  process.env.APP_URL = 'https://app.forge.test';
  process.env.GOOGLE_OAUTH_CLIENT_ID = '1234.apps.googleusercontent.com';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = '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BeLogged';
  process.env.NODE_ENV = 'test';
  process.env.OAUTH_STATE_TTL_SECONDS = '600';
  process.env.SWAGGER_ENABLED = 'false';
});

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const START = '/api/v1/auth/oauth/google';
const CALLBACK = '/api/v1/auth/oauth/google/callback';
const CLIENT_ID = '1234.apps.googleusercontent.com';
const CLIENT_SECRET = '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BeLogged';

/**
 * The issuer is hard-coded in the adapter and is therefore hard-coded here.
 *
 * Only the three *endpoints* are overridable, so a token minted by this stub must still claim to
 * come from Google or it does not verify — which is what makes the wrong-issuer test below a test
 * of production behaviour rather than of a value the suite chose.
 */
const ISSUER = 'https://accounts.google.com';

/** Supertest types headers loosely; a response asserted as a redirect always carries one. */
function locationOf(response: request.Response): string {
  return (response.headers as Record<string, string | undefined>).location!;
}

interface SigningKey {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: Record<string, unknown>;
}

interface TokenOverrides {
  audience?: string;
  email?: string | undefined;
  emailVerified?: unknown;
  expiresAt?: string;
  issuer?: string;
  key?: SigningKey;
}

/**
 * What the stub will say next, and what it was asked.
 *
 * `idToken` is a whole minted token rather than a set of claims, so a test that wants a bad one
 * says so in the test body and every other test reads the same field.
 */
interface StubState {
  email: string;
  idToken: string;
  subject: string;
  tokenRequests: { body: string }[];
}

describe('OAuth sign-in with Google (e2e)', () => {
  describe.skipIf(!postgres || !redis)('against Postgres, Redis and a stubbed provider', () => {
    let app: INestApplication;
    let database: ForgeDatabase;
    let provider: HttpServer;
    let cookieName: string;
    let stub: StubState;
    let signing: SigningKey;
    let unpublished: SigningKey;
    const created: string[] = [];

    /**
     * Deliberately **not** reset between tests, because the thing being counted is not per-test.
     *
     * One application instance serves this whole suite, so one adapter holds one key set — and the
     * count below is therefore the number of times every sign-in in this file, together, cost
     * Google's certs endpoint a request.
     */
    let certsRequests = 0;

    function http(): request.Agent {
      return request(app.getHttpServer() as Server);
    }

    function mailbox(): string {
      return `t23-${randomUUID()}@example.test`;
    }

    async function keyPair(kid: string): Promise<SigningKey> {
      const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });

      return {
        kid,
        privateKey,
        publicJwk: { ...(await exportJWK(publicKey)), alg: 'RS256', kid, use: 'sig' },
      };
    }

    /**
     * Mint an `id_token` exactly as Google's token endpoint would return it, and hand it to the
     * stub — varying only whatever the test is about.
     *
     * The key pair is generated in this process, which is the whole reason the rejections below are
     * assertable at all: a suite pointed at the real Google can demonstrate a *successful* sign-in
     * and nothing else. It cannot produce a token minted for another audience, and it certainly
     * cannot produce one that expired an hour ago.
     */
    async function issue(overrides: TokenOverrides = {}): Promise<void> {
      const key = overrides.key ?? signing;
      const claims: Record<string, unknown> = {
        email_verified: 'emailVerified' in overrides ? overrides.emailVerified : true,
      };
      const email = 'email' in overrides ? overrides.email : stub.email;

      if (email !== undefined) {
        claims.email = email;
      }

      stub.idToken = await new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: key.kid })
        .setIssuer(overrides.issuer ?? ISSUER)
        .setAudience(overrides.audience ?? CLIENT_ID)
        .setSubject(stub.subject)
        .setIssuedAt()
        .setExpirationTime(overrides.expiresAt ?? '1h')
        .sign(key.privateKey);
    }

    async function seedUser(email: string): Promise<string> {
      const [user] = await database
        .insert(schema.users)
        .values({ email, passwordHash: 'not-a-real-hash' })
        .returning({ id: schema.users.id });

      created.push(user!.id);

      return user!.id;
    }

    /** Remember whatever account this flow created, so the suite cleans up after itself. */
    async function trackCreated(email: string): Promise<string | undefined> {
      const [user] = await database
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(inArray(schema.users.email, [email]));

      if (user !== undefined) {
        created.push(user.id);
      }

      return user?.id;
    }

    /**
     * Begin a flow the way a browser does, and read the `state` out of the `Location`.
     *
     * Nothing here fabricates a state: the value the callback is given is the one the application
     * actually minted and stored.
     */
    async function beginFlow(): Promise<{ challenge: string; state: string }> {
      const started = await http().get(START).expect(302);
      const location = new URL(locationOf(started));

      return {
        challenge: location.searchParams.get('code_challenge') ?? '',
        state: location.searchParams.get('state') ?? '',
      };
    }

    function callback(state: string, code = 'the-authorization-code'): request.Test {
      return http().get(CALLBACK).query({ code, state });
    }

    function sessionCookie(response: request.Response): string | undefined {
      const headers = response.headers as unknown as Record<string, string[] | undefined>;

      return (headers['set-cookie'] ?? []).find((header) => header.startsWith(`${cookieName}=`));
    }

    beforeAll(async () => {
      signing = await keyPair('the-key-google-is-using');
      unpublished = await keyPair('a-key-google-never-published');

      // A real HTTP server rather than a `fetch` mock, deliberately, and here it buys more than it
      // did in T22: `jose` fetches the key set through its own code path, so a suite that stubbed
      // `fetch` would be asserting against the thing it replaced rather than against the caching,
      // rotating key set the criterion is about.
      provider = createServer((incoming, response) => {
        const url = new URL(incoming.url ?? '/', 'http://stub.local');
        const send = (status: number, body: unknown): void => {
          response.writeHead(status, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify(body));
        };

        if (url.pathname === '/token') {
          const chunks: Buffer[] = [];

          incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
          incoming.on('end', () => {
            stub.tokenRequests.push({ body: Buffer.concat(chunks).toString('utf8') });
            send(200, {
              access_token: 'ya29.e2eAccessTokenThatIsNeverRead',
              expires_in: 3599,
              id_token: stub.idToken,
              token_type: 'Bearer',
            });
          });

          return;
        }

        if (url.pathname === '/certs') {
          certsRequests += 1;
          send(200, { keys: [signing.publicJwk] });

          return;
        }

        send(404, { error: 'not_found' });
      });

      await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));

      const base = `http://127.0.0.1:${String((provider.address() as AddressInfo).port)}`;

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(GOOGLE_ENDPOINTS)
        .useValue({
          authorize: `${base}/o/oauth2/v2/auth`,
          jwks: `${base}/certs`,
          token: `${base}/token`,
        })
        .compile();

      app = moduleRef.createNestApplication();
      configureApplication(app);
      await app.init();

      database = app.get<ForgeDatabase>(APP_DATABASE);
      cookieName = app
        .get(ConfigService<Environment, true>)
        .get('SESSION_COOKIE_NAME', { infer: true });
    }, 60_000);

    beforeEach(async () => {
      stub = {
        email: mailbox(),
        idToken: '',
        subject: String(Math.floor(Math.random() * 1_000_000_000)),
        tokenRequests: [],
      };

      await issue();
    });

    afterAll(async () => {
      if (created.length > 0) {
        await database.delete(schema.users).where(inArray(schema.users.id, created));
      }

      await new Promise<void>((resolve, reject) => {
        provider.close((error) => (error ? reject(error) : resolve()));
      });
      await app.close();
    }, 60_000);

    describe('starting a flow', () => {
      it('redirects to Google with a state, an S256 challenge and the callback URI', async () => {
        const started = await http().get(START).expect(302);
        const location = new URL(locationOf(started));

        expect(location.searchParams.get('state')).toMatch(/^[\w-]{40,}$/);
        expect(location.searchParams.get('code_challenge_method')).toBe('S256');
        expect(location.searchParams.get('code_challenge')).toBeTruthy();
        expect(location.searchParams.get('response_type')).toBe('code');
        expect(location.searchParams.get('redirect_uri')).toBe(
          'https://app.forge.test/api/v1/auth/oauth/google/callback',
        );
      });

      /** `openid` to be issued an `id_token` at all, `email` for the claim linking depends on. */
      it('asks for the openid and email scopes', async () => {
        const started = await http().get(START).expect(302);

        expect(new URL(locationOf(started)).searchParams.get('scope')).toBe('openid email');
      });

      it('forbids caching the redirect that carries the state', async () => {
        const started = await http().get(START).expect(302);

        expect(started.headers['cache-control']).toContain('no-store');
      });

      it('never puts the client secret in the redirect', async () => {
        const started = await http().get(START).expect(302);

        expect(started.headers.location).not.toContain(CLIENT_SECRET);
      });
    });

    describe('completing a flow', () => {
      it('signs a new address in and creates an OAuth-only account', async () => {
        const { state } = await beginFlow();
        const completed = await callback(state).expect(303);

        expect(completed.headers.location).toBe('https://app.forge.test');
        expect(sessionCookie(completed)).toBeDefined();

        const [user] = await database
          .select()
          .from(schema.users)
          .where(inArray(schema.users.email, [stub.email]));

        expect(user?.passwordHash).toBeNull();
        expect(user?.emailVerifiedAt).not.toBeNull();
        created.push(user!.id);
      });

      /** The `sub` claim is the immutable subject the identity row is keyed on, never the address. */
      it('keys the linked identity on the sub claim', async () => {
        const { state } = await beginFlow();

        await callback(state).expect(303);

        const userId = await trackCreated(stub.email);
        const rows = await database
          .select()
          .from(schema.oauthIdentities)
          .where(inArray(schema.oauthIdentities.userId, [userId!]));

        expect(rows).toHaveLength(1);
        expect(rows[0]?.provider).toBe('google');
        expect(rows[0]?.providerUserId).toBe(stub.subject);
      });

      it('puts the session token in a __Host- cookie and not in the redirect', async () => {
        const { state } = await beginFlow();
        const completed = await callback(state).expect(303);
        const cookie = sessionCookie(completed) ?? '';

        expect(cookie).toContain('HttpOnly');
        expect(cookie).toContain('Secure');
        expect(cookie).toContain('Path=/');
        expect(cookie).not.toContain('Domain=');

        const token = cookie.slice(cookie.indexOf('=') + 1, cookie.indexOf(';'));

        expect(completed.headers.location).not.toContain(token);
        await trackCreated(stub.email);
      });

      /**
       * The `id_token` is a bearer credential that also carries the user's address in a form
       * anybody can read. It is read out of the token response and goes no further: not into the
       * redirect, not into the cookie, not into any header on the way back to the browser.
       */
      it('never lets the id_token reach the browser', async () => {
        const { state } = await beginFlow();
        const completed = await callback(state).expect(303);
        const rendered = JSON.stringify(completed.headers);

        expect(stub.idToken.length).toBeGreaterThan(100);
        expect(rendered).not.toContain(stub.idToken);
        // Nor its payload segment on its own, which is where the address actually is.
        expect(rendered).not.toContain(stub.idToken.split('.')[1]);
        await trackCreated(stub.email);
      });

      it('establishes a session guarded routes accept', async () => {
        const { state } = await beginFlow();
        const completed = await callback(state).expect(303);
        const listed = await http()
          .get('/api/v1/auth/sessions')
          .set('Cookie', sessionCookie(completed) ?? '')
          .expect(200);

        expect((listed.body as { sessions: unknown[] }).sessions).toHaveLength(1);
        await trackCreated(stub.email);
      });

      /**
       * PKCE reaches the wire, and so does `grant_type` — which Google requires and GitHub does
       * not. The verifier sent is the pre-image of the challenge the browser was redirected with,
       * which is the whole of RFC 7636 §4.6 asserted end to end.
       */
      it('sends grant_type and the verifier matching the challenge it advertised', async () => {
        const { challenge, state } = await beginFlow();

        await callback(state).expect(303);

        const sent = new URLSearchParams(stub.tokenRequests[0]?.body ?? '');
        const verifier = sent.get('code_verifier') ?? '';

        expect(sent.get('grant_type')).toBe('authorization_code');
        expect(createHash('sha256').update(verifier).digest('base64url')).toBe(challenge);
        await trackCreated(stub.email);
      });

      it('links a proved address to an account that already exists', async () => {
        const email = mailbox();
        const userId = await seedUser(email);

        stub.email = email;
        await issue();

        const { state } = await beginFlow();

        await callback(state).expect(303);

        const rows = await database
          .select()
          .from(schema.oauthIdentities)
          .where(inArray(schema.oauthIdentities.userId, [userId]));

        expect(rows).toHaveLength(1);
        expect(rows[0]?.provider).toBe('google');
      });

      /** The core is shared with T22, and its single-use state is not a per-provider property. */
      it('refuses a replayed state, without exchanging the code again', async () => {
        const { state } = await beginFlow();

        await callback(state).expect(303);
        expect(stub.tokenRequests).toHaveLength(1);

        const replayed = await callback(state).expect(400);

        expect(replayed.body).toMatchObject({
          type: 'https://forge.dev/problems/oauth-state-invalid',
        });
        expect(sessionCookie(replayed)).toBeUndefined();
        expect(stub.tokenRequests).toHaveLength(1);
        await trackCreated(stub.email);
      });
    });

    /**
     * ## The proofs this task is written around
     *
     * Google does not prove an address with an authenticated call we make; it proves one with a
     * claim inside a document it signed. So the sign-in is worth exactly what the verification is
     * worth, and each of the refusals below is the difference between a sign-in and somebody
     * else's sign-in. All three are answered identically — `oauth-exchange-failed`, no session,
     * nothing written — because which check refused is of no use to a caller who reached this route
     * holding a live `state`, while the log carries `jose`'s code for whoever is on call.
     */
    describe('an id_token that does not verify', () => {
      /**
       * **Wrong audience.** Every Google relying party's tokens are signed by the same keys and
       * name the same `sub` for the same user, so `aud` is the only claim that distinguishes a
       * token minted for us from one minted for anybody else. Without this check, an `id_token`
       * that any other Google application obtained for a user is a complete sign-in as that user
       * here — and there are millions of such applications, some of which will hand a token to
       * their own client.
       */
      it('is rejected when it was minted for another audience', async () => {
        await issue({ audience: 'someone-elses-client.apps.googleusercontent.com' });

        const { state } = await beginFlow();
        const refused = await callback(state).expect(502);

        expect(refused.body).toMatchObject({
          status: 502,
          type: 'https://forge.dev/problems/oauth-exchange-failed',
        });
        expect(refused.headers['content-type']).toMatch(/application\/problem\+json/);
        expect(sessionCookie(refused)).toBeUndefined();

        // And nothing was written: no account, no identity, no session.
        const users = await database
          .select()
          .from(schema.users)
          .where(inArray(schema.users.email, [stub.email]));

        expect(users).toHaveLength(0);
      });

      /**
       * **Expired.** An `id_token` is a bearer credential with an hour of life, and it ends up in
       * places tokens end up — a log, a crash report, a proxy. Honouring one after `exp` turns a
       * credential that was meant to be ephemeral into a permanent one.
       */
      it('is rejected when it has expired', async () => {
        await issue({ expiresAt: '-1h' });

        const { state } = await beginFlow();
        const refused = await callback(state).expect(502);

        expect(refused.body).toMatchObject({
          status: 502,
          type: 'https://forge.dev/problems/oauth-exchange-failed',
        });
        expect(sessionCookie(refused)).toBeUndefined();

        const users = await database
          .select()
          .from(schema.users)
          .where(inArray(schema.users.email, [stub.email]));

        expect(users).toHaveLength(0);
      });

      /** Wrong issuer: correctly signed by *someone*, but not by the provider we asked. */
      it('is rejected when it comes from another issuer', async () => {
        await issue({ issuer: 'https://accounts.evil.test' });

        const { state } = await beginFlow();
        const refused = await callback(state).expect(502);

        expect(refused.body).toMatchObject({
          type: 'https://forge.dev/problems/oauth-exchange-failed',
        });
        expect(sessionCookie(refused)).toBeUndefined();
      });

      /**
       * Signed by a key the certs endpoint does not publish. This is the one a pinned key would
       * get backwards: the adapter trusts the *published set*, so a key that is not in it is
       * refused no matter how well-formed the token around it is.
       */
      it('is rejected when it is signed by a key Google does not publish', async () => {
        await issue({ key: unpublished });

        const { state } = await beginFlow();
        const refused = await callback(state).expect(502);

        expect(refused.body).toMatchObject({
          type: 'https://forge.dev/problems/oauth-exchange-failed',
        });
        expect(sessionCookie(refused)).toBeUndefined();
      });
    });

    /**
     * ## `email_verified` false cannot link
     *
     * The same takeover T22's GitHub suite stages, in the form Google makes possible: a Workspace
     * domain whose ownership was never proved will happily issue an account at any address on it,
     * and Google says so by sending `email_verified: false`. If a link were made on that claim,
     * standing up a domain — or being handed an account on somebody else's unverified one — would
     * be enough to sign in as whoever holds the matching address here.
     *
     * The refusal is the catalogued `oauth-email-unverified`, which is the same slug the GitHub
     * adapter's equivalent produces: the provider is already carried in the problem document's
     * extensions, and a client's remedy — prove the address with the provider, then try again — is
     * identical. The refusal is specific; it is not per-provider.
     */
    describe('an unverified provider email', () => {
      it('cannot link to an existing account, and leaves it untouched', async () => {
        const victim = mailbox();
        const victimId = await seedUser(victim);

        stub.email = victim;
        await issue({ emailVerified: false });

        const { state } = await beginFlow();
        const refused = await callback(state).expect(403);

        expect(refused.body).toMatchObject({
          status: 403,
          type: 'https://forge.dev/problems/oauth-email-unverified',
        });
        expect(refused.headers['content-type']).toMatch(/application\/problem\+json/);
        expect(sessionCookie(refused)).toBeUndefined();

        const rows = await database
          .select()
          .from(schema.oauthIdentities)
          .where(inArray(schema.oauthIdentities.userId, [victimId]));

        expect(rows).toHaveLength(0);
      });

      it('creates no account when the address is unproved', async () => {
        await issue({ emailVerified: false });

        const { state } = await beginFlow();

        await callback(state).expect(403);

        const rows = await database
          .select()
          .from(schema.users)
          .where(inArray(schema.users.email, [stub.email]));

        expect(rows).toHaveLength(0);
      });

      /** No `email` claim at all — the `email` scope refused at the consent screen — is the same. */
      it('refuses the same way when the token carries no address', async () => {
        await issue({ email: undefined });

        const { state } = await beginFlow();
        const refused = await callback(state).expect(403);

        expect(refused.body).toMatchObject({
          type: 'https://forge.dev/problems/oauth-email-unverified',
        });
      });

      /**
       * The other side of the rule, and the reason `ProviderIdentity` is a union rather than a
       * boolean: a link made on proof survives the provider later declining to vouch. Google stops
       * saying `email_verified` for the same `sub`; the user is not locked out of the account they
       * already linked.
       */
      it('still signs in an identity that was linked while it was verified', async () => {
        const { state } = await beginFlow();

        await callback(state).expect(303);
        await trackCreated(stub.email);

        await issue({ emailVerified: false });

        const second = await beginFlow();
        const later = await callback(second.state).expect(303);

        expect(sessionCookie(later)).toBeDefined();
      });
    });

    /**
     * ## The key set, over real HTTP
     *
     * The criterion asks for a *cached* set, and this is the assertion that it is one: two sign-ins
     * cost the certs endpoint a single request. The complementary half — that a `kid` the cache has
     * never seen triggers a refetch, which is what makes rotation survivable — is proved in
     * `google.provider.spec.ts`, where the clock can be moved past the refetch cooldown without
     * moving it underneath a live Postgres and Redis.
     */
    describe('the JWKS', () => {
      it('is fetched from the network and reused across sign-ins', async () => {
        for (let signIn = 0; signIn < 2; signIn += 1) {
          stub.email = mailbox();
          stub.subject = String(Math.floor(Math.random() * 1_000_000_000));
          await issue();

          const { state } = await beginFlow();

          await callback(state).expect(303);
          await trackCreated(stub.email);
        }

        // One request, for every sign-in this file has performed — the two immediately above and
        // every one before them. That single number is both halves of the claim at once: the keys
        // came over the network rather than from a constant in the source, and they were fetched
        // once rather than once per sign-in. Asserted after the loop rather than before it so the
        // test states the same thing when it is the only one that runs.
        expect(certsRequests).toBe(1);
      });
    });

    /**
     * ## Cleanly disabled when unconfigured
     *
     * GitHub has no client id in this deployment. Its routes still exist, still validate their
     * parameters, and answer the same stable, catalogued `501` that Google's answered in T22's
     * suite — never a `404`, which would be indistinguishable from a router that failed to build.
     */
    describe('a provider this deployment has not configured', () => {
      it('answers the start route with oauth-provider-not-configured', async () => {
        const refused = await http().get('/api/v1/auth/oauth/github').expect(501);

        expect(refused.body).toMatchObject({
          status: 501,
          type: 'https://forge.dev/problems/oauth-provider-not-configured',
        });
        expect(refused.headers['content-type']).toMatch(/application\/problem\+json/);
      });

      it('answers the callback route the same way', async () => {
        const refused = await http()
          .get('/api/v1/auth/oauth/github/callback')
          .query({ code: 'c', state: 's' })
          .expect(501);

        expect(refused.body).toMatchObject({
          type: 'https://forge.dev/problems/oauth-provider-not-configured',
        });
      });

      it('forbids caching the refusal, so configuring the provider takes effect', async () => {
        const refused = await http().get('/api/v1/auth/oauth/github').expect(501);

        expect(refused.headers['cache-control']).toContain('no-store');
      });

      /**
       * And a live Google state cannot be spent at the switched-off provider's callback: the
       * configuration check answers first, which is the honest order — there is no GitHub flow for
       * that state to belong to.
       */
      it('refuses a state minted here when it is spent at the other provider', async () => {
        const { state } = await beginFlow();
        const crossed = await http()
          .get('/api/v1/auth/oauth/github/callback')
          .query({ code: 'c', state })
          .expect(501);

        expect(crossed.body).toMatchObject({
          type: 'https://forge.dev/problems/oauth-provider-not-configured',
        });
      });
    });
  });
});
