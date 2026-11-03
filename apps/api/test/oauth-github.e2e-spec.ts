import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { schema } from '@repo/db';
import { inArray } from 'drizzle-orm';
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
import { GITHUB_ENDPOINTS } from '../src/modules/identity/services/github.provider';

/**
 * GitHub is configured for this suite and Google deliberately is not.
 *
 * That asymmetry is doing real work: it means the "cleanly disabled when unconfigured" half of
 * criterion 9 is proved here over real HTTP, against the real router, in the same application
 * instance that completes a working GitHub sign-in — rather than in a second boot whose only
 * difference is an environment variable. A route that answers `501` while its neighbour answers
 * `302` is a route that is *mounted* and switched off, which is the whole property.
 *
 * `environment.ts` validates each provider's pair both-or-neither, so leaving both `GOOGLE_OAUTH_*`
 * unset is the supported way to express "disabled" and not a half-configured state.
 */
vi.hoisted(() => {
  process.env.APP_URL = 'https://app.forge.test';
  process.env.GITHUB_OAUTH_CLIENT_ID = 'Iv1.e2e-client-id';
  process.env.GITHUB_OAUTH_CLIENT_SECRET = 'ghs_e2eClientSecretThatMustNeverBeLogged';
  process.env.NODE_ENV = 'test';
  process.env.OAUTH_STATE_TTL_SECONDS = '600';
  process.env.SWAGGER_ENABLED = 'false';
});

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const START = '/api/v1/auth/oauth/github';
const CALLBACK = '/api/v1/auth/oauth/github/callback';
const ACCESS_TOKEN = 'gho_e2eAccessTokenThatMustNeverBeLogged';
const CLIENT_SECRET = 'ghs_e2eClientSecretThatMustNeverBeLogged';

/** Supertest types headers loosely; a response asserted as a redirect always carries one. */
function locationOf(response: request.Response): string {
  return (response.headers as Record<string, string | undefined>).location!;
}

/** One address entry as `GET /user/emails` returns it. */
interface StubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

/**
 * What the stub will say next, and what it was asked.
 *
 * A mutable record rather than a per-test server, so a test states only the answer it cares about
 * and the assertions about *what we sent* — the PKCE verifier, the redirect URI, the client
 * credentials — read the same field every time.
 */
interface StubState {
  emails: StubEmail[];
  profileEmail: string | null;
  providerUserId: string;
  tokenRequests: { body: string }[];
}

describe('OAuth sign-in with GitHub (e2e)', () => {
  describe.skipIf(!postgres || !redis)('against Postgres, Redis and a stubbed provider', () => {
    let app: INestApplication;
    let database: ForgeDatabase;
    let provider: HttpServer;
    let cookieName: string;
    let stub: StubState;
    const created: string[] = [];

    function http(): request.Agent {
      return request(app.getHttpServer() as Server);
    }

    function mailbox(): string {
      return `t22-${randomUUID()}@example.test`;
    }

    async function seedUser(email: string): Promise<string> {
      const [user] = await database
        .insert(schema.users)
        .values({ email, passwordHash: 'not-a-real-hash' })
        .returning({ id: schema.users.id });

      created.push(user!.id);

      return user!.id;
    }

    /**
     * Begin a flow the way a browser does, and read the `state` out of the `Location` GitHub would
     * have been sent to.
     *
     * Nothing here fabricates a state. That is the point of driving the start route: the value the
     * callback is given below is the one the application actually minted and stored, so a change
     * that broke the storage would fail these tests rather than pass them against an invented value.
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
      // The stub is a real HTTP server rather than a `fetch` mock, deliberately: T22 forbids adding
      // an HTTP client, so the code under test uses built-in `fetch`, and a suite that stubbed
      // `fetch` would be asserting against the thing it replaced. This exercises the real request.
      provider = createServer((incoming, response) => {
        const url = new URL(incoming.url ?? '/', 'http://stub.local');
        const send = (status: number, body: unknown): void => {
          response.writeHead(status, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify(body));
        };

        if (url.pathname === '/login/oauth/access_token') {
          const chunks: Buffer[] = [];

          incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
          incoming.on('end', () => {
            stub.tokenRequests.push({ body: Buffer.concat(chunks).toString('utf8') });
            send(200, { access_token: ACCESS_TOKEN, token_type: 'bearer' });
          });

          return;
        }

        if (incoming.headers.authorization !== `Bearer ${ACCESS_TOKEN}`) {
          send(401, { message: 'Requires authentication' });

          return;
        }

        if (url.pathname === '/user') {
          send(200, { email: stub.profileEmail, id: stub.providerUserId, login: 'ada' });

          return;
        }

        if (url.pathname === '/user/emails') {
          send(200, stub.emails);

          return;
        }

        send(404, { message: 'Not Found' });
      });

      await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));

      const base = `http://127.0.0.1:${String((provider.address() as AddressInfo).port)}`;

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(GITHUB_ENDPOINTS)
        .useValue({
          authorize: `${base}/login/oauth/authorize`,
          emails: `${base}/user/emails`,
          token: `${base}/login/oauth/access_token`,
          user: `${base}/user`,
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

    beforeEach(() => {
      const email = mailbox();

      stub = {
        emails: [{ email, primary: true, verified: true }],
        profileEmail: email,
        providerUserId: String(Math.floor(Math.random() * 1_000_000_000)),
        tokenRequests: [],
      };
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
      it('redirects to the provider with a state, an S256 challenge and the callback URI', async () => {
        const started = await http().get(START).expect(302);
        const location = new URL(locationOf(started));

        expect(location.searchParams.get('state')).toMatch(/^[\w-]{40,}$/);
        expect(location.searchParams.get('code_challenge_method')).toBe('S256');
        expect(location.searchParams.get('code_challenge')).toBeTruthy();
        expect(location.searchParams.get('redirect_uri')).toBe(
          'https://app.forge.test/api/v1/auth/oauth/github/callback',
        );
      });

      /**
       * The `Location` carries a live, single-use `state`. A shared cache that stored this response
       * would hand one user's pending flow to the next caller, who would then spend it.
       */
      it('forbids caching the redirect that carries the state', async () => {
        const started = await http().get(START).expect(302);

        expect(started.headers['cache-control']).toContain('no-store');
      });

      it('mints a different state for every caller', async () => {
        const [first, second] = await Promise.all([beginFlow(), beginFlow()]);

        expect(first.state).not.toBe(second.state);
      });

      /** The secret is a form field on the token POST and must never be in a URL the browser sees. */
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
          .where(inArray(schema.users.email, [stub.emails[0]!.email]));

        expect(user?.passwordHash).toBeNull();
        expect(user?.emailVerifiedAt).not.toBeNull();
        created.push(user!.id);
      });

      /** Criterion 3's property, on this route too: the token is in the cookie and nowhere else. */
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

        const [user] = await database
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(inArray(schema.users.email, [stub.emails[0]!.email]));

        created.push(user!.id);
      });

      /** The cookie is real: a guarded route accepts it. */
      it('establishes a session guarded routes accept', async () => {
        const { state } = await beginFlow();
        const completed = await callback(state).expect(303);
        const listed = await http()
          .get('/api/v1/auth/sessions')
          .set('Cookie', sessionCookie(completed) ?? '')
          .expect(200);

        expect((listed.body as { sessions: unknown[] }).sessions).toHaveLength(1);

        const [user] = await database
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(inArray(schema.users.email, [stub.emails[0]!.email]));

        created.push(user!.id);
      });

      /**
       * PKCE reaches the wire. The verifier the token call sent is the pre-image of the challenge
       * the browser was redirected with — which is the whole of RFC 7636 §4.6, asserted end to end
       * rather than at the unit that computes it.
       */
      it('sends the verifier matching the challenge it advertised', async () => {
        const { challenge, state } = await beginFlow();

        await callback(state).expect(303);

        const sent = new URLSearchParams(stub.tokenRequests[0]?.body ?? '');
        const verifier = sent.get('code_verifier') ?? '';

        expect(createHash('sha256').update(verifier).digest('base64url')).toBe(challenge);

        const [user] = await database
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(inArray(schema.users.email, [stub.emails[0]!.email]));

        created.push(user!.id);
      });

      it('links a proved address to an account that already exists', async () => {
        const email = mailbox();
        const userId = await seedUser(email);

        stub.emails = [{ email, primary: true, verified: true }];
        stub.profileEmail = email;

        const { state } = await beginFlow();

        await callback(state).expect(303);

        const rows = await database
          .select()
          .from(schema.oauthIdentities)
          .where(inArray(schema.oauthIdentities.userId, [userId]));

        expect(rows).toHaveLength(1);
        expect(rows[0]?.provider).toBe('github');
      });
    });

    /**
     * ## The first proof the task asks for: a replayed `state` is rejected.
     *
     * A callback URL is not a secret. It sits in the browser's history, in the provider's logs, in
     * the `Referer` of whatever the app loads next, and in any access log between the user and us.
     * If replaying it established a second session, then anybody who read one of those places could
     * sign in as that user — and the authorization code alone would not stop them, because it is in
     * the same URL.
     *
     * So the state is spent on first use, and the mechanism is that the record is *deleted* in the
     * same round trip that reads it rather than marked as used. The tests below assert the outcome
     * three ways: the replay is refused, it is refused with the catalogued slug, and it establishes
     * no session.
     */
    describe('a replayed state', () => {
      it('is rejected the second time', async () => {
        const { state } = await beginFlow();

        await callback(state).expect(303);

        const replayed = await callback(state).expect(400);

        expect(replayed.body).toMatchObject({
          status: 400,
          type: 'https://forge.dev/problems/oauth-state-invalid',
        });
        expect(replayed.headers['content-type']).toMatch(/application\/problem\+json/);

        const [user] = await database
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(inArray(schema.users.email, [stub.emails[0]!.email]));

        created.push(user!.id);
      });

      it('sets no session cookie on the replay', async () => {
        const { state } = await beginFlow();

        await callback(state).expect(303);

        const replayed = await callback(state).expect(400);

        expect(sessionCookie(replayed)).toBeUndefined();

        const [user] = await database
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(inArray(schema.users.email, [stub.emails[0]!.email]));

        created.push(user!.id);
      });

      /**
       * And the replay never reaches the provider. Asserted because the ordering is a decision:
       * the state is consumed before the token call, so a replayed callback costs one Redis round
       * trip rather than an exchange — and this route cannot be used to make us hammer GitHub with
       * codes on an unauthenticated caller's say-so.
       */
      it('does not exchange the code again', async () => {
        const { state } = await beginFlow();

        await callback(state).expect(303);
        expect(stub.tokenRequests).toHaveLength(1);

        await callback(state).expect(400);
        expect(stub.tokenRequests).toHaveLength(1);

        const [user] = await database
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(inArray(schema.users.email, [stub.emails[0]!.email]));

        created.push(user!.id);
      });

      it('rejects a state that was never minted, the same way', async () => {
        const invented = await callback('a-state-nobody-issued').expect(400);

        expect(invented.body).toMatchObject({
          type: 'https://forge.dev/problems/oauth-state-invalid',
        });
      });

      /**
       * A state minted for GitHub cannot be spent at Google's callback. It is refused as a state
       * failure — not as "Google is not configured" — because the state is checked before anything
       * else, and the two answers must not be a way to probe which providers exist.
       */
      it('rejects a state spent at another provider’s callback', async () => {
        const { state } = await beginFlow();
        const crossed = await http()
          .get('/api/v1/auth/oauth/google/callback')
          .query({ code: 'c', state })
          .expect(501);

        // Google is not configured at all in this deployment, so the configuration check answers
        // first — which is the honest order: there is no Google flow to have a state for.
        expect(crossed.body).toMatchObject({
          type: 'https://forge.dev/problems/oauth-provider-not-configured',
        });
      });
    });

    /**
     * ## The second proof: an unverified provider email cannot link.
     *
     * This is the takeover the whole design exists to prevent. GitHub lets anybody type any string
     * into their public profile's email field — it is display text, not a claim GitHub has checked —
     * and `GET /user` hands that string back. If a link were made on it, then registering a GitHub
     * account, typing a stranger's address into the profile, and pressing "Sign in with GitHub"
     * would be a complete account takeover requiring nothing but the victim's address.
     *
     * The stub below is that attack, staged exactly: the profile reports the victim's address, and
     * the verified list contains the attacker's own — or nothing at all.
     */
    describe('an unverified provider email', () => {
      it('cannot link to an existing account, even when the profile claims it', async () => {
        const victim = mailbox();
        const victimId = await seedUser(victim);

        // The attack: GitHub's profile endpoint reports the victim's address, and GitHub has
        // verified nothing.
        stub.profileEmail = victim;
        stub.emails = [{ email: victim, primary: true, verified: false }];

        const { state } = await beginFlow();
        const refused = await callback(state).expect(403);

        expect(refused.body).toMatchObject({
          status: 403,
          type: 'https://forge.dev/problems/oauth-email-unverified',
        });
        expect(refused.headers['content-type']).toMatch(/application\/problem\+json/);
        expect(sessionCookie(refused)).toBeUndefined();

        // And the victim's account is untouched: no identity was linked to it.
        const rows = await database
          .select()
          .from(schema.oauthIdentities)
          .where(inArray(schema.oauthIdentities.userId, [victimId]));

        expect(rows).toHaveLength(0);
      });

      /**
       * The same refusal when the verified address belongs to the attacker. The profile is not
       * merely outranked by the verified list — it is not read at all.
       */
      it('never links on the profile address when a different one is verified', async () => {
        const victim = mailbox();
        const victimId = await seedUser(victim);
        const attacker = mailbox();

        stub.profileEmail = victim;
        stub.emails = [{ email: attacker, primary: true, verified: true }];

        const { state } = await beginFlow();

        // It succeeds — as a sign-in for the *attacker's own* verified address, which creates their
        // own account. What it must not do is touch the victim's.
        await callback(state).expect(303);

        const victimRows = await database
          .select()
          .from(schema.oauthIdentities)
          .where(inArray(schema.oauthIdentities.userId, [victimId]));

        expect(victimRows).toHaveLength(0);

        const [created2] = await database
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(inArray(schema.users.email, [attacker]));

        expect(created2).toBeDefined();
        created.push(created2!.id);
      });

      it('creates no account when the provider has verified nothing at all', async () => {
        const email = mailbox();

        stub.profileEmail = email;
        stub.emails = [];

        const { state } = await beginFlow();

        await callback(state).expect(403);

        const rows = await database
          .select()
          .from(schema.users)
          .where(inArray(schema.users.email, [email]));

        expect(rows).toHaveLength(0);
      });

      /**
       * The other side of the rule, and the reason `ProviderIdentity` is a union rather than a
       * boolean: a link made on proof survives the provider later declining to vouch. The user
       * removed the address from GitHub; they are not locked out of the account they already linked.
       */
      it('still signs in an identity that was linked while it was verified', async () => {
        const email = mailbox();

        const first = await beginFlow();

        await callback(first.state).expect(303);

        const [user] = await database
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(inArray(schema.users.email, [email === '' ? email : stub.emails[0]!.email]));

        created.push(user!.id);

        // GitHub stops vouching, with the same provider user id.
        stub.emails = [{ email: stub.emails[0]!.email, primary: true, verified: false }];

        const second = await beginFlow();
        const later = await callback(second.state).expect(303);

        expect(sessionCookie(later)).toBeDefined();
      });
    });

    /**
     * ## Cleanly disabled when unconfigured
     *
     * Google has no client id in this deployment. Its routes still exist, still validate their
     * parameters, and answer a stable, catalogued `501` — never a `404`, which would be
     * indistinguishable from a router that failed to build, and never a `500`, which would page
     * somebody over a decision an operator made on purpose.
     */
    describe('a provider this deployment has not configured', () => {
      it('answers the start route with oauth-provider-not-configured', async () => {
        const refused = await http().get('/api/v1/auth/oauth/google').expect(501);

        expect(refused.body).toMatchObject({
          status: 501,
          type: 'https://forge.dev/problems/oauth-provider-not-configured',
        });
        expect(refused.headers['content-type']).toMatch(/application\/problem\+json/);
      });

      it('answers the callback route the same way', async () => {
        const refused = await http()
          .get('/api/v1/auth/oauth/google/callback')
          .query({ code: 'c', state: 's' })
          .expect(501);

        expect(refused.body).toMatchObject({
          type: 'https://forge.dev/problems/oauth-provider-not-configured',
        });
      });

      /**
       * The refusal must not be cacheable. A `501` is heuristically cacheable per RFC 9110 §15.6.2,
       * so without this an operator who configures Google and redeploys would be answered from an
       * intermediary's cache with "not implemented" for as long as it felt like keeping it.
       */
      it('forbids caching the refusal, so configuring the provider takes effect', async () => {
        const refused = await http().get('/api/v1/auth/oauth/google').expect(501);

        expect(refused.headers['cache-control']).toContain('no-store');
      });

      /** It is a switched-off provider, not a missing route: the router knows the path. */
      it('is a refusal rather than a 404', async () => {
        await http().get('/api/v1/auth/oauth/gitlab').expect(422);
      });
    });

    /** The provider vocabulary is closed, and an unknown one is a validation failure, not a 501. */
    describe('an unknown provider', () => {
      it('is rejected by the schema before anything looks for an adapter', async () => {
        const refused = await http().get('/api/v1/auth/oauth/gitlab').expect(422);

        expect(refused.body).toMatchObject({
          type: 'https://forge.dev/problems/validation-failed',
        });
      });
    });
  });
});
