import { SetMetadata } from '@nestjs/common';

/**
 * The metadata key `SessionGuard` reads. A symbol rather than a string for the reason
 * `redis.constants.ts` gives: this is metadata attached to handlers written across every module
 * from here on, and a string key collides silently with any other decorator that picked the same
 * word — a collision that would read as "this route is public".
 */
export const IS_PUBLIC = Symbol('forge.identity.public');

/**
 * Opt a handler, or a whole controller, out of `SessionGuard`.
 *
 * The guard is registered as an `APP_GUARD`, so authentication is the default and this is the only
 * way out of it. That direction is deliberate: a route that forgets to declare itself is closed,
 * and the failure mode of forgetting is a 401 somebody reports rather than an endpoint nobody
 * noticed was open.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);
