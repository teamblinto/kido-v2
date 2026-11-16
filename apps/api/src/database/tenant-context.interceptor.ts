import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Observable } from 'rxjs';
import { firstValueFrom, from } from 'rxjs';

import { OWNS_TENANT_TRANSACTION, TENANT_SCOPE_RESOLVER } from './database.constants';
import type { TenantScope, TenantScopeResolver } from './database.types';
import { TenantTransactionRunner } from './tenant-transaction';

/**
 * The resolver every request gets until something knows better.
 *
 * Answering `null` means the request runs with no tenant transaction, and therefore sees zero rows
 * from every tenant-owned table. That is the correct default: §11 requires the org to be derived
 * from the resource being touched, and a resolver that cannot do that must decline rather than
 * reach for a header. T15 and T26 replace this provider; nothing else has to change.
 */
@Injectable()
export class NoTenantScopeResolver implements TenantScopeResolver {
  resolve(): Promise<TenantScope | null> {
    return Promise.resolve(null);
  }
}

/** See `OWNS_TENANT_TRANSACTION`: this handler opens its own tenant transaction. */
export const OwnsTenantTransaction = (): MethodDecorator =>
  SetMetadata(OWNS_TENANT_TRANSACTION, true);

/**
 * One request, one tenant transaction.
 *
 * The alternative — every repository method opening its own transaction and setting its own
 * context — is worse in three ways that matter here. A request would span several transactions, so
 * a mutation could commit while the audit row it belongs to rolled back. Each repository would be
 * the place where "which org?" is answered, which is the same answer written in fifty places and
 * wrong in one of them. And a method written without the ceremony would silently query outside a
 * tenant transaction, which is not an error — it is zero rows and a confused afternoon.
 *
 * Doing it in an interceptor puts the transaction boundary where the request boundary already is,
 * and makes forgetting it impossible rather than merely discouraged. ADR 005 carries the trade.
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(
    @Inject(TenantTransactionRunner) private readonly transactions: TenantTransactionRunner,
    @Inject(TENANT_SCOPE_RESOLVER) private readonly resolver: TenantScopeResolver,
    @Inject(Reflector) private readonly reflector: Reflector = new Reflector(),
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return from(this.handle(context, next));
  }

  private async handle(context: ExecutionContext, next: CallHandler): Promise<unknown> {
    const scope = await this.resolver.resolve(context);

    if (
      scope === null ||
      this.reflector.get(OWNS_TENANT_TRANSACTION, context.getHandler()) === true
    ) {
      return firstValueFrom(next.handle());
    }

    // `next.handle()` runs the route handler on subscribe, and the subscribe happens inside both
    // the transaction and the async context — so the handler, and everything it awaits, reads the
    // same tenant and writes through the same transaction.
    //
    // `runInTenantScope` also drains the after-commit queue once that transaction has committed,
    // which is where T27's cache invalidation and session revocation run. It lives there rather
    // than here because `OrgService.create` needs the same three pieces composed the same way, and
    // the one ordering that matters — Postgres commits, then Redis — should be written once.
    return this.transactions.runInTenantScope(scope, () => firstValueFrom(next.handle()));
  }
}
