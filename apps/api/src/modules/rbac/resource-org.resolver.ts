import type { ExecutionContext } from '@nestjs/common';
import { Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { TenantScope, TenantScopeResolver } from '../../database/database.types';
import { AUTHENTICATED_USER, type AuthenticatedUser } from '../identity/services/session.service';

/**
 * The shape Postgres accepts for `uuid`, matching `tenant-transaction.ts`. A value that is not one
 * is declined here rather than sent, so a malformed path segment becomes an ordinary denial instead
 * of an `InvalidTenantIdError` surfacing as a 500 that quotes the value back.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The metadata key {@link ResourceOrgResolver} reads. A symbol, as every other route key here is. */
export const RESOURCE_ORG = Symbol('forge.rbac.resourceOrg');

/** How one route names the resource whose organisation the request belongs to. */
export interface ResourceOrgSource {
  /** The route parameter carrying that resource's identifier. */
  readonly param: string;
}

/**
 * Register where this route's organisation is derived from (§11).
 *
 * §11 is categorical: "A permission never depends on data the client supplied — the organisation is
 * derived from the resource being touched, never from a header or a body field." This decorator is
 * how a route says which resource that is, and it is the *only* input {@link ResourceOrgResolver}
 * has.
 *
 * ## Why a route parameter is not "data the client supplied"
 *
 * It is worth being precise, because the path is client-supplied text like any other. What §11
 * forbids is an organisation that travels *beside* the resource, where the two can disagree: with
 * an `X-Org-Id` header, a caller can touch a project belonging to one organisation while the
 * permission check runs against another, and the breach is that divergence. A path parameter cannot
 * diverge from the resource because it *is* the resource's identifier — every tenant-owned route in
 * this application is mounted under `/orgs/:orgId/…`, so the organisation named is the organisation
 * the request acts in.
 *
 * Naming a different organisation therefore buys nothing. The permission set is resolved for
 * `(caller, that organisation)`, and a caller with no membership there resolves to the empty set;
 * the tenant transaction is opened on that organisation, so RLS shows the request that tenant's
 * rows and no others; and the composite `(org_id, id)` foreign keys (§09) make a nested resource
 * that belongs to some *other* organisation unrepresentable rather than merely hidden. All three
 * layers agree on one organisation because all three read this one value.
 *
 * That is also why `orgs` itself carries no RLS policy and needs none: `orgs.id` is the tenant
 * identifier rather than a reference to one, so there is nothing for a policy to compare.
 *
 * ## Not defaulted
 *
 * A route that does not carry this gets no tenant transaction and is refused by the guard. That is
 * the fail-closed half of the design and it is why this is a decorator rather than a convention
 * inferred from the path: an inference would silently succeed on a route whose author never thought
 * about tenancy, and the failure mode of guessing wrong here is a cross-tenant read.
 */
export const ResourceOrg = (param = 'orgId'): MethodDecorator & ClassDecorator =>
  SetMetadata<symbol, ResourceOrgSource>(RESOURCE_ORG, { param });

/**
 * Answers "which tenant is this request for?" from the resource the route names, and from nothing
 * else (T26).
 *
 * This is the provider `database.constants.ts` reserved: "T15 teaches it to read the session and T26
 * to derive the org from the resource being touched, which is the only derivation §11 allows." It
 * replaces `NoTenantScopeResolver`, whose answer — no tenant, therefore zero rows — remains the
 * answer for every route that has registered nothing.
 *
 * It is read twice per request and deliberately does no I/O, which is what makes that free. Nest
 * runs guards before interceptors, so `RequirePermissionGuard` asks first, to decide *whether* the
 * request may proceed, and `TenantContextInterceptor` asks second, to open the transaction the
 * handler runs in. Both get the same answer from the same route metadata and the same path, so
 * there is no window in which the organisation the permission was checked against differs from the
 * organisation the query runs in — and no cached decision to invalidate, because there is nothing
 * to cache.
 *
 * ## The things it does not read
 *
 * Headers. The body. The query string. The session's own memberships. Only `request.params`, and
 * only the one parameter the route registered. `resource-org.resolver.spec.ts` presents an
 * organisation in all four of the other shapes at once and asserts the answer is still the route's;
 * that test is the property §11 asks for, held down where it could break.
 */
@Injectable()
export class ResourceOrgResolver implements TenantScopeResolver {
  /**
   * The token is named rather than left to `design:paramtypes`, for the reason `permission-cache.ts`
   * gives about its own constructor: the metadata the transpiler emits wraps the class reference in
   * a guard no test can take, which shows up as the single uncovered branch in a module whose point
   * is that it has none.
   */
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  /**
   * The tenant this request is for, or `null` for "none" — which is a real and frequent answer.
   * `@Public()` routes, everything account-scoped (signup, login, password reset) and every route
   * that has not registered a source all get it, and all of them see zero rows from every
   * tenant-owned table as a result.
   */
  resolve(context: ExecutionContext): TenantScope | null {
    // Handler first, then class, so a controller can register once for all of its routes and one
    // route can override it.
    const source = this.reflector.getAllAndOverride<ResourceOrgSource | undefined>(RESOURCE_ORG, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (source === undefined) {
      return null;
    }

    const request = context.switchToHttp().getRequest<{
      params?: Record<string, string | undefined>;
      [AUTHENTICATED_USER]?: AuthenticatedUser;
    }>();
    const orgId = request.params?.[source.param];

    if (orgId === undefined || !UUID.test(orgId)) {
      return null;
    }

    return { orgId, userId: request[AUTHENTICATED_USER]?.userId ?? null };
  }
}
