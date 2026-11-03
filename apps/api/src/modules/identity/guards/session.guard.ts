import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';

import type { Environment } from '../../../config/environment';
import { IS_PUBLIC } from '../decorators/public.decorator';
import { type CookieBearingRequest, readSessionCookie } from '../session-cookie';
import { AUTHENTICATED_USER, SessionService } from '../services/session.service';

/**
 * One message for both ways of failing. "You sent no cookie" and "the cookie you sent is not a
 * session" differ only in information the caller already has, and answering them differently gives
 * anyone sorting responses a signal for free.
 */
const REJECTION = 'Authentication is required for this request.';

/**
 * The guard every route gets unless it says otherwise.
 *
 * Registered as an `APP_GUARD` in `IdentityModule`, which makes authentication the default and
 * `@Public()` the exception. The other order — a guard each controller opts into — fails silently:
 * the route that forgot is open, and nothing about it looks wrong in review.
 *
 * There is no Passport strategy behind this (ADR 002). Reading a cookie, hashing it and looking it
 * up is the whole of the work, and a strategy would add a second lifecycle, a second place session
 * state can be configured, and a `req.user` contract that fights the symbol this guard uses.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  private readonly cookieName: string;

  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    config: ConfigService<Environment, true>,
  ) {
    this.cookieName = config.get('SESSION_COOKIE_NAME', { infer: true });
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Handler first, then class: a `@Public()` controller with one guarded route is not a shape
    // that exists yet, but `getAllAndOverride` is the lookup that would express it, and the
    // opposite order would silently ignore a handler-level opt-out on a closed controller.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic === true) {
      return true;
    }

    const request = context.switchToHttp().getRequest<CookieBearingRequest>();
    const token = readSessionCookie(request, this.cookieName);

    if (token === undefined) {
      throw new UnauthorizedException(REJECTION);
    }

    const user = await this.sessions.authenticate(token);

    // A session that still owes its second factor is refused exactly as a dead one is (T21,
    // criterion 4), and that is what makes the challenge a factor rather than a dialog: the
    // password leg does set a real cookie, so without this a client that ignored the
    // `mfa_required` body and carried on would simply be signed in everywhere. The only route that
    // reads one of these is the challenge itself, which is `@Public()` and reads the cookie
    // directly rather than asking this guard to make an exception.
    if (user === null || user.pendingMfa) {
      throw new UnauthorizedException(REJECTION);
    }

    (request as Record<PropertyKey, unknown>)[AUTHENTICATED_USER] = user;

    return true;
  }
}
