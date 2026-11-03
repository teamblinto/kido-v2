import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';

import type { Environment } from '../../../config/environment';
import { Public } from '../decorators/public.decorator';
import {
  AUTHENTICATED_USER,
  type AuthenticatedUser,
  type SessionService,
} from '../services/session.service';
import { SessionGuard } from './session.guard';

const COOKIE_NAME = '__Host-forge_session';

/** The guard reads one key, so a one-key configuration is the whole of what it needs. */
function configWith(name: string): ConfigService<Environment, true> {
  return new ConfigService({ SESSION_COOKIE_NAME: name }) as unknown as ConfigService<
    Environment,
    true
  >;
}

const TOKEN = 'RUv0m4Bx0d1Wl6vN3cQeSg9pYkT2sZaHc1oJqXrLtUw';

const USER: AuthenticatedUser = {
  createdAt: '2026-08-16T10:00:00.000Z',
  lastSeenAt: '2026-08-16T10:00:00.000Z',
  pendingMfa: false,
  sessionId: 'a'.repeat(64),
  steppedUpAt: null,
  userId: '3f1d1f6e-2a1f-4d3c-9a4e-9c2e0d5b7a11',
};

/** The same principal, on the half-authenticated session a sign-in with MFA stops at (T21). */
const AWAITING_FACTOR: AuthenticatedUser = { ...USER, pendingMfa: true };

class ClosedController {
  closed(this: void): string {
    return 'closed';
  }
}

class OpenController {
  @Public()
  open(this: void): string {
    return 'open';
  }
}

function guardFor(authenticate: (token: string) => Promise<AuthenticatedUser | null>): {
  guard: SessionGuard;
  calls: string[];
} {
  const calls: string[] = [];
  const sessions = {
    authenticate: async (token: string) => {
      calls.push(token);

      return authenticate(token);
    },
  } as unknown as SessionService;

  return { calls, guard: new SessionGuard(new Reflector(), sessions, configWith(COOKIE_NAME)) };
}

function contextFor(request: object, controller: object, handler: () => string): ExecutionContext {
  return {
    getClass: () => controller,
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

const closed = (request: object): ExecutionContext =>
  contextFor(request, ClosedController, ClosedController.prototype.closed);

const open = (request: object): ExecutionContext =>
  contextFor(request, OpenController, OpenController.prototype.open);

describe('SessionGuard', () => {
  it('authenticates a request carrying a live session cookie', async () => {
    const { guard } = guardFor(() => Promise.resolve(USER));
    const request = { cookies: { [COOKIE_NAME]: TOKEN } };

    await expect(guard.canActivate(closed(request))).resolves.toBe(true);
  });

  it('attaches the principal so @CurrentUser can find it', async () => {
    const { guard } = guardFor(() => Promise.resolve(USER));
    const request: Record<PropertyKey, unknown> = { cookies: { [COOKIE_NAME]: TOKEN } };

    await guard.canActivate(closed(request));

    expect(request[AUTHENTICATED_USER]).toEqual(USER);
  });

  it('rejects a request with no session cookie', async () => {
    const { guard } = guardFor(() => Promise.resolve(USER));

    await expect(guard.canActivate(closed({ cookies: {} }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a cookie that no longer resolves to a session', async () => {
    const { guard } = guardFor(() => Promise.resolve(null));

    await expect(
      guard.canActivate(closed({ cookies: { [COOKIE_NAME]: TOKEN } })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  /**
   * "No cookie" and "a cookie that is not a session" are the same 401 with the same words. The
   * difference between them is information about the caller's own state that the caller already
   * has, and keeping the two answers identical means one less shape for an attacker to sort by.
   */
  /**
   * The load-bearing half of criterion 4. The password leg sets a real cookie, so without this the
   * challenge would be advisory: a caller who simply ignored the `mfa_required` body and carried on
   * would be authenticated everywhere, and MFA would be a dialog rather than a factor.
   */
  it('rejects a session that still owes its second factor', async () => {
    const { guard } = guardFor(() => Promise.resolve(AWAITING_FACTOR));

    await expect(
      guard.canActivate(closed({ cookies: { [COOKIE_NAME]: TOKEN } })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  /** And leaves nothing behind for a handler to read as a principal. */
  it('attaches no principal for a session that owes a factor', async () => {
    const { guard } = guardFor(() => Promise.resolve(AWAITING_FACTOR));
    const request: Record<PropertyKey, unknown> = { cookies: { [COOKIE_NAME]: TOKEN } };

    await guard.canActivate(closed(request)).catch(() => undefined);

    expect(request[AUTHENTICATED_USER]).toBeUndefined();
  });

  /**
   * Told apart from a dead cookie only by the caller's own state, which they already know. A
   * distinct message here would say "this address has MFA" to anyone holding a stolen password.
   */
  it('answers a pending session exactly as it answers a stale cookie', async () => {
    const { guard: withPending } = guardFor(() => Promise.resolve(AWAITING_FACTOR));
    const { guard: withStale } = guardFor(() => Promise.resolve(null));

    const [pending, stale] = await Promise.all([
      withPending
        .canActivate(closed({ cookies: { [COOKIE_NAME]: TOKEN } }))
        .catch((error: UnauthorizedException) => error.getResponse()),
      withStale
        .canActivate(closed({ cookies: { [COOKIE_NAME]: TOKEN } }))
        .catch((error: UnauthorizedException) => error.getResponse()),
    ]);

    expect(pending).toEqual(stale);
  });

  it('answers a missing and a stale cookie identically', async () => {
    const { guard: withoutCookie } = guardFor(() => Promise.resolve(USER));
    const { guard: withStale } = guardFor(() => Promise.resolve(null));

    const [absent, stale] = await Promise.all([
      withoutCookie
        .canActivate(closed({ cookies: {} }))
        .catch((error: UnauthorizedException) => error.getResponse()),
      withStale
        .canActivate(closed({ cookies: { [COOKIE_NAME]: TOKEN } }))
        .catch((error: UnauthorizedException) => error.getResponse()),
    ]);

    expect(absent).toEqual(stale);
  });

  it('lets a @Public() handler through without a cookie', async () => {
    const { calls, guard } = guardFor(() => Promise.resolve(USER));

    await expect(guard.canActivate(open({ cookies: {} }))).resolves.toBe(true);
    expect(calls).toEqual([]);
  });

  /**
   * A public route that happens to carry a cookie must not cost a Redis round trip: `@Public()` is
   * the opt-out, and health probes run on every container every few seconds.
   */
  it('does not touch Redis on a @Public() handler that carries a cookie anyway', async () => {
    const { calls, guard } = guardFor(() => Promise.resolve(USER));

    await guard.canActivate(open({ cookies: { [COOKIE_NAME]: TOKEN } }));

    expect(calls).toEqual([]);
  });

  it('looks the token up exactly as it arrived', async () => {
    const { calls, guard } = guardFor(() => Promise.resolve(USER));

    await guard.canActivate(closed({ cookies: { [COOKIE_NAME]: TOKEN } }));

    expect(calls).toEqual([TOKEN]);
  });

  /** `cookie-parser` has not run, or the request never had a cookie header at all. */
  it('rejects a request nothing parsed cookies for', async () => {
    const { guard } = guardFor(() => Promise.resolve(USER));

    await expect(guard.canActivate(closed({}))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('reads the cookie name from configuration rather than assuming it', async () => {
    const authenticate = vi.fn().mockResolvedValue(USER);
    const sessions = { authenticate } as unknown as SessionService;
    const guard = new SessionGuard(new Reflector(), sessions, configWith('__Host-other_name'));

    await guard.canActivate(closed({ cookies: { '__Host-other_name': TOKEN } }));

    expect(authenticate).toHaveBeenCalledWith(TOKEN);
  });
});
