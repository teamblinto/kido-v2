import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import { REQUIRED_PERMISSION, RequirePermission } from './require-permission.decorator';

class ProjectController {
  @RequirePermission('project:deploy')
  deploy(this: void): string {
    return 'deployed';
  }

  @RequirePermission('project:read', { param: 'id' })
  read(this: void): string {
    return 'read';
  }

  unguarded(this: void): string {
    return 'open';
  }
}

class OrgController {
  @RequirePermission('org:members.invite')
  invite(this: void): string {
    return 'invited';
  }
}

@RequirePermission('workspace:read')
class WorkspaceController {
  list(this: void): string {
    return 'listed';
  }
}

describe('@RequirePermission()', () => {
  const reflector = new Reflector();

  it('marks the handler with the permission it demands', () => {
    expect(reflector.get(REQUIRED_PERMISSION, ProjectController.prototype.deploy)).toEqual({
      param: 'projectId',
      permission: 'project:deploy',
    });
  });

  /**
   * A resolved set is flat and covers a whole org, so a project permission in it is qualified with
   * the project it applies to (`scoped()`, T24). The guard therefore has to know which route
   * parameter carries that id, and the scope prefix answers it for every route that names the
   * parameter the way the rest of the application does.
   */
  it('derives the qualifying parameter from the scope of the slug', () => {
    expect(reflector.get(REQUIRED_PERMISSION, WorkspaceController)).toEqual({
      param: 'workspaceId',
      permission: 'workspace:read',
    });
  });

  /**
   * An org permission is bare in the resolved set — the set already belongs to exactly one org — so
   * there is nothing to qualify it with and no parameter to read.
   */
  it('asks for no parameter on an org-scoped permission', () => {
    expect(reflector.get(REQUIRED_PERMISSION, OrgController.prototype.invite)).toEqual({
      param: null,
      permission: 'org:members.invite',
    });
  });

  it('lets a route that names the parameter differently say so', () => {
    expect(reflector.get(REQUIRED_PERMISSION, ProjectController.prototype.read)).toEqual({
      param: 'id',
      permission: 'project:read',
    });
  });

  /**
   * The default is "no demand", which is what makes the guard's fail-closed behaviour meaningful:
   * a route says what it needs, and a route that says nothing is not silently granted anything —
   * it is simply not a route this guard is the gate for. Authentication is still `SessionGuard`'s.
   */
  it('leaves an undecorated handler alone', () => {
    expect(
      reflector.get(REQUIRED_PERMISSION, ProjectController.prototype.unguarded),
    ).toBeUndefined();
  });
});
