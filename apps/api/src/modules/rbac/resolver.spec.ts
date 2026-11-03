import type { Membership, ProjectGrant } from '@repo/db';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  ORG_ROLE_PERMISSIONS,
  PROJECT_ROLE_PERMISSIONS,
  scoped,
  WORKSPACE_ROLE_PERMISSIONS,
} from './permissions';
import type {
  ResolvableOrg,
  ResolvableUser,
  ResolvedMembership,
  ResolvedProjectGrant,
  ResolvedWorkspaceRole,
} from './resolver';
import { resolve } from './resolver';

const USER: ResolvableUser = { id: randomUUID() };
const OTHER_USER: ResolvableUser = { id: randomUUID() };
const ORG: ResolvableOrg = { deletedAt: null, id: randomUUID() };
const OTHER_ORG: ResolvableOrg = { deletedAt: null, id: randomUUID() };

const WORKSPACE = randomUUID();
const OTHER_WORKSPACE = randomUUID();
const PROJECT = randomUUID();
const OTHER_PROJECT = randomUUID();

function membership(overrides: Partial<ResolvedMembership> = {}): ResolvedMembership {
  return {
    acceptedAt: new Date('2026-01-01T00:00:00Z'),
    orgId: ORG.id,
    role: 'member',
    userId: USER.id,
    ...overrides,
  };
}

function workspaceRole(overrides: Partial<ResolvedWorkspaceRole> = {}): ResolvedWorkspaceRole {
  return {
    orgId: ORG.id,
    role: 'viewer',
    userId: USER.id,
    workspaceId: WORKSPACE,
    ...overrides,
  };
}

function projectGrant(overrides: Partial<ResolvedProjectGrant> = {}): ResolvedProjectGrant {
  return {
    orgId: ORG.id,
    projectId: PROJECT,
    role: 'viewer',
    userId: USER.id,
    ...overrides,
  };
}

describe('resolve', () => {
  it('resolves a user with nothing at all to an empty set', () => {
    expect(resolve(USER, ORG, [], [], [])).toEqual(new Set());
  });

  describe('the org scope', () => {
    it.each(['owner', 'admin', 'member', 'billing'] as const)(
      'expands an accepted %s membership to exactly that role, unqualified',
      (role) => {
        const permissions = resolve(USER, ORG, [membership({ role })], [], []);

        expect(permissions).toEqual(new Set(ORG_ROLE_PERMISSIONS[role]));
      },
    );

    /**
     * An invitation that has been issued but not accepted is not access. `memberships.accepted_at`
     * is nullable precisely so that the pending state is representable, and resolving it as
     * membership would make an unopened invitation a way in.
     */
    it('grants nothing from a membership that has not been accepted', () => {
      const permissions = resolve(
        USER,
        ORG,
        [membership({ acceptedAt: null, role: 'owner' })],
        [],
        [],
      );

      expect(permissions).toEqual(new Set());
    });

    it("ignores another user's membership of the same org", () => {
      const permissions = resolve(
        USER,
        ORG,
        [membership({ role: 'owner', userId: OTHER_USER.id })],
        [],
        [],
      );

      expect(permissions).toEqual(new Set());
    });

    /**
     * The caller passes rows in; a caller that passes too many must not widen the answer. This is
     * the one place a cross-tenant bug would be invisible — the set is cached per `(user, org)` and
     * nothing downstream re-checks which org a slug came from.
     */
    it('ignores a membership of another org', () => {
      const permissions = resolve(
        USER,
        ORG,
        [membership({ orgId: OTHER_ORG.id, role: 'owner' })],
        [],
        [],
      );

      expect(permissions).toEqual(new Set());
    });

    it('resolves the same user differently in two orgs from one set of rows', () => {
      const rows = [
        membership({ role: 'owner' }),
        membership({ orgId: OTHER_ORG.id, role: 'billing' }),
      ];

      expect(resolve(USER, ORG, rows, [], [])).toEqual(new Set(ORG_ROLE_PERMISSIONS.owner));
      expect(resolve(USER, OTHER_ORG, rows, [], [])).toEqual(new Set(ORG_ROLE_PERMISSIONS.billing));
    });
  });

  describe('the workspace scope', () => {
    it.each(['admin', 'editor', 'viewer'] as const)(
      'qualifies a workspace %s with the workspace it applies to',
      (role) => {
        const permissions = resolve(USER, ORG, [membership()], [workspaceRole({ role })], []);

        for (const permission of WORKSPACE_ROLE_PERMISSIONS[role]) {
          expect([...permissions]).toContain(scoped(permission, WORKSPACE));
        }
      },
    );

    it('never grants a workspace permission unqualified', () => {
      const permissions = resolve(
        USER,
        ORG,
        [membership()],
        [workspaceRole({ role: 'admin' })],
        [],
      );

      for (const permission of WORKSPACE_ROLE_PERMISSIONS.admin) {
        expect([...permissions]).not.toContain(permission);
      }
    });

    /** The escalation this qualification exists to prevent: admin here must not mean admin there. */
    it('keeps two workspaces apart', () => {
      const permissions = resolve(
        USER,
        ORG,
        [membership()],
        [
          workspaceRole({ role: 'admin' }),
          workspaceRole({ role: 'viewer', workspaceId: OTHER_WORKSPACE }),
        ],
        [],
      );

      expect([...permissions]).toContain(scoped('workspace:projects.create', WORKSPACE));
      expect([...permissions]).not.toContain(scoped('workspace:projects.create', OTHER_WORKSPACE));
      expect([...permissions]).toContain(scoped('workspace:read', OTHER_WORKSPACE));
    });

    it("ignores another user's workspace role", () => {
      const permissions = resolve(
        USER,
        ORG,
        [membership()],
        [workspaceRole({ role: 'admin', userId: OTHER_USER.id })],
        [],
      );

      expect(permissions).toEqual(new Set(ORG_ROLE_PERMISSIONS.member));
    });

    it('ignores a workspace role belonging to another org', () => {
      const permissions = resolve(
        USER,
        ORG,
        [membership()],
        [workspaceRole({ orgId: OTHER_ORG.id, role: 'admin' })],
        [],
      );

      expect(permissions).toEqual(new Set(ORG_ROLE_PERMISSIONS.member));
    });
  });

  describe('the project scope', () => {
    it.each(['owner', 'editor', 'commenter', 'viewer'] as const)(
      'qualifies a project %s with the project it applies to',
      (role) => {
        const permissions = resolve(USER, ORG, [membership()], [], [projectGrant({ role })]);

        for (const permission of PROJECT_ROLE_PERMISSIONS[role]) {
          expect([...permissions]).toContain(scoped(permission, PROJECT));
        }
      },
    );

    /**
     * Editor of one project, viewer of another. An unqualified flat set would answer "may this user
     * write files?" with yes for both, which is the whole reason entries carry their resource.
     */
    it('does not let a role on one project reach another', () => {
      const permissions = resolve(
        USER,
        ORG,
        [membership()],
        [],
        [
          projectGrant({ role: 'editor' }),
          projectGrant({ projectId: OTHER_PROJECT, role: 'viewer' }),
        ],
      );

      expect([...permissions]).toContain(scoped('project:files.write', PROJECT));
      expect([...permissions]).not.toContain(scoped('project:files.write', OTHER_PROJECT));
      expect([...permissions]).toContain(scoped('project:read', OTHER_PROJECT));
    });

    it("ignores another user's grant", () => {
      const permissions = resolve(
        USER,
        ORG,
        [membership()],
        [],
        [projectGrant({ role: 'owner', userId: OTHER_USER.id })],
      );

      expect(permissions).toEqual(new Set(ORG_ROLE_PERMISSIONS.member));
    });

    it('ignores a grant belonging to another org', () => {
      const permissions = resolve(
        USER,
        ORG,
        [membership()],
        [],
        [projectGrant({ orgId: OTHER_ORG.id, role: 'owner' })],
      );

      expect(permissions).toEqual(new Set(ORG_ROLE_PERMISSIONS.member));
    });
  });

  /**
   * "Three scopes compose" (§11) — the answer is the union of what each scope grants, and nothing
   * cascades. An org owner does not implicitly own every project: §11's table gives the org scope
   * members, billing, connectors, domains, settings and audit export, and nothing else. Inventing
   * an implicit cascade here would grant access the document never describes, and over-granting is
   * the failure mode an authorisation engine cannot afford. T27 gives a creator explicit roles.
   */
  describe('composition', () => {
    it('unions the three scopes', () => {
      const permissions = resolve(
        USER,
        ORG,
        [membership({ role: 'admin' })],
        [workspaceRole({ role: 'editor' })],
        [projectGrant({ role: 'editor' })],
      );

      expect(permissions).toEqual(
        new Set([
          ...ORG_ROLE_PERMISSIONS.admin,
          ...WORKSPACE_ROLE_PERMISSIONS.editor.map((p) => scoped(p, WORKSPACE)),
          ...PROJECT_ROLE_PERMISSIONS.editor.map((p) => scoped(p, PROJECT)),
        ]),
      );
    });

    it('does not let an org owner reach a project it holds no grant on', () => {
      const permissions = resolve(USER, ORG, [membership({ role: 'owner' })], [], []);

      expect([...permissions]).not.toContain(scoped('project:deploy', PROJECT));
      expect([...permissions]).not.toContain('project:deploy');
    });
  });

  /**
   * "An external collaborator with access to named projects only and no visibility into the
   * organisation" (§11). Not a filtered org view — a guest holds no membership row at all, so the
   * org and workspace scopes are not narrowed for them, they are absent.
   */
  describe('a guest', () => {
    it('resolves to project-scoped permissions only', () => {
      const permissions = resolve(USER, ORG, [], [], [projectGrant({ role: 'editor' })]);

      expect(permissions).toEqual(
        new Set(PROJECT_ROLE_PERMISSIONS.editor.map((p) => scoped(p, PROJECT))),
      );
    });

    it('cannot see the organisation exists', () => {
      const permissions = resolve(USER, ORG, [], [], [projectGrant({ role: 'owner' })]);

      for (const permission of ORG_ROLE_PERMISSIONS.member) {
        expect([...permissions]).not.toContain(permission);
      }
    });

    /**
     * A workspace role for someone who is not a member should not exist; if a caller passes one
     * anyway, the resolver fails closed rather than promoting the guest into the workspace scope.
     */
    it('gains nothing from a workspace role it should never have been given', () => {
      const permissions = resolve(
        USER,
        ORG,
        [],
        [workspaceRole({ role: 'admin' })],
        [projectGrant({ role: 'viewer' })],
      );

      expect(permissions).toEqual(new Set([scoped('project:read', PROJECT)]));
    });

    it('is treated as a guest while its membership is still pending', () => {
      const permissions = resolve(
        USER,
        ORG,
        [membership({ acceptedAt: null, role: 'owner' })],
        [workspaceRole({ role: 'admin' })],
        [projectGrant({ role: 'commenter' })],
      );

      expect(permissions).toEqual(
        new Set(PROJECT_ROLE_PERMISSIONS.commenter.map((p) => scoped(p, PROJECT))),
      );
    });
  });

  /**
   * A soft-deleted org is not a tenant anyone acts in. `orgs.deleted_at` exists because a tenant
   * restore is expected (ADR 012), and the window between delete and purge must not be a window in
   * which the last owner can still export the audit trail.
   */
  describe('a soft-deleted org', () => {
    const deleted: ResolvableOrg = { deletedAt: new Date('2026-02-01T00:00:00Z'), id: ORG.id };

    it('grants nothing to its owner', () => {
      expect(resolve(USER, deleted, [membership({ role: 'owner' })], [], [])).toEqual(new Set());
    });

    it('grants nothing to a guest', () => {
      expect(resolve(USER, deleted, [], [], [projectGrant({ role: 'owner' })])).toEqual(new Set());
    });
  });

  /**
   * Purity is the point of T24: the resolver is exhaustively testable only because everything it
   * reads is an argument and nothing it touches survives the call.
   */
  describe('purity', () => {
    it('returns the same answer for the same arguments', () => {
      const args = [
        USER,
        ORG,
        [membership({ role: 'admin' })],
        [workspaceRole({ role: 'admin' })],
        [projectGrant({ role: 'owner' })],
      ] as const;

      expect(resolve(...args)).toEqual(resolve(...args));
    });

    it('leaves its arguments untouched', () => {
      const memberships = [membership({ role: 'owner' })];
      const workspaceRoles = [workspaceRole({ role: 'admin' })];
      const grants = [projectGrant({ role: 'owner' })];
      const before = JSON.stringify({ grants, memberships, workspaceRoles });

      resolve(USER, ORG, memberships, workspaceRoles, grants);

      expect(JSON.stringify({ grants, memberships, workspaceRoles })).toBe(before);
    });

    it('hands out a fresh set each call, so a caller cannot poison the next one', () => {
      const first = resolve(USER, ORG, [membership({ role: 'owner' })], [], []) as Set<string>;

      first.add('org:not-a-real-permission');

      expect([...resolve(USER, ORG, [membership({ role: 'owner' })], [], [])]).not.toContain(
        'org:not-a-real-permission',
      );
    });
  });

  /**
   * The resolver takes plain data, but the data it takes has to be the rows the database actually
   * returns — otherwise T27 would need a mapping layer whose only job is to make this compile.
   */
  describe('accepts the rows the schema produces', () => {
    it('takes a `Membership` row', () => {
      const row: Membership = {
        acceptedAt: new Date('2026-01-01T00:00:00Z'),
        createdAt: new Date('2026-01-01T00:00:00Z'),
        id: randomUUID(),
        invitedBy: null,
        orgId: ORG.id,
        role: 'admin',
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        userId: USER.id,
      };

      expect(resolve(USER, ORG, [row], [], [])).toEqual(new Set(ORG_ROLE_PERMISSIONS.admin));
    });

    it('takes a `ProjectGrant` row', () => {
      const row: ProjectGrant = {
        createdAt: new Date('2026-01-01T00:00:00Z'),
        id: randomUUID(),
        orgId: ORG.id,
        projectId: PROJECT,
        role: 'commenter',
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        userId: USER.id,
      };

      expect(resolve(USER, ORG, [], [], [row])).toEqual(
        new Set(PROJECT_ROLE_PERMISSIONS.commenter.map((p) => scoped(p, PROJECT))),
      );
    });
  });
});
