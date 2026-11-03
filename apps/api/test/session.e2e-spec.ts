import type { INestApplication } from '@nestjs/common';
import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { createHash, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import type { Environment } from '../src/config/environment';
import { CurrentUser } from '../src/modules/identity/decorators/current-user.decorator';
import { Public } from '../src/modules/identity/decorators/public.decorator';
import { IdentityModule } from '../src/modules/identity/identity.module';
import {
  type AuthenticatedUser,
  SessionService,
  sessionKey,
} from '../src/modules/identity/services/session.service';
import {
  type CookieWritingResponse,
  setSessionCookie,
} from '../src/modules/identity/session-cookie';
import { unsafe } from './support/csrf-client';
import { openClient } from './support/integration-redis';

/**
 * Everything T16 will do at `POST /auth/login`, minus the part T16 owns.
 *
 * The session core ships before the endpoints that use it, so the guarantees it makes — the cookie
 * layout, the rotation, the restart — have nothing to knock on until T16 lands. This controller is
 * mounted by the suite only, never by `AppModule`, and exists so the assertions run against the
 * real guard, the real cookie writer and the real Redis rather than against a description of them.
 */
@Controller({ path: 'session-probes', version: '1' })
class SessionProbeController {
  private readonly cookieName: string;

  constructor(
    private readonly sessions: SessionService,
    config: ConfigService<Environment, true>,
  ) {
    this.cookieName = config.get('SESSION_COOKIE_NAME', { infer: true });
  }

  /** Stands in for login: the moment a user is authenticated and gets an identifier. */
  @Public()
  @Post('sign-in')
  @HttpCode(HttpStatus.OK)
  async signIn(
    @Body() body: { userId: string },
    @Res({ passthrough: true }) response: CookieWritingResponse,
  ): Promise<{ signedIn: true }> {
    const { token, ttlSeconds } = await this.sessions.create(body.userId);

    setSessionCookie(response, this.cookieName, token, ttlSeconds);

    // Deliberately everything the response says. The token travels in the cookie and nowhere else.
    return { signedIn: true };
  }

  /** Stands in for any authenticated route: it exists to be refused without a session. */
  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    return user;
  }

  /** Stands in for a privilege change — a role grant, an MFA enrolment, a step-up. */
  @Post('privilege-change')
  @HttpCode(HttpStatus.OK)
  async privilegeChange(
    @CurrentUser() user: AuthenticatedUser,
    @Req() incoming: { cookies?: Record<string, string> },
    @Res({ passthrough: true }) response: CookieWritingResponse,
  ): Promise<{ rotated: boolean }> {
    const rotated = await this.sessions.rotate(incoming.cookies?.[this.cookieName] ?? '');

    if (rotated === null) {
      return { rotated: false };
    }

    setSessionCookie(response, this.cookieName, rotated.token, rotated.ttlSeconds);

    return { rotated: user.userId.length > 0 };
  }

  /**
   * What every per-IP throttle in T16 will read. Public, because the question is what the proxy
   * headers resolved to, not who is asking.
   */
  @Public()
  @Get('client-ip')
  clientIp(@Req() incoming: { ip?: string }): { ip: string } {
    return { ip: incoming.ip ?? 'unresolved' };
  }
}

interface ParsedCookie {
  /** Attribute names lowercased; valueless attributes map to `true`. */
  readonly attributes: ReadonlyMap<string, string | true>;
  readonly name: string;
  readonly raw: string;
  readonly value: string;
}

function parseSetCookie(header: string): ParsedCookie {
  const [pair, ...rest] = header.split(';').map((part) => part.trim());
  const separator = pair!.indexOf('=');
  const attributes = new Map<string, string | true>(
    rest.map((attribute) => {
      const at = attribute.indexOf('=');

      return at === -1
        ? [attribute.toLowerCase(), true as const]
        : [attribute.slice(0, at).toLowerCase(), attribute.slice(at + 1)];
    }),
  );

  return {
    attributes,
    name: pair!.slice(0, separator),
    raw: header,
    value: pair!.slice(separator + 1),
  };
}

function setCookieHeader(response: request.Response): ParsedCookie {
  const headers = response.headers as unknown as Record<string, string[] | undefined>;
  const values = headers['set-cookie'] ?? [];

  expect(values).toHaveLength(1);

  return parseSetCookie(values[0]!);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const reachable = inject('redisReachable');
const TTL_SECONDS = 1_209_600;

describe('Sessions (e2e)', () => {
  describe.skipIf(!reachable)('against the session Redis role', () => {
    let app: INestApplication;
    let probe: Redis;
    let cookieName: string;
    const issued: string[] = [];

    /** Build a whole application — module graph, providers, HTTP server — from nothing. */
    async function bootApi(): Promise<INestApplication> {
      const moduleRef = await Test.createTestingModule({
        controllers: [SessionProbeController],
        imports: [AppModule, IdentityModule],
      }).compile();
      const built = moduleRef.createNestApplication();

      configureApplication(built);
      await built.init();

      return built;
    }

    function http(target: INestApplication = app): request.Agent {
      return request(target.getHttpServer() as Server);
    }

    /** Sign a fresh user in and hand back the cookie the browser would now hold. */
    async function signIn(
      target: INestApplication = app,
      userId: string = randomUUID(),
    ): Promise<{ cookie: string; response: request.Response; userId: string }> {
      const response = await unsafe(http(target).post('/api/v1/session-probes/sign-in')).send({
        userId,
      });
      const parsed = setCookieHeader(response);

      issued.push(parsed.value);

      return { cookie: `${parsed.name}=${parsed.value}`, response, userId };
    }

    beforeAll(async () => {
      process.env.NODE_ENV = 'test';
      process.env.SWAGGER_ENABLED = 'false';
      app = await bootApi();
      cookieName = app.get(ConfigService<Environment, true>).get('SESSION_COOKIE_NAME', {
        infer: true,
      });
      probe = openClient(process.env.REDIS_SESSION_URL!);
      await probe.connect();
    });

    afterAll(async () => {
      if (issued.length > 0) {
        await probe.del(...issued.map((token) => sessionKey(sha256(token))));
      }

      probe.disconnect();
      await app.close();
    });

    describe('the cookie', () => {
      it('is the __Host--prefixed name §11 names', async () => {
        const { response } = await signIn();

        expect(setCookieHeader(response).name).toBe('__Host-forge_session');
      });

      /**
       * Asserted as the *complete* attribute list rather than one `toContain` per attribute.
       * Checking only the attributes that should be there is a test that passes unchanged after
       * somebody adds `Domain`, and `Domain` is the single attribute whose presence undoes the
       * prefix, un-scopes the cookie to every sibling of `app.forge.dev` and breaks §03's four
       * origins. The absence has to be something the test can fail on.
       */
      it('carries exactly Max-Age, Path, Expires, HttpOnly, Secure and SameSite — and nothing else', async () => {
        const { response } = await signIn();
        const cookie = setCookieHeader(response);

        expect([...cookie.attributes.keys()].sort()).toEqual([
          'expires',
          'httponly',
          'max-age',
          'path',
          'samesite',
          'secure',
        ]);
      });

      it('has no Domain attribute', async () => {
        const { response } = await signIn();
        const cookie = setCookieHeader(response);

        expect(cookie.attributes.has('domain')).toBe(false);
        expect(cookie.raw).not.toMatch(/;\s*domain\s*=/i);
      });

      it('is Secure, HttpOnly, SameSite=Lax and Path=/', async () => {
        const { response } = await signIn();
        const { attributes } = setCookieHeader(response);

        expect(attributes.get('secure')).toBe(true);
        expect(attributes.get('httponly')).toBe(true);
        expect(attributes.get('samesite')).toBe('Lax');
        expect(attributes.get('path')).toBe('/');
      });

      it('expires with the configured session TTL', async () => {
        const { response } = await signIn();

        expect(setCookieHeader(response).attributes.get('max-age')).toBe(String(TTL_SECONDS));
      });

      /** Criterion 3: the token is in the cookie, and in nothing a client could read or log. */
      it('is the only place the token appears — never the response body', async () => {
        const { response } = await signIn();
        const cookie = setCookieHeader(response);

        expect(response.body).toEqual({ signedIn: true });
        expect(response.text).not.toContain(cookie.value);
        expect(JSON.stringify(response.body)).not.toContain(cookie.value);
      });

      /** And never a Redis key either — the store holds the hash, the browser holds the token. */
      it('names a session key that is the hash of the token, not the token', async () => {
        const { response } = await signIn();
        const { value } = setCookieHeader(response);

        await expect(probe.exists(sessionKey(sha256(value)))).resolves.toBe(1);
        await expect(probe.exists(sessionKey(value))).resolves.toBe(0);
      });
    });

    describe('the guard', () => {
      it('refuses a guarded route with no cookie', async () => {
        const response = await http()
          .get('/api/v1/session-probes/me')
          .expect(401)
          .expect('Content-Type', /application\/problem\+json/);

        expect(response.body).toMatchObject({
          status: 401,
          type: 'https://forge.dev/problems/unauthorized',
        });
      });

      it('refuses a cookie that is not a session', async () => {
        await http()
          .get('/api/v1/session-probes/me')
          .set('Cookie', `${cookieName}=Gg8kQ2mZ0tWx4pLnRc7bVs1yEhAuJiOoQrTvWxYzAbC`)
          .expect(401);
      });

      it('resolves the principal for a live session', async () => {
        const { cookie, userId } = await signIn();

        const response = await http()
          .get('/api/v1/session-probes/me')
          .set('Cookie', cookie)
          .expect(200);

        expect(response.body).toMatchObject({ userId });
      });

      /** `sessionId` is the hash. Handing the raw token back to a handler would put it in reach. */
      it('gives the handler the session hash, never the token', async () => {
        const { cookie } = await signIn();
        const token = cookie.split('=')[1]!;

        const response = await http()
          .get('/api/v1/session-probes/me')
          .set('Cookie', cookie)
          .expect(200);

        expect(response.body).toMatchObject({ sessionId: sha256(token) });
        expect(JSON.stringify(response.body)).not.toContain(token);
      });

      it('lets @Public() routes through unauthenticated', async () => {
        await http().get('/api/v1').expect(200);
      });

      /** The probe endpoint gates the container; a 401 here would fail every deploy. */
      it('leaves the health probe reachable without a session', async () => {
        const response = await http().get('/api/v1/health');

        expect(response.status).not.toBe(401);
      });
    });

    describe('rotation', () => {
      /**
       * Criterion 5, first half. Signing in while already holding a live session must hand back a
       * different identifier — the value the client had before authenticating can never be the
       * value it holds after.
       */
      it('changes the identifier on login', async () => {
        const first = await signIn();

        const response = await unsafe(http().post('/api/v1/session-probes/sign-in'), [
          first.cookie,
        ]).send({ userId: first.userId });
        const second = setCookieHeader(response);

        issued.push(second.value);
        expect(second.value).not.toBe(first.cookie.split('=')[1]);
      });

      it('changes the identifier on a privilege change', async () => {
        const { cookie } = await signIn();

        const response = await unsafe(http().post('/api/v1/session-probes/privilege-change'), [
          cookie,
        ]).expect(200);
        const rotated = setCookieHeader(response);

        issued.push(rotated.value);
        expect(response.body).toEqual({ rotated: true });
        expect(rotated.value).not.toBe(cookie.split('=')[1]);
      });

      it('retires the old identifier the moment it rotates', async () => {
        const { cookie } = await signIn();

        const response = await unsafe(http().post('/api/v1/session-probes/privilege-change'), [
          cookie,
        ]).expect(200);

        issued.push(setCookieHeader(response).value);

        await http().get('/api/v1/session-probes/me').set('Cookie', cookie).expect(401);
      });

      it('keeps the user signed in under the new identifier', async () => {
        const { cookie, userId } = await signIn();

        const rotation = await unsafe(http().post('/api/v1/session-probes/privilege-change'), [
          cookie,
        ]).expect(200);
        const rotated = setCookieHeader(rotation);

        issued.push(rotated.value);

        const response = await http()
          .get('/api/v1/session-probes/me')
          .set('Cookie', `${rotated.name}=${rotated.value}`)
          .expect(200);

        expect(response.body).toMatchObject({ userId });
      });
    });

    /**
     * Criterion 5, second half, and the reason ADR 001 exists.
     *
     * The application is torn down and a new one is built from the module graph up: a new container,
     * new provider instances, new Redis clients, a new HTTP server. Nothing the first application
     * held survives into the second, so a session that still answers on the second one is a session
     * whose state was never in the first one's memory.
     */
    describe('surviving a restart', () => {
      it('still authenticates the same cookie after the API is restarted', async () => {
        const { cookie, userId } = await signIn();

        await http().get('/api/v1/session-probes/me').set('Cookie', cookie).expect(200);

        await app.close();
        app = await bootApi();

        const response = await http()
          .get('/api/v1/session-probes/me')
          .set('Cookie', cookie)
          .expect(200);

        expect(response.body).toMatchObject({ userId });
      });

      /**
       * The other half of the same proof, and the one that a restart alone cannot give. If the
       * restarted application answered from anything but Redis — a module-scoped cache, a warm
       * file — dropping the key would change nothing. It has to be the difference between 200
       * and 401.
       */
      it('stops authenticating it the moment the key leaves Redis', async () => {
        const { cookie } = await signIn();
        const token = cookie.split('=')[1]!;

        await http().get('/api/v1/session-probes/me').set('Cookie', cookie).expect(200);

        await app.close();
        app = await bootApi();
        await probe.del(sessionKey(sha256(token)));

        await http().get('/api/v1/session-probes/me').set('Cookie', cookie).expect(401);
      });
    });

    /**
     * Without `trust proxy`, Express reports the socket's peer — which behind nginx is nginx. Every
     * per-IP bucket in T16 would then count one client, the proxy, and a throttle that counts one
     * client is a throttle that is off. It fails open and silently, which is why it is asserted
     * here rather than left to T16 to discover.
     */
    describe('client addressing behind the proxy', () => {
      it('reports the forwarded client address, not the proxy that connected', async () => {
        const response = await http()
          .get('/api/v1/session-probes/client-ip')
          .set('X-Forwarded-For', '203.0.113.7')
          .expect(200);

        expect(response.body).toEqual({ ip: '203.0.113.7' });
      });

      it('ignores a forwarded header on a request that did not come through the proxy chain', async () => {
        const response = await http()
          .get('/api/v1/session-probes/client-ip')
          .set('X-Forwarded-For', '203.0.113.7, 198.51.100.4')
          .expect(200);

        // One hop is trusted, so only the address the trusted proxy itself appended is believed.
        expect(response.body).toEqual({ ip: '198.51.100.4' });
      });
    });
  });
});
