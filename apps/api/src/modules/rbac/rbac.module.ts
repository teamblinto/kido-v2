import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { RequirePermissionGuard } from './guards/require-permission.guard';
import { PermissionCache } from './permission-cache';
import { PermissionResolutionService } from './permission-resolution.service';
import { ResourceOrgResolver } from './resource-org.resolver';

/**
 * The policy engine (§11, T24–T26).
 *
 * `permissions.ts` and `resolver.ts` are still absent from the provider list, and for the original
 * reason: a catalogue and a pure function have nothing to inject, and wrapping either in a service
 * so that it could be listed here would give it a constructor whose only purpose is to make it
 * injectable, and with it the option of a dependency the resolver is defined by not having.
 *
 * What T26 adds is the enforcement path: {@link ResourceOrgResolver} answers which organisation a
 * request is for, {@link PermissionResolutionService} answers what the caller may do in it, and
 * {@link RequirePermissionGuard} puts the two together in front of every decorated route.
 *
 * `ResourceOrgResolver` is *also* bound to `TENANT_SCOPE_RESOLVER` in `DatabaseModule`, which is how
 * the same derivation drives the tenant transaction. Both bindings name this one class deliberately:
 * the guard and the interceptor read the same route metadata and the same path, so the organisation
 * a permission is checked in cannot differ from the organisation the handler's queries run in. Two
 * implementations of that derivation would be two places for it to drift.
 *
 * `RequirePermissionGuard` is an `APP_GUARD` rather than something each controller applies, which
 * keeps the decision in one place and the demand declarative at the route. It is a no-op on any
 * route carrying no `@RequirePermission()`, so making it application-wide costs an undecorated route
 * one metadata lookup — and means a controller cannot forget to attach it.
 *
 * Not `@Global`, unlike `RedisModule` and `AuditModule`. `AppModule` imports this after
 * `IdentityModule`, and `rbac.module.spec.ts` asserts that order, because this guard reads the
 * principal `SessionGuard` resolves. `OrgCache` arrives from the global `RedisModule` and
 * `TenantTransactionRunner` from the global `DatabaseModule`.
 */
@Module({
  exports: [PermissionCache, PermissionResolutionService, ResourceOrgResolver],
  providers: [
    PermissionCache,
    PermissionResolutionService,
    ResourceOrgResolver,
    { provide: APP_GUARD, useClass: RequirePermissionGuard },
  ],
})
export class RbacModule {}
