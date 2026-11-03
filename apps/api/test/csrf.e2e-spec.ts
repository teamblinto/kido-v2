import type { INestApplication } from '@nestjs/common';
import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Put,
  Res,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { problemDetailSchema } from '@repo/contracts';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { CSRF_EXEMPT_PATHS, CsrfRejectedError } from '../src/common/csrf/csrf.middleware';
import { CSRF_HEADER } from '../src/common/csrf/csrf-token';
import { Public } from '../src/modules/identity/decorators/public.decorator';
import {
  type CookieWritingResponse,
  setSessionCookie,
} from '../src/modules/identity/session-cookie';

/** What `CORS_ORIGINS` defaults to, and therefore the one origin this API answers unsafe calls for. */
const APP_ORIGIN = 'http://localhost:5173';
const CSRF_COOKIE = 'forge_csrf';
const SESSION_COOKIE = '__Host-forge_session';
const WEBHOOK_PATH = '/api/v1/csrf-probes/webhook';

/**
 * Routes that exist to be attempted. `@Public()` because `SessionGuard` is an `APP_GUARD`: without
 * it every fixture here answers 401 and the suite would be asserting the guard rather than the
 * CSRF check.
 */
@Public()
@Controller({ path: 'csrf-probes', version: '1' })
class CsrfProbeController {
  @Get('safe')
  safe(): { reached: string } {
    return { reached: 'safe' };
  }

  @Post('unsafe')
  @HttpCode(HttpStatus.OK)
  post(): { reached: string } {
    return { reached: 'post' };
  }

  @Put('unsafe')
  @HttpCode(HttpStatus.OK)
  put(): { reached: string } {
    return { reached: 'put' };
  }

  @Patch('unsafe')
  @HttpCode(HttpStatus.OK)
  patch(): { reached: string } {
    return { reached: 'patch' };
  }

  @Delete('unsafe')
  @HttpCode(HttpStatus.OK)
  remove(): { reached: string } {
    return { reached: 'delete' };
  }

  /** Stands in for the first signature-verified webhook: on the exemption list, and unsafe. */
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  webhook(): { reached: string } {
    return { reached: 'webhook' };
  }

  /** Nothing beneath the exempt path is exempt; this is the route that proves it. */
  @Post('webhook/replay')
  @HttpCode(HttpStatus.OK)
  replay(): { reached: string } {
    return { reached: 'replay' };
  }

  /**
   * Writes the session cookie exactly as `AuthController` does, so the asymmetry between the two
   * cookies can be asserted from one response pair rather than described in a comment.
   */
  @Get('sign-in')
  signIn(@Res({ passthrough: true }) response: CookieWritingResponse): { signedIn: true } {
    setSessionCookie(response, SESSION_COOKIE, randomBytes(32).toString('base64url'), 1_209_600);

    return { signedIn: true };
  }
}

/** Not `@Public()`: it is here to show which of the two refusals a request earns first. */
@Controller({ path: 'csrf-guarded', version: '1' })
class GuardedProbeController {
  @Post('unsafe')
  @HttpCode(HttpStatus.OK)
  post(): { reached: string } {
    return { reached: 'guarded' };
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

  return {
    attributes: new Map<string, string | true>(
      rest.map((attribute) => {
        const at = attribute.indexOf('=');

        return at === -1
          ? [attribute.toLowerCase(), true as const]
          : [attribute.slice(0, at).toLowerCase(), attribute.slice(at + 1)];
      }),
    ),
    name: pair!.slice(0, separator),
    raw: header,
    value: pair!.slice(separator + 1),
  };
}

function setCookies(response: request.Response): ParsedCookie[] {
  const headers = response.headers as unknown as Record<string, string[] | undefined>;

  return (headers['set-cookie'] ?? []).map((value) => parseSetCookie(value));
}

function cookieNamed(response: request.Response, name: string): ParsedCookie | undefined {
  return setCookies(response).find((cookie) => cookie.name === name);
}

/**
 * A token the client minted itself, which is exactly what a browser does with this pattern: the
 * server only ever asks whether the cookie and the header agree, so any value presented in both
 * places is a valid pair. That is not a weakness the suite is exploiting — it is why the `Origin`
 * check is required alongside it, and every rejection below turns on one of the two failing.
 */
function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Through the published schema, so reading the field also asserts the document is a valid one. */
function detailOf(response: request.Response): string {
  return problemDetailSchema.parse(response.body).detail;
}

describe('CSRF (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.SWAGGER_ENABLED = 'false';
    const moduleRef = await Test.createTestingModule({
      controllers: [CsrfProbeController, GuardedProbeController],
      imports: [AppModule],
    })
      // The production list is empty until the first signed webhook lands, so the exemption is
      // exercised against a route mounted here. What is under test is that the middleware honours
      // the list exactly — not which paths happen to be on it today.
      .overrideProvider(CSRF_EXEMPT_PATHS)
      .useValue([WEBHOOK_PATH])
      .compile();

    app = moduleRef.createNestApplication();
    configureApplication(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  function http(): request.Agent {
    return request(app.getHttpServer() as Server);
  }

  /** The four ways to spell an unsafe request, so no case below is only proved for `POST`. */
  const UNSAFE = [
    ['POST', (path: string) => http().post(path)],
    ['PUT', (path: string) => http().put(path)],
    ['PATCH', (path: string) => http().patch(path)],
    ['DELETE', (path: string) => http().delete(path)],
  ] as const;

  describe('the CSRF cookie', () => {
    it('is handed to a caller that does not yet hold one', async () => {
      const response = await http().get('/api/v1/csrf-probes/safe').expect(200);

      expect(cookieNamed(response, CSRF_COOKIE)?.value.length).toBeGreaterThan(0);
    });

    /**
     * The point of the cookie, asserted as its own case. `HttpOnly` here would leave the client
     * with nothing to copy into the header, and the double submit with nothing to compare.
     */
    it('is readable by script — no HttpOnly', async () => {
      const response = await http().get('/api/v1/csrf-probes/safe').expect(200);

      expect(cookieNamed(response, CSRF_COOKIE)?.attributes.has('httponly')).toBe(false);
    });

    /**
     * Deliberately not `__Host-`. That prefix is this codebase's mark of the session cookie — the
     * one value nothing on the page may read — and `environment.ts` enforces it there. Two cookies
     * wearing it, one readable and one not, would make the mark answer nothing.
     */
    it('does not wear the __Host- prefix the session cookie is enforced to wear', async () => {
      const response = await http().get('/api/v1/csrf-probes/safe').expect(200);

      expect(cookieNamed(response, CSRF_COOKIE)?.name).toBe(CSRF_COOKIE);
      expect(cookieNamed(response, CSRF_COOKIE)?.name.startsWith('__Host-')).toBe(false);
    });

    /** Everything the prefix would have enforced is still promised, one attribute at a time. */
    it('is Secure, SameSite=Lax, Path=/ and carries no Domain', async () => {
      const response = await http().get('/api/v1/csrf-probes/safe').expect(200);
      const cookie = cookieNamed(response, CSRF_COOKIE)!;

      expect(cookie.attributes.get('secure')).toBe(true);
      expect(cookie.attributes.get('samesite')).toBe('Lax');
      expect(cookie.attributes.get('path')).toBe('/');
      expect(cookie.attributes.has('domain')).toBe(false);
      expect(cookie.raw).not.toMatch(/;\s*domain\s*=/i);
    });

    /**
     * The asymmetry, from one pair of responses. The session cookie keeps `HttpOnly` and keeps the
     * prefix; the CSRF cookie has neither. A change that "tidied" the two into agreement would
     * fail here whichever direction it tidied in.
     */
    it('is the readable one, while the session cookie stays the HttpOnly __Host- one', async () => {
      const signIn = await http().get('/api/v1/csrf-probes/sign-in').expect(200);
      const session = cookieNamed(signIn, SESSION_COOKIE)!;
      const csrf = cookieNamed(signIn, CSRF_COOKIE)!;

      expect(session.name.startsWith('__Host-')).toBe(true);
      expect(session.attributes.get('httponly')).toBe(true);
      expect(csrf.name.startsWith('__Host-')).toBe(false);
      expect(csrf.attributes.has('httponly')).toBe(false);
    });

    it('is not re-issued to a caller that already holds one', async () => {
      const response = await http()
        .get('/api/v1/csrf-probes/safe')
        .set('Cookie', `${CSRF_COOKIE}=${newToken()}`)
        .expect(200);

      expect(cookieNamed(response, CSRF_COOKIE)).toBeUndefined();
    });
  });

  describe('an unsafe request presenting both halves', () => {
    it.each(UNSAFE)('is let through on %s', async (_method, send) => {
      const token = newToken();

      await send('/api/v1/csrf-probes/unsafe')
        .set('Cookie', `${CSRF_COOKIE}=${token}`)
        .set(CSRF_HEADER, token)
        .set('Origin', APP_ORIGIN)
        .expect(200);
    });
  });

  /** The four rejections criterion 15 is asserted by. */
  describe('an unsafe request that is refused', () => {
    /** Missing token: the cookie is in the jar, but nothing echoed it into the header. */
    it('is refused when no token is echoed back', async () => {
      const response = await http()
        .post('/api/v1/csrf-probes/unsafe')
        .set('Cookie', `${CSRF_COOKIE}=${newToken()}`)
        .set('Origin', APP_ORIGIN)
        .expect(403);

      expect(response.body).toMatchObject({
        status: 403,
        type: 'https://forge.dev/problems/csrf-check-failed',
      });
    });

    it('is refused when it holds no CSRF cookie at all', async () => {
      await http()
        .post('/api/v1/csrf-probes/unsafe')
        .set(CSRF_HEADER, newToken())
        .set('Origin', APP_ORIGIN)
        .expect(403);
    });

    /** Stale token: a header echoing the value from a pair that has since been replaced. */
    it('is refused when the echoed token is stale', async () => {
      await http()
        .post('/api/v1/csrf-probes/unsafe')
        .set('Cookie', `${CSRF_COOKIE}=${newToken()}`)
        .set(CSRF_HEADER, newToken())
        .set('Origin', APP_ORIGIN)
        .expect(403);
    });

    /**
     * Foreign `Origin`, with a token that agrees with itself. This is the subdomain-XSS shape: a
     * script that can write the cookie can also set the header, so the double submit is satisfied
     * and only the origin is left to notice.
     */
    it('is refused when the Origin is foreign, however good the token is', async () => {
      const token = newToken();

      await http()
        .post('/api/v1/csrf-probes/unsafe')
        .set('Cookie', `${CSRF_COOKIE}=${token}`)
        .set(CSRF_HEADER, token)
        .set('Origin', 'https://evil.example')
        .expect(403);
    });

    /**
     * **Absent `Origin`** — the case that decides whether the check is worth having. Omitting a
     * header is free, so a missing origin that defaulted to allow would leave every unsafe route
     * resting on the token alone, which is the leg the case above already defeats.
     */
    it('is refused when no Origin header was sent at all', async () => {
      const token = newToken();
      const response = await http()
        .post('/api/v1/csrf-probes/unsafe')
        .set('Cookie', `${CSRF_COOKIE}=${token}`)
        .set(CSRF_HEADER, token)
        .expect(403);

      expect(response.body).toMatchObject({
        status: 403,
        type: 'https://forge.dev/problems/csrf-check-failed',
      });
    });

    it('is refused when the Origin is the literal null a sandboxed document sends', async () => {
      const token = newToken();

      await http()
        .post('/api/v1/csrf-probes/unsafe')
        .set('Cookie', `${CSRF_COOKIE}=${token}`)
        .set(CSRF_HEADER, token)
        .set('Origin', 'null')
        .expect(403);
    });

    it.each(UNSAFE)('is refused on %s, not only on POST', async (_method, send) => {
      await send('/api/v1/csrf-probes/unsafe').expect(403);
    });

    /**
     * The refusal is also the repair: a client whose first call is an unsafe one has never held a
     * pair, and a rejection that handed back no token would leave it unable to ever obtain one.
     */
    it('hands back a usable pair on the response that refused it', async () => {
      const refusal = await http()
        .post('/api/v1/csrf-probes/unsafe')
        .set('Origin', APP_ORIGIN)
        .expect(403);
      const issued = cookieNamed(refusal, CSRF_COOKIE)!;

      await http()
        .post('/api/v1/csrf-probes/unsafe')
        .set('Cookie', `${issued.name}=${issued.value}`)
        .set(CSRF_HEADER, issued.value)
        .set('Origin', APP_ORIGIN)
        .expect(200);
    });

    /**
     * The check runs before authentication, so a forged request is refused without a session
     * lookup and without the answer depending on whether the victim was signed in.
     */
    it('is refused for CSRF before it is refused for being unauthenticated', async () => {
      const response = await http().post('/api/v1/csrf-guarded/unsafe').expect(403);

      expect(response.body).toMatchObject({
        type: 'https://forge.dev/problems/csrf-check-failed',
      });
    });
  });

  describe('the problem document', () => {
    it('is a valid RFC 9457 document with the stable slug', async () => {
      const response = await http()
        .post('/api/v1/csrf-probes/unsafe')
        .set('X-Request-Id', 'e2e-csrf-1')
        .expect(403)
        .expect('Content-Type', /application\/problem\+json/);

      expect(response.body).toStrictEqual({
        // Taken from the error rather than restated, so the document and the thrower cannot drift.
        detail: new CsrfRejectedError().detail,
        instance: '/api/v1/csrf-probes/unsafe',
        requestId: 'e2e-csrf-1',
        status: 403,
        title: 'CSRF Check Failed',
        type: 'https://forge.dev/problems/csrf-check-failed',
      });
    });

    /** Saying which half failed tells an attacker which half to spend their effort on. */
    it('says the same thing whichever half failed', async () => {
      const token = newToken();
      const staleToken = await http()
        .post('/api/v1/csrf-probes/unsafe')
        .set('Cookie', `${CSRF_COOKIE}=${token}`)
        .set(CSRF_HEADER, newToken())
        .set('Origin', APP_ORIGIN)
        .expect(403);
      const foreignOrigin = await http()
        .post('/api/v1/csrf-probes/unsafe')
        .set('Cookie', `${CSRF_COOKIE}=${token}`)
        .set(CSRF_HEADER, token)
        .set('Origin', 'https://evil.example')
        .expect(403);

      expect(detailOf(staleToken)).toBe(detailOf(foreignOrigin));
    });

    it('echoes back neither the token it saw nor the origin it refused', async () => {
      const token = newToken();
      const response = await http()
        .post('/api/v1/csrf-probes/unsafe')
        .set('Cookie', `${CSRF_COOKIE}=${token}`)
        .set(CSRF_HEADER, token)
        .set('Origin', 'https://evil.example')
        .expect(403);

      expect(response.text).not.toContain(token);
      expect(response.text).not.toContain('evil.example');
    });
  });

  describe('the exemptions', () => {
    it('lets a GET through with neither half', async () => {
      await http().get('/api/v1/csrf-probes/safe').expect(200);
    });

    it('lets a HEAD through with neither half', async () => {
      await http().head('/api/v1/csrf-probes/safe').expect(200);
    });

    /** `cors` answers OPTIONS itself; what matters is that the CSRF check did not refuse it. */
    it('does not refuse an OPTIONS', async () => {
      const response = await http().options('/api/v1/csrf-probes/safe');

      expect(response.status).not.toBe(403);
    });

    it('lets an unsafe request through on a path that is on the exemption list', async () => {
      const response = await http().post(WEBHOOK_PATH).expect(200);

      expect(response.body).toEqual({ reached: 'webhook' });
    });

    /**
     * The requirement that makes the exemption a list rather than a rule. A prefix match on the
     * webhook path would exempt this route too, and a route that skips CSRF by inheritance is one
     * nobody decided to exempt.
     */
    it('does not exempt a route mounted beneath an exempt path', async () => {
      await http().post(`${WEBHOOK_PATH}/replay`).expect(403);
    });
  });
});
