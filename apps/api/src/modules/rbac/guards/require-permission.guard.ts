import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { DomainError } from '../../../common/errors/domain-error';
import {
  AUTHENTICATED_USER,
  type AuthenticatedUser,
} from '../../identity/services/session.service';
import {
  REQUIRED_PERMISSION,
  type PermissionRequirement,
} from '../decorators/require-permission.decorator';
import { PermissionResolutionService } from '../permission-resolution.service';
import type { PermissionEntry, WorkspacePermission, ProjectPermission } from '../permissions';
import { scoped } from '../permissions';
import { ResourceOrgResolver } from '../resource-org.resolver';

/**
 * One sentence, and it names the remedy without naming anything else.
 *
 * Every way of failing this guard collapses to this string: no permission, no principal, an
 * unregistered route, a missing path parameter, an organisation that does not exist. They differ
 * only in information the caller is not entitled to — whether the resource exists, whether the
 * organisation does, which permission would have worked — and answering them differently would hand
 * anybody sorting responses an oracle for free.
 */
const REJECTION = 'You do not have permission to perform this action.';

/**
 * The permission check failed (§11, criterion 11).
 *
 * A `403` refinement rather than a status of its own, exactly as `StepUpRequiredError` is. The
 * difference between the two matters to a client and to nobody else: `step-up-required` says retry
 * after proving a second factor, and this one says retrying will not help.
 */
export class PermissionDeniedError extends DomainError {
  constructor() {
    super('permission-denied', REJECTION);
  }
}

/**
 * The first of §11's three layers: "a `@RequirePermission('project:deploy')` guard on the route, an
 * explicit check inside the service for anything the guard cannot express, and RLS underneath
 * both."
 *
 * The three are independent and each is sufficient to deny, which is the property that makes the
 * arrangement worth its cost — a bug here is caught by the service check, a bug in both is caught by
 * the database, and two independent mistakes are needed before a row crosses a tenant boundary. This
 * layer is the cheapest of the three: it refuses before the handler, before the request's
 * transaction is opened and before a single tenant-owned row is read.
 *
 * Registered as an `APP_GUARD` in `RbacModule`, after `IdentityModule`'s two, because it reads the
 * principal `SessionGuard` resolves. `rbac.module.spec.ts` asserts that ordering, so a reordering
 * of `AppModule`'s imports fails a test rather than quietly turning every guarded route into a 403.
 *
 * ## Fail closed, and the two ways it does
 *
 * A route that carries `@RequirePermission()` but has not registered a `@ResourceOrg()` is
 * **refused**, not admitted and not checked against something else. There is no fallback: not the
 * caller's only membership, not a header, not a body field. The resolution service is not even
 * consulted, because there is no organisation to consult it about.
 *
 * That is the single most important line in this file. The tempting alternative — "if the route did
 * not say, use what the client sent" — is precisely the design §11 forbids, and it fails in the
 * quietest possible way: every route keeps working, the tests keep passing, and the only thing that
 * changes is that the organisation a permission is checked in becomes something an attacker can
 * choose. A route whose author forgot to think about tenancy must break loudly on its first request
 * instead.
 *
 * The second way is narrower and follows from the first: a scoped permission whose qualifying path
 * parameter is absent is refused rather than matched against the bare slug. `project:deploy` in a
 * resolved set is always `project:deploy@{project_id}` (T24's `scoped()`), so a bare match would
 * mean "may deploy *some* project" and would be read here as "may deploy this one".
 */
@Injectable()
export class RequirePermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly orgs: ResourceOrgResolver,
    private readonly permissions: PermissionResolutionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Handler first, then class, so a controller can demand one permission throughout and a single
    // route can demand something else.
    const requirement = this.reflector.getAllAndOverride<PermissionRequirement | undefined>(
      REQUIRED_PERMISSION,
      [context.getHandler(), context.getClass()],
    );

    // Not every route is this guard's to refuse. Authentication is `SessionGuard`'s default and is
    // already settled by the time this runs; a route that demands no *permission* is one this guard
    // has no opinion about, which is what keeps `@Public()` routes and the account-scoped identity
    // flows — signup, login, password reset — reachable without an organisation existing at all.
    if (requirement === undefined) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{
      params?: Record<string, string | undefined>;
      [AUTHENTICATED_USER]?: AuthenticatedUser;
    }>();
    const caller = request[AUTHENTICATED_USER];

    // `SessionGuard` throws rather than admitting an unauthenticated request, so reaching here with
    // no principal means this guard is running somewhere it was not expected to — a `@Public()`
    // route that also demands a permission, or a reordering of the `APP_GUARD`s. Both are bugs, and
    // both are refused rather than assumed benign.
    if (caller === undefined) {
      throw new PermissionDeniedError();
    }

    const scope = this.orgs.resolve(context);

    if (scope === null) {
      throw new PermissionDeniedError();
    }

    const required = this.entryFor(requirement, request.params);

    if (required === null) {
      throw new PermissionDeniedError();
    }

    const held = await this.permissions.for(scope.orgId, caller.userId);

    if (!held.has(required)) {
      throw new PermissionDeniedError();
    }

    return true;
  }

  /**
   * The entry that must be present in the resolved set, rebuilt from the route.
   *
   * `null` means the route could not name one — a scoped permission whose qualifying parameter is
   * missing or empty — and the caller of this method turns that into the same denial as any other.
   */
  private entryFor(
    requirement: PermissionRequirement,
    params: Record<string, string | undefined> | undefined,
  ): PermissionEntry | null {
    if (requirement.param === null) {
      return requirement.permission;
    }

    const resourceId = params?.[requirement.param];

    if (resourceId === undefined || resourceId.length === 0) {
      return null;
    }

    // `scoped()` throws on a resource id containing the delimiter it uses. A path segment could
    // carry one, and an exception escaping a guard would be a 500 where the honest answer is the
    // ordinary denial — the caller named something that cannot be a resource id, so no set contains
    // a permission for it.
    try {
      return scoped(requirement.permission as ProjectPermission | WorkspacePermission, resourceId);
    } catch {
      return null;
    }
  }
}
