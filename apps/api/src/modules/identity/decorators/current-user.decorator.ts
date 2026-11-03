import type { ExecutionContext } from '@nestjs/common';
import { createParamDecorator } from '@nestjs/common';

import { AUTHENTICATED_USER, type AuthenticatedUser } from '../services/session.service';

/**
 * The decorator's whole body, exported so it can be tested as a function.
 *
 * A `createParamDecorator` factory is otherwise reachable only through the route-args metadata
 * Nest stores on the controller, and a test that digs that out is testing Nest rather than this.
 */
export function currentUserFromContext(context: ExecutionContext): AuthenticatedUser | undefined {
  const request = context.switchToHttp().getRequest<Record<PropertyKey, unknown>>();

  return request[AUTHENTICATED_USER] as AuthenticatedUser | undefined;
}

/**
 * The principal `SessionGuard` resolved for this request.
 *
 * On any handler the guard actually guards this is always present — the guard throws rather than
 * letting an unauthenticated request reach a controller. It is optional in the type because a
 * `@Public()` handler may still ask, and "nobody is signed in" is a real answer there.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser | undefined =>
    currentUserFromContext(context),
);
