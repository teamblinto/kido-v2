import { orgRole, projectRole } from '@repo/db';
import { describe, expect, it } from 'vitest';

import {
  GUEST_SCOPES,
  ORG_PERMISSIONS,
  ORG_ROLE_PERMISSIONS,
  PERMISSION_SCOPES,
  PERMISSIONS,
  PROJECT_PERMISSIONS,
  PROJECT_ROLE_PERMISSIONS,
  scopeOf,
  scoped,
  WORKSPACE_PERMISSIONS,
  WORKSPACE_ROLE_PERMISSIONS,
  WORKSPACE_ROLES,
} from './permissions';

/**
 * The catalogue is the single source of truth for permission slugs (T24), so almost every assertion
 * here is a closure property rather than a hard-coded list: "every role expands to slugs this file
 * defines", "every vocabulary matches the enum the schema already fixed". A test that restated the
 * catalogue would only prove the catalogue equals itself.
 */
describe('permission catalogue', () => {
  it('gives every slug a one-line description', () => {
    for (const [slug, description] of Object.entries(PERMISSIONS)) {
      expect(description, slug).toMatch(/^\S.*\.$/);
    }
  });

  it('is the union of the three scoped catalogues, with no slug defined twice', () => {
    const slugs = [
      ...Object.keys(ORG_PERMISSIONS),
      ...Object.keys(WORKSPACE_PERMISSIONS),
      ...Object.keys(PROJECT_PERMISSIONS),
    ];

    expect(new Set(slugs).size).toBe(slugs.length);
    expect(Object.keys(PERMISSIONS).sort()).toEqual([...slugs].sort());
  });

  it('prefixes every slug with the scope that owns it', () => {
    for (const slug of Object.keys(ORG_PERMISSIONS)) {
      expect(scopeOf(slug as keyof typeof ORG_PERMISSIONS)).toBe('org');
    }

    for (const slug of Object.keys(WORKSPACE_PERMISSIONS)) {
      expect(scopeOf(slug as keyof typeof WORKSPACE_PERMISSIONS)).toBe('workspace');
    }

    for (const slug of Object.keys(PROJECT_PERMISSIONS)) {
      expect(scopeOf(slug as keyof typeof PROJECT_PERMISSIONS)).toBe('project');
    }
  });

  it('names slugs in the imperative, so they cannot be confused with audit actions', () => {
    for (const slug of Object.keys(PERMISSIONS)) {
      expect(slug).toMatch(/^(org|workspace|project):[a-z]+(\.[a-z-]+)?$/);
    }
  });

  it('is frozen, so no importer can add a permission at runtime', () => {
    expect(Object.isFrozen(PERMISSIONS)).toBe(true);
    expect(Object.isFrozen(ORG_PERMISSIONS)).toBe(true);
    expect(Object.isFrozen(WORKSPACE_PERMISSIONS)).toBe(true);
    expect(Object.isFrozen(PROJECT_PERMISSIONS)).toBe(true);
  });

  it('lists exactly the three scopes §11 composes', () => {
    expect([...PERMISSION_SCOPES]).toEqual(['org', 'workspace', 'project']);
  });
});

/**
 * §11 fixes three role vocabularies. Two of them are already `pgEnum`s in `packages/db`, so the
 * catalogue is checked against the schema rather than against a second hand-written list — a role
 * that can be stored but not resolved is a row that silently grants nothing.
 */
describe('role vocabularies', () => {
  it('expands exactly the org roles the schema allows', () => {
    expect(Object.keys(ORG_ROLE_PERMISSIONS).sort()).toEqual([...orgRole.enumValues].sort());
  });

  it('expands exactly the project roles the schema allows', () => {
    expect(Object.keys(PROJECT_ROLE_PERMISSIONS).sort()).toEqual(
      [...projectRole.enumValues].sort(),
    );
  });

  it('expands exactly the workspace roles §11 lists', () => {
    expect([...WORKSPACE_ROLES].sort()).toEqual(['admin', 'editor', 'viewer']);
    expect(Object.keys(WORKSPACE_ROLE_PERMISSIONS).sort()).toEqual([...WORKSPACE_ROLES].sort());
  });
});

describe('role expansions', () => {
  const expansions = [
    ['org', ORG_ROLE_PERMISSIONS, ORG_PERMISSIONS],
    ['workspace', WORKSPACE_ROLE_PERMISSIONS, WORKSPACE_PERMISSIONS],
    ['project', PROJECT_ROLE_PERMISSIONS, PROJECT_PERMISSIONS],
  ] as const;

  it.each(expansions)('expands %s roles only to slugs the catalogue defines', (_, roles, own) => {
    for (const [role, granted] of Object.entries<readonly string[]>(roles)) {
      for (const permission of granted) {
        expect(Object.keys(own), `${role} → ${permission}`).toContain(permission);
      }
    }
  });

  it.each(expansions)('grants no %s permission twice within one role', (_, roles) => {
    for (const [role, granted] of Object.entries<readonly string[]>(roles)) {
      expect(new Set(granted).size, role).toBe(granted.length);
    }
  });

  it.each(expansions)('leaves no %s permission unreachable by every role', (_, roles, own) => {
    const reachable = new Set(Object.values<readonly string[]>(roles).flat());

    expect([...Object.keys(own)].sort()).toEqual([...reachable].sort());
  });

  /**
   * The ladders inside a scope are strictly nested: a higher role can do everything the one below
   * it can. `billing` is deliberately not on the org ladder — see below.
   */
  it.each([
    ['org', ORG_ROLE_PERMISSIONS.member, ORG_ROLE_PERMISSIONS.admin],
    ['org', ORG_ROLE_PERMISSIONS.admin, ORG_ROLE_PERMISSIONS.owner],
    ['workspace', WORKSPACE_ROLE_PERMISSIONS.viewer, WORKSPACE_ROLE_PERMISSIONS.editor],
    ['workspace', WORKSPACE_ROLE_PERMISSIONS.editor, WORKSPACE_ROLE_PERMISSIONS.admin],
    ['project', PROJECT_ROLE_PERMISSIONS.viewer, PROJECT_ROLE_PERMISSIONS.commenter],
    ['project', PROJECT_ROLE_PERMISSIONS.commenter, PROJECT_ROLE_PERMISSIONS.editor],
    ['project', PROJECT_ROLE_PERMISSIONS.editor, PROJECT_ROLE_PERMISSIONS.owner],
  ] as const)('keeps the %s ladder nested', (_, lower, higher) => {
    expect([...higher]).toEqual(expect.arrayContaining([...lower]));
  });

  /**
   * §11 makes `billing` a role of its own rather than a rung above `member`. If `admin` also
   * managed billing the role would be decorative, and the org ladder above would quietly become a
   * four-rung one.
   */
  it('keeps billing a role of its own rather than a rung on the admin ladder', () => {
    expect([...ORG_ROLE_PERMISSIONS.billing]).toContain('org:billing.manage');
    expect([...ORG_ROLE_PERMISSIONS.admin]).not.toContain('org:billing.manage');
    expect([...ORG_ROLE_PERMISSIONS.owner]).toEqual(expect.arrayContaining(['org:billing.manage']));
  });

  /** Every member of an org can at least see it exists; that is what makes the guest rule sharp. */
  it.each([...orgRole.enumValues])('lets an org %s see the organisation', (role) => {
    expect([...ORG_ROLE_PERMISSIONS[role]]).toContain('org:read');
  });
});

/**
 * "A guest is an external collaborator with access to named projects only and no visibility into
 * the organisation" (§11). The catalogue states the scopes a guest may draw from; `resolver.spec`
 * proves the resolver honours it.
 */
describe('guest scope', () => {
  it('draws from the project scope only', () => {
    expect([...GUEST_SCOPES]).toEqual(['project']);
  });

  it('reaches no slug that would reveal the organisation', () => {
    const reachable = Object.values<readonly string[]>(PROJECT_ROLE_PERMISSIONS).flat();

    for (const permission of reachable) {
      expect([...GUEST_SCOPES], permission).toContain(
        scopeOf(permission as keyof typeof PROJECT_PERMISSIONS),
      );
    }
  });
});

/**
 * Workspace and project permissions are meaningless without the resource they apply to: a flat set
 * holding a bare `project:files.write` would let an editor of one project write to every other one.
 */
describe('scoped', () => {
  it('qualifies a permission with the resource it applies to', () => {
    expect(scoped('project:deploy', 'p-1')).toBe('project:deploy@p-1');
    expect(scoped('workspace:read', 'w-1')).toBe('workspace:read@w-1');
  });

  it('distinguishes the same permission on two resources', () => {
    expect(scoped('project:deploy', 'p-1')).not.toBe(scoped('project:deploy', 'p-2'));
  });

  it('refuses an empty resource id', () => {
    expect(() => scoped('project:deploy', '')).toThrow(/resource id/i);
  });

  it('refuses a resource id containing the delimiter', () => {
    expect(() => scoped('project:deploy', 'p@1')).toThrow(/resource id/i);
  });
});
