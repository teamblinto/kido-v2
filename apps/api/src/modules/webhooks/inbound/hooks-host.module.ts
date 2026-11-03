import type { MiddlewareConsumer, NestModule } from '@nestjs/common';
import { Module, RequestMethod } from '@nestjs/common';

import { HooksHostMiddleware } from './hooks-host.middleware';

/**
 * The hooks origin's middleware (contracts/hooks-origin.md § API), in a module of its own so
 * `AppModule` can resolve it ahead of `CsrfModule`.
 *
 * Middleware runs in the order the modules registering it are resolved. Registered from
 * `WebhooksModule`, it ran after the CSRF check, so an unsafe request to a product path on
 * `HOOKS_HOST` was answered with the CSRF 403 rather than the unknown-route 404 the contract
 * requires — and the difference told a probe the path existed behind the host. On every route,
 * because the refusal it makes on `HOOKS_HOST` is of every path that is not an inbound one.
 */
@Module({ providers: [HooksHostMiddleware] })
export class HooksHostModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(HooksHostMiddleware).forRoutes({ method: RequestMethod.ALL, path: '*splat' });
  }
}
