import type { ExecutionContext } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DomainError } from '../../../common/errors/domain-error';
import type { Environment } from '../../../config/environment';
import { AuthController } from '../controllers/auth.controller';
import { PasswordController } from '../controllers/password.controller';
import {
  TURNSTILE_TOKEN_HEADER,
  TURNSTILE_TOKEN_MAX_LENGTH,
  TURNSTILE_VERIFY_URL,
  TurnstileGuard,
} from './turnstile.guard';

const SECRET = '0x4AAAAAAA-this-is-not-a-real-secret';
const TOKEN = '0.abcdefghijklmnopqrstuvwxyz.a-real-looking-turnstile-token';

describe('TurnstileGuard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function guardWith(secret: string | undefined): TurnstileGuard {
    return new TurnstileGuard({
      get: () => secret,
    } as unknown as ConfigService<Environment, true>);
  }

  function contextFor(headers: Record<string, string | string[] | undefined>): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => ({ headers }) }),
    } as unknown as ExecutionContext;
  }

  const bearing = (token: string | string[]): ExecutionContext =>
    contextFor({ [TURNSTILE_TOKEN_HEADER]: token });

  function stubFetch(implementation: typeof fetch): ReturnType<typeof vi.fn> {
    const spy = vi.fn(implementation);

    vi.stubGlobal('fetch', spy);

    return spy;
  }

  const answering =
    (body: unknown, status = 200): typeof fetch =>
    () =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          headers: { 'content-type': 'application/json' },
          status,
        }),
      );

  /** The error a refused activation threw, failing loudly when it was not refused. */
  async function refusalOf(activate: () => Promise<boolean>): Promise<DomainError> {
    try {
      await activate();
    } catch (error: unknown) {
      return error as DomainError;
    }

    return expect.unreachable('expected the guard to refuse, but it let the request through');
  }

  /** Counts what reached the logger, whatever level it was written at. */
  function captureLogs(): string[] {
    const lines: string[] = [];
    const record = (message: unknown): void => {
      lines.push(String(message));
    };

    for (const level of ['debug', 'error', 'log', 'verbose', 'warn'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation(record);
    }

    return lines;
  }

  describe('when TURNSTILE_SECRET_KEY is not set', () => {
    it('warns exactly once, at boot', () => {
      const lines = captureLogs();
      const guard = guardWith(undefined);

      // Nothing yet: constructing a provider is not booting an application, and a message emitted
      // from a constructor would also be emitted by every test that builds a testing module.
      expect(lines).toHaveLength(0);

      guard.onModuleInit();

      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('TURNSTILE_SECRET_KEY');
    });

    /**
     * The point of the task. A guard that warns from `canActivate` is correct on the first request
     * and is a line per signup attempt afterwards — on a developer's machine, which is the only
     * place this branch is ever reached, and whose log is the one somebody is actually reading.
     */
    it('says nothing further however many requests it admits', async () => {
      const guard = guardWith(undefined);
      const lines = captureLogs();

      guard.onModuleInit();

      for (let attempt = 0; attempt < 25; attempt += 1) {
        await guard.canActivate(bearing(TOKEN));
      }

      expect(lines).toHaveLength(1);
    });

    it('admits a request carrying no token at all', async () => {
      const guard = guardWith(undefined);

      await expect(guard.canActivate(contextFor({}))).resolves.toBe(true);
    });

    it('admits a request whose token would be refused if a secret were configured', async () => {
      const spy = stubFetch(answering({ success: false }));
      const guard = guardWith(undefined);

      await expect(guard.canActivate(bearing(TOKEN))).resolves.toBe(true);

      // Inert means inert: no secret, no verification, no call. A guard that asked Cloudflare and
      // then ignored the answer would be a request to a third party on every unconfigured signup.
      expect(spy).not.toHaveBeenCalled();
    });

    it('says nothing at boot once a secret is configured', () => {
      const lines = captureLogs();

      guardWith(SECRET).onModuleInit();

      expect(lines).toHaveLength(0);
    });
  });

  describe('when TURNSTILE_SECRET_KEY is set', () => {
    it('admits a request whose token Cloudflare accepts', async () => {
      stubFetch(answering({ challenge_ts: '2026-08-17T10:00:00.000Z', success: true }));

      await expect(guardWith(SECRET).canActivate(bearing(TOKEN))).resolves.toBe(true);
    });

    it('refuses a token Cloudflare rejects', async () => {
      stubFetch(answering({ 'error-codes': ['invalid-input-response'], success: false }));

      const refusal = await refusalOf(() => guardWith(SECRET).canActivate(bearing(TOKEN)));

      expect(refusal.type).toBe('turnstile-check-failed');
      expect(refusal.status).toBe(403);
    });

    /**
     * A 403, never a 401 and never a 422. There is no session to invalidate — both guarded routes
     * are `@Public()` — and the request body is perfectly well formed, so a client that reported
     * field errors here would point a human at a form they filled in correctly.
     */
    it('refuses with a slug the client can act on rather than an authentication failure', async () => {
      stubFetch(answering({ success: false }));

      const refusal = await refusalOf(() => guardWith(SECRET).canActivate(bearing(TOKEN)));

      expect(refusal.status).not.toBe(401);
      expect(refusal.status).not.toBe(422);
    });

    it.each([
      ['no header at all', {}],
      ['an empty header', { [TURNSTILE_TOKEN_HEADER]: '' }],
      ['a header that is only whitespace', { [TURNSTILE_TOKEN_HEADER]: '   ' }],
      ['an absurdly long header', { [TURNSTILE_TOKEN_HEADER]: 'a'.repeat(50_000) }],
    ])('refuses %s without calling Cloudflare', async (_name, headers) => {
      const spy = stubFetch(answering({ success: true }));

      const refusal = await refusalOf(() => guardWith(SECRET).canActivate(contextFor(headers)));

      expect(refusal.type).toBe('turnstile-check-failed');
      expect(spy).not.toHaveBeenCalled();
    });

    it('accepts a token exactly at the length ceiling and refuses one past it', async () => {
      stubFetch(answering({ success: true }));
      const guard = guardWith(SECRET);

      await expect(
        guard.canActivate(bearing('a'.repeat(TURNSTILE_TOKEN_MAX_LENGTH))),
      ).resolves.toBe(true);

      expect(
        (
          await refusalOf(() =>
            guard.canActivate(bearing('a'.repeat(TURNSTILE_TOKEN_MAX_LENGTH + 1))),
          )
        ).type,
      ).toBe('turnstile-check-failed');
    });

    /** A repeated header arrives as an array; the first value is the request's own. */
    it('reads the first value of a repeated header', async () => {
      const spy = stubFetch(answering({ success: true }));

      await guardWith(SECRET).canActivate(bearing([TOKEN, 'a-second-token']));

      expect(sentField(spy, 'response')).toBe(TOKEN);
    });

    it('posts the token and the secret to siteverify as a form body', async () => {
      const spy = stubFetch(answering({ success: true }));

      await guardWith(SECRET).canActivate(bearing(TOKEN));

      const [url, init] = spy.mock.calls[0] as [string, RequestInit];

      expect(url).toBe(TURNSTILE_VERIFY_URL);
      expect(init.method).toBe('POST');
      expect(init.body).toBeInstanceOf(URLSearchParams);
      expect(sentField(spy, 'secret')).toBe(SECRET);
      expect(sentField(spy, 'response')).toBe(TOKEN);
    });

    /**
     * `remoteip` is optional, and sending one that disagrees by a shade with the address Cloudflare
     * saw solve the challenge refuses every signup for a reason no log line here can explain. The
     * replay it would prevent is already bounded by a single-use, five-minute token.
     */
    it('does not send a remote address', async () => {
      const spy = stubFetch(answering({ success: true }));

      await guardWith(SECRET).canActivate(bearing(TOKEN));

      expect(sentField(spy, 'remoteip')).toBeNull();
    });

    /**
     * The secret and the token go to Cloudflare and nowhere else. If this ever fails, a signup
     * attempt is writing a working anti-automation credential into a log aggregator.
     */
    it('never logs the secret or the token, on the accepting or the refusing path', async () => {
      const lines = captureLogs();
      stubFetch(answering({ 'error-codes': ['timeout-or-duplicate'], success: false }));

      const guard = guardWith(SECRET);

      await refusalOf(() => guard.canActivate(bearing(TOKEN)));

      stubFetch(answering({ success: true }));
      await guard.canActivate(bearing(TOKEN));

      const everything = lines.join('\n');

      expect(everything).not.toContain(SECRET);
      expect(everything).not.toContain(TOKEN);
    });

    it('keeps the token out of the refusal a client receives', async () => {
      stubFetch(answering({ 'error-codes': ['invalid-input-response'], success: false }));

      const refusal = await refusalOf(() => guardWith(SECRET).canActivate(bearing(TOKEN)));

      expect(JSON.stringify(refusal)).not.toContain(TOKEN);
      expect(refusal.detail).not.toContain(TOKEN);
      // Cloudflare's own diagnosis is withheld too: naming it tells an automated caller which half
      // of the check to work on, and a human's remedy is the same whichever code came back.
      expect(refusal.detail).not.toContain('invalid-input-response');
    });

    it('bounds how long it will wait for siteverify', async () => {
      const spy = stubFetch(answering({ success: true }));

      await guardWith(SECRET).canActivate(bearing(TOKEN));

      const [, init] = spy.mock.calls[0] as [string, RequestInit];

      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    /**
     * Fails **closed**, and the whole design turns on it. `HibpAdapter` fails open under ADR 008
     * because the breach check is advisory; nothing analogous holds here. These two routes are the
     * only ones in the codebase that send mail to an address nobody has proved they own, and a
     * verifier that waves requests through when it cannot be reached is an amplifier that switches
     * on the moment somebody makes it unreachable.
     */
    it.each([
      [
        'a rejected connection',
        (): never => {
          throw new TypeError('fetch failed');
        },
      ],
      [
        'a timeout',
        (): never => {
          throw new DOMException('aborted', 'TimeoutError');
        },
      ],
      ['a 500 from Cloudflare', answering({}, 500)],
      ['a 403 from Cloudflare', answering({}, 403)],
      [
        'a body that is not JSON',
        (): Promise<Response> => Promise.resolve(new Response('<html/>')),
      ],
    ])('refuses on %s rather than admitting the request', async (_name, implementation) => {
      stubFetch(implementation);

      const refusal = await refusalOf(() => guardWith(SECRET).canActivate(bearing(TOKEN)));

      expect(refusal.status).toBe(503);
      expect(refusal.type).toBe('service-unavailable');
    });

    /**
     * An unreachable verifier and a refused token are different slugs on purpose: one is retried
     * after a fresh challenge, the other after a wait, with the same token and no user action.
     */
    it('tells an outage apart from a refusal', async () => {
      stubFetch(answering({}, 500));
      const outage = await refusalOf(() => guardWith(SECRET).canActivate(bearing(TOKEN)));

      stubFetch(answering({ success: false }));
      const refusal = await refusalOf(() => guardWith(SECRET).canActivate(bearing(TOKEN)));

      expect(outage.type).not.toBe(refusal.type);
    });

    /**
     * A body that parsed but is not siteverify's — an interception page's JSON, an error envelope,
     * a bare `null` — must not pass by carrying any truthy `success`.
     */
    it.each([
      ['a missing success member', {}],
      ['a truthy non-boolean success', { success: 'yes' }],
      ['a numeric success', { success: 1 }],
      ['a null body', null],
    ])('refuses %s', async (_name, body) => {
      stubFetch(answering(body));

      const refusal = await refusalOf(() => guardWith(SECRET).canActivate(bearing(TOKEN)));

      expect(refusal).toBeInstanceOf(DomainError);
    });
  });
});

/**
 * Where the guard is mounted, asserted here rather than in the controller specs.
 *
 * A guard nobody applied is a guard that passes its own unit tests forever, and the two call sites
 * are one line each in files whose reviewers are thinking about status codes. Keeping the assertion
 * beside the guard means deleting either `@UseGuards(TurnstileGuard)` fails the suite the task's
 * own verification command runs.
 */
describe('where TurnstileGuard is applied', () => {
  /**
   * Nest's own key for `@UseGuards`, written out rather than deep-imported from
   * `@nestjs/common/constants` — that path is not part of the package's published surface, and an
   * import of it is a dependency on Nest's file layout rather than on Nest.
   *
   * Writing the key out has one failure mode: a rename in a future Nest makes every read
   * `undefined`. The two positive assertions are what catch that — they fail — which is why they
   * are here rather than only the negative ones, which a wrong key would pass vacuously.
   */
  const GUARDS_METADATA = '__guards__';

  /**
   * The handler is looked up by name rather than passed in as `Controller.prototype.method`, which
   * would be an unbound method reference and is what `@typescript-eslint/unbound-method` exists to
   * refuse. A misspelt name reads no metadata and fails the positive assertions, so the string is
   * checked by the test rather than merely trusted by it.
   */
  const guardsOn = (controller: object, method: string): unknown[] =>
    (Reflect.getMetadata(GUARDS_METADATA, Reflect.get(controller, method) as object) as
      unknown[] | undefined) ?? [];

  it.each([
    ['POST /auth/signup', AuthController.prototype, 'signUp'],
    ['POST /auth/password/reset', PasswordController.prototype, 'requestReset'],
  ])('guards %s', (_route, controller, method) => {
    expect(guardsOn(controller, method)).toContain(TurnstileGuard);
  });

  /**
   * Deliberately *not* on login, logout, verification or the reset confirmation. Login has the
   * two-bucket throttle and a wrong password to get past; the mailed-link routes are reached by
   * somebody who already holds a token we minted. The two guarded routes are the ones that turn an
   * arbitrary typed address into outbound mail, which is what the check is paid for.
   */
  it.each([
    ['POST /auth/login', AuthController.prototype, 'signIn'],
    ['POST /auth/verify', AuthController.prototype, 'verifyEmail'],
    ['POST /auth/password/reset/confirm', PasswordController.prototype, 'confirmReset'],
    ['POST /auth/password/change', PasswordController.prototype, 'changePassword'],
  ])('leaves %s alone', (_route, controller, method) => {
    expect(guardsOn(controller, method)).not.toContain(TurnstileGuard);
  });
});

/** One field of the form body the guard posted, or `null` when it sent no such field. */
function sentField(spy: ReturnType<typeof vi.fn>, name: string): string | null {
  const [, init] = spy.mock.calls[0] as [string, RequestInit];

  return (init.body as URLSearchParams).get(name);
}
