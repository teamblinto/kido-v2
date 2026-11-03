import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  AUTHENTICATED_USER,
  type AuthenticatedUser,
} from '../../identity/services/session.service';
import { RequirePermission } from '../decorators/require-permission.decorator';
import type { PermissionEntry } from '../permissions';
import { scoped } from '../permissions';
import type { PermissionResolutionService } from '../permission-resolution.service';
import { ResourceOrg, ResourceOrgResolver } from '../resource-org.resolver';
import { PermissionDeniedError, RequirePermissionGuard } from './require-permission.guard';

const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const PROJECT = randomUUID();
const OTHER_PROJECT = randomUUID();
const USER = randomUUID();

@ResourceOrg()
class GuardedController {
  @RequirePermission('project:deploy')
  deploy(this: void): string {
    return 'deployed';
  }

  @RequirePermission('org:settings.update')
  updateSettings(this: void): string {
    return 'updated';
  }

  open(this: void): string {
    return 'open';
  }
}

/**
 * The same demands, on a controller nobody registered a resource→org resolver for. Every handler
 * here must be refused however complete the caller's permissions are.
 */
class UnregisteredController {
  @RequirePermission('org:settings.update')
  updateSettings(this: void): string {
    return 'updated';
  }
}

interface RequestShape {
  readonly headers?: Record<string, string>;
  readonly params?: Record<string, string>;
  [AUTHENTICATED_USER]?: AuthenticatedUser;
}

function principal(): AuthenticatedUser {
  return {
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    pendingMfa: false,
    sessionId: 'a-hash',
    steppedUpAt: null,
    userId: USER,
  };
}

/**
 * A stand-in for the database-backed resolution, so these tests are about the guard's decision
 * rather than about Drizzle. It records what it was asked, which is how the "never consulted"
 * assertions below are made rather than inferred.
 */
class ScriptedPermissions {
  readonly asked: { orgId: string; userId: string }[] = [];

  constructor(private readonly sets: Readonly<Record<string, readonly PermissionEntry[]>>) {}

  for(orgId: string, userId: string): Promise<ReadonlySet<PermissionEntry>> {
    this.asked.push({ orgId, userId });

    return Promise.resolve(new Set(this.sets[orgId] ?? []));
  }
}

function guardWith(permissions: ScriptedPermissions): RequirePermissionGuard {
  const reflector = new Reflector();

  return new RequirePermissionGuard(
    reflector,
    new ResourceOrgResolver(reflector),
    permissions as unknown as PermissionResolutionService,
  );
}

function contextFor(
  target: object,
  handler: (this: void) => string,
  request: RequestShape,
): ExecutionContext {
  return {
    getClass: () => target,
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('RequirePermissionGuard', () => {
  describe('a route that demands nothing', () => {
    it('is not this guard’s to refuse', async () => {
      const guard = guardWith(new ScriptedPermissions({}));

      await expect(
        guard.canActivate(
          contextFor(GuardedController, GuardedController.prototype.open, {
            params: { orgId: ORG },
          }),
        ),
      ).resolves.toBe(true);
    });
  });

  describe('an org-scoped demand', () => {
    it('admits a caller whose resolved set holds the permission', async () => {
      const guard = guardWith(new ScriptedPermissions({ [ORG]: ['org:settings.update'] }));

      await expect(
        guard.canActivate(
          contextFor(GuardedController, GuardedController.prototype.updateSettings, {
            params: { orgId: ORG },
            [AUTHENTICATED_USER]: principal(),
          }),
        ),
      ).resolves.toBe(true);
    });

    it('refuses a caller whose resolved set does not', async () => {
      const guard = guardWith(new ScriptedPermissions({ [ORG]: ['org:read'] }));

      await expect(
        guard.canActivate(
          contextFor(GuardedController, GuardedController.prototype.updateSettings, {
            params: { orgId: ORG },
            [AUTHENTICATED_USER]: principal(),
          }),
        ),
      ).rejects.toThrow(PermissionDeniedError);
    });

    it('refuses a request that reached it with no principal', async () => {
      const guard = guardWith(new ScriptedPermissions({ [ORG]: ['org:settings.update'] }));

      await expect(
        guard.canActivate(
          contextFor(GuardedController, GuardedController.prototype.updateSettings, {
            params: { orgId: ORG },
          }),
        ),
      ).rejects.toThrow(PermissionDeniedError);
    });
  });

  describe('a scoped demand', () => {
    /**
     * The reason `scoped()` exists (T24). Editor of one project and nothing in another is the
     * commonest arrangement there is, and a guard that matched the bare slug would read the first
     * as write access to both.
     */
    it('refuses the same permission held for a different project', async () => {
      const guard = guardWith(
        new ScriptedPermissions({ [ORG]: [scoped('project:deploy', OTHER_PROJECT)] }),
      );

      await expect(
        guard.canActivate(
          contextFor(GuardedController, GuardedController.prototype.deploy, {
            params: { orgId: ORG, projectId: PROJECT },
            [AUTHENTICATED_USER]: principal(),
          }),
        ),
      ).rejects.toThrow(PermissionDeniedError);
    });

    it('admits the permission held for the project the route names', async () => {
      const guard = guardWith(
        new ScriptedPermissions({ [ORG]: [scoped('project:deploy', PROJECT)] }),
      );

      await expect(
        guard.canActivate(
          contextFor(GuardedController, GuardedController.prototype.deploy, {
            params: { orgId: ORG, projectId: PROJECT },
            [AUTHENTICATED_USER]: principal(),
          }),
        ),
      ).resolves.toBe(true);
    });

    /**
     * `scoped()` refuses a resource id containing the delimiter it uses to separate a permission
     * from its resource, because such an id would make an entry ambiguous. A path segment can carry
     * one, and an exception escaping a guard would be a 500 where the honest answer is the ordinary
     * denial — the caller named something that cannot be a resource id, so no set holds a permission
     * for it.
     */
    it('refuses an id that could not be a resource id, rather than throwing', async () => {
      const guard = guardWith(
        new ScriptedPermissions({ [ORG]: [scoped('project:deploy', PROJECT)] }),
      );

      await expect(
        guard.canActivate(
          contextFor(GuardedController, GuardedController.prototype.deploy, {
            params: { orgId: ORG, projectId: `${PROJECT}@${OTHER_PROJECT}` },
            [AUTHENTICATED_USER]: principal(),
          }),
        ),
      ).rejects.toThrow(PermissionDeniedError);
    });

    it('refuses when the route did not carry the id the permission is qualified with', async () => {
      const guard = guardWith(
        new ScriptedPermissions({ [ORG]: [scoped('project:deploy', PROJECT)] }),
      );

      await expect(
        guard.canActivate(
          contextFor(GuardedController, GuardedController.prototype.deploy, {
            params: { orgId: ORG },
            [AUTHENTICATED_USER]: principal(),
          }),
        ),
      ).rejects.toThrow(PermissionDeniedError);
    });
  });

  /**
   * **The fail-closed proof.** The caller holds the permission in every organisation there is; the
   * only thing missing is the route's registration of where its organisation comes from. It is
   * refused — and the resolution service is never even asked, because there is no organisation to
   * ask it about. A fallback to a request-supplied org would show up here as `true`.
   */
  describe('a route with no registered resource→org resolver', () => {
    it('refuses, however complete the caller’s permissions are', async () => {
      const permissions = new ScriptedPermissions({
        [ORG]: ['org:settings.update'],
        [OTHER_ORG]: ['org:settings.update'],
      });
      const guard = guardWith(permissions);

      await expect(
        guard.canActivate(
          contextFor(UnregisteredController, UnregisteredController.prototype.updateSettings, {
            headers: { 'x-org-id': ORG },
            params: { orgId: ORG },
            [AUTHENTICATED_USER]: principal(),
          }),
        ),
      ).rejects.toThrow(PermissionDeniedError);

      expect(permissions.asked).toEqual([]);
    });
  });

  /**
   * The forged-header property, at the layer that decides. The caller is an owner of `ORG` and of
   * nothing else; the route names `OTHER_ORG`; the header claims `ORG`. The permission set consulted
   * is `OTHER_ORG`'s — the route's — so the header buys nothing, and the recorded question proves it
   * was never even asked about the organisation the header named.
   */
  describe('a forged organisation header', () => {
    it('does not decide which organisation the permission is checked in', async () => {
      const permissions = new ScriptedPermissions({ [ORG]: ['org:settings.update'] });
      const guard = guardWith(permissions);

      await expect(
        guard.canActivate(
          contextFor(GuardedController, GuardedController.prototype.updateSettings, {
            headers: { 'x-org-id': ORG },
            params: { orgId: OTHER_ORG },
            [AUTHENTICATED_USER]: principal(),
          }),
        ),
      ).rejects.toThrow(PermissionDeniedError);

      expect(permissions.asked).toEqual([{ orgId: OTHER_ORG, userId: USER }]);
    });
  });

  describe('the denial itself', () => {
    it('is a 403 carrying a stable problem type', () => {
      const denial = new PermissionDeniedError();

      expect(denial.status).toBe(403);
      expect(denial.type).toBe('permission-denied');
    });

    /**
     * One sentence, the same one every time, carrying nothing about what was refused. A caller who
     * may not read a project must not learn from the refusal which permission would have let them,
     * which resource it was checked against, or that the organisation in the path exists at all —
     * and a `detail` that varied would be that oracle even with the status held constant.
     */
    it('says the same thing about every denial, and names no resource', () => {
      const one = new PermissionDeniedError();
      const another = new PermissionDeniedError();

      expect(one.detail).toBe(another.detail);
      expect(one.detail).not.toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
      );
      expect(one.extensions).toEqual({});
    });
  });
});
