import { SetMetadata } from '@nestjs/common';

import type { Permission } from '../permissions';
import { scopeOf } from '../permissions';

/**
 * The metadata key `RequirePermissionGuard` reads. A symbol rather than a string, for the reason
 * `public.decorator.ts` and `step-up.decorator.ts` both give: this is metadata attached to handlers
 * across every feature module written from here on, and a string key collides silently with any
 * other decorator that picked the same word. A collision on *this* key would read as a route
 * demanding a permission it does not, or none at all.
 */
export const REQUIRED_PERMISSION = Symbol('forge.rbac.requiredPermission');

/** What one route demands, as the guard needs it. */
export interface PermissionRequirement {
  /**
   * The route parameter carrying the id a workspace- or project-scoped permission is qualified
   * with, or `null` for an org-scoped one, which needs no qualifier — a resolved set already
   * belongs to exactly one organisation.
   */
  readonly param: string | null;
  readonly permission: Permission;
}

/** Where each scope's qualifying id is found unless the route says otherwise. */
const PARAM_BY_SCOPE = Object.freeze({
  org: null,
  project: 'projectId',
  workspace: 'workspaceId',
} as const satisfies Readonly<Record<ReturnType<typeof scopeOf>, string | null>>);

/**
 * Demand a permission before the handler runs (§11, criterion 11).
 *
 * §11's first layer: "a `@RequirePermission('project:deploy')` guard on the route, an explicit
 * check inside the service for anything the guard cannot express, and RLS underneath both". Each of
 * the three denies independently, and this is the cheapest of them — it refuses before the handler,
 * the transaction and the query.
 *
 * The argument is a {@link Permission} rather than a string, so a slug the catalogue does not
 * publish is a compile error here rather than a value that reaches production and quietly never
 * matches anything in a resolved set. That is the whole reason `permissions.ts` is a closed
 * catalogue.
 *
 * ## What it does *not* say
 *
 * It does not say which organisation to check in. That is deliberate and is the §11 rule this
 * module exists to enforce: the organisation is derived from the resource being touched, by the
 * separately-registered `@ResourceOrg()` (`resource-org.resolver.ts`), and a route that has not
 * registered one is refused rather than checked against something a client supplied. Folding the
 * two decorators into one would make that failure impossible to express — a route would always
 * carry both, and "forgot to say where the org comes from" would stop being a state the guard can
 * see and fail closed on.
 *
 * ## The qualifying parameter
 *
 * A resolved set is flat and covers a whole organisation, so workspace and project entries are
 * qualified with their resource — `project:deploy@{project_id}` (T24's `scoped()`). The guard has
 * to rebuild that entry from the request, which means knowing which route parameter carries the id.
 * The scope prefix answers it by convention for every route that names its parameters the way the
 * rest of the application does, and {@link RequirePermissionOptions.param} is there for one that
 * does not. There is no "match the bare slug" fallback: editor of one project and viewer of another
 * is the commonest arrangement there is, and a bare match would read the first as write access to
 * both.
 *
 * Applicable to a whole controller as well as a handler, because a controller usually demands one
 * thing throughout and per-handler marking is how one handler gets missed.
 */
export const RequirePermission = (
  permission: Permission,
  options: RequirePermissionOptions = {},
): MethodDecorator & ClassDecorator =>
  SetMetadata<symbol, PermissionRequirement>(REQUIRED_PERMISSION, {
    param: options.param ?? PARAM_BY_SCOPE[scopeOf(permission)],
    permission,
  });

export interface RequirePermissionOptions {
  /** Override the route parameter the qualifying resource id is read from. */
  readonly param?: string;
}
