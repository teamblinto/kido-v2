import {
  bigint,
  boolean,
  foreignKey,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { restorableTimestamps, timestamps } from './columns';
import { users } from './identity';

/**
 * The role vocabularies are fixed by §11 ("Three scopes compose"). The permission *catalogue* that
 * maps a role to a flat permission set is the RBAC module's job, not the schema's — this enum only
 * stops a typo becoming a row.
 */
export const orgRole = pgEnum('org_role', ['owner', 'admin', 'member', 'billing']);
export const projectRole = pgEnum('project_role', ['owner', 'editor', 'commenter', 'viewer']);
/**
 * The third of the three, arriving with T27 exactly where `permissions.ts` said it would: that file
 * held `WORKSPACE_ROLES` in TypeScript "until the schema catches up, and gains a `pgEnum` beside
 * `orgRole` and `projectRole` when it does". `WORKSPACE_ROLES` is now derived from this.
 */
export const workspaceRole = pgEnum('workspace_role', ['admin', 'editor', 'viewer']);
/**
 * Who besides the project's own members can reach a preview without a grant (017 §11 gateway
 * routing). `private` is the default: existing rows take it with no backfill, so a project written
 * before this feature is the most restrictive it can be.
 */
export const previewVisibility = pgEnum('preview_visibility', ['private', 'org', 'public']);

/**
 * The tenant root. `orgs` is what `org_id` points at, so it does not carry one itself; its own `id`
 * is the tenant identifier. Deleting an org is the one delete that legitimately cascades over a
 * tenant's data, which is why every child below hangs off it with `on delete cascade`.
 */
export const orgs = pgTable(
  'orgs',
  {
    // Retired with platform credits: archived, never read or written. Kept rather than dropped so
    // the balances it holds are not destroyed by a migration.
    creditBalance: bigint('credit_balance', { mode: 'number' }).notNull().default(0),
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** Spec 032 (Q3): whether members may run on their own linked subscriptions. */
    personalAccountsAllowed: boolean('personal_accounts_allowed').notNull().default(true),
    plan: text('plan').notNull().default('free'),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    slug: text('slug').notNull(),
    ...restorableTimestamps,
  },
  (table) => [uniqueIndex('orgs_slug_key').on(table.slug)],
);

/**
 * The user-to-tenant edge, and the only table that legitimately joins a root to a tenant. It is
 * tenant-owned — it carries `org_id` and is subject to RLS — but its `user_id` FK is single-column
 * on purpose: `users` is a root and has no `org_id` to compose with.
 *
 * No `deleted_at`: removing a member must revoke access instantly (§11), and a soft-deleted
 * membership is a row that one forgotten `WHERE deleted_at IS NULL` turns back into access.
 */
export const memberships = pgTable(
  'memberships',
  {
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    id: uuid('id').primaryKey().defaultRandom(),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    role: orgRole('role').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (table) => [
    unique('memberships_org_id_id_key').on(table.orgId, table.id),
    unique('memberships_org_id_user_id_key').on(table.orgId, table.userId),
    index('memberships_user_id_idx').on(table.userId),
  ],
);

export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    ...restorableTimestamps,
  },
  (table) => [unique('workspaces_org_id_id_key').on(table.orgId, table.id)],
);

/**
 * A user's role *within one workspace* — §11's middle scope (T27).
 *
 * Separate from `memberships` rather than a column on it, because the two answer different
 * questions and one row cannot hold both: a person belongs to an organisation once, and to as many
 * of its workspaces as they have been given a role in, at a different role in each. That is what
 * makes "an org member of the wrong role cannot read another workspace" expressible at all.
 *
 * Like `memberships` and `project_grants` it grants access, so it is hard-deleted rather than
 * soft-deleted (ADR 017): removing someone from a workspace must take effect at once, and a
 * soft-deleted row is one forgotten `WHERE deleted_at IS NULL` away from still being access.
 *
 * The foreign key to `workspaces` is composite on `(org_id, workspace_id)` for the reason §09
 * gives: a single-column reference is checked with RLS bypassed, so a row pointing at another
 * tenant's workspace could be created and then merely hidden. Composite makes it unrepresentable.
 */
export const workspaceMembers = pgTable(
  'workspace_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    role: workspaceRole('role').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('workspace_members_org_id_id_key').on(table.orgId, table.id),
    unique('workspace_members_org_id_workspace_id_user_id_key').on(
      table.orgId,
      table.workspaceId,
      table.userId,
    ),
    foreignKey({
      columns: [table.orgId, table.workspaceId],
      foreignColumns: [workspaces.orgId, workspaces.id],
      name: 'workspace_members_org_id_workspace_id_fk',
    }).onDelete('cascade'),
    // The resolver loads every workspace role a user holds in one organisation, on every cache
    // miss. This is that query's index.
    index('workspace_members_org_id_user_id_idx').on(table.orgId, table.userId),
  ],
);

/**
 * `preview_label` is globally unique and indexed because the route broker resolves a preview
 * hostname by it on every gateway cache miss (Appendix A).
 */
export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    previewLabel: text('preview_label').notNull(),
    previewVisibility: previewVisibility('preview_visibility').notNull().default('private'),
    repoKey: text('repo_key'),
    template: text('template'),
    workspaceId: uuid('workspace_id').notNull(),
    ...restorableTimestamps,
  },
  (table) => [
    unique('projects_org_id_id_key').on(table.orgId, table.id),
    uniqueIndex('projects_preview_label_key').on(table.previewLabel),
    foreignKey({
      columns: [table.orgId, table.workspaceId],
      foreignColumns: [workspaces.orgId, workspaces.id],
      name: 'projects_org_id_workspace_id_fk',
    }).onDelete('cascade'),
    index('projects_org_id_workspace_id_idx').on(table.orgId, table.workspaceId),
  ],
);

/**
 * Per-project access for someone who is not a member of the organisation — the "guest" scope in
 * §11. Like `memberships` it grants access, so it is hard-deleted rather than soft-deleted.
 */
export const projectGrants = pgTable(
  'project_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').notNull(),
    role: projectRole('role').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (table) => [
    unique('project_grants_org_id_id_key').on(table.orgId, table.id),
    unique('project_grants_org_id_project_id_user_id_key').on(
      table.orgId,
      table.projectId,
      table.userId,
    ),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.id],
      name: 'project_grants_org_id_project_id_fk',
    }).onDelete('cascade'),
    index('project_grants_org_id_user_id_idx').on(table.orgId, table.userId),
  ],
);

export type Membership = typeof memberships.$inferSelect;
export type NewMembership = typeof memberships.$inferInsert;
export type Org = typeof orgs.$inferSelect;
export type NewOrg = typeof orgs.$inferInsert;
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type ProjectGrant = typeof projectGrants.$inferSelect;
export type NewProjectGrant = typeof projectGrants.$inferInsert;
export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type NewWorkspaceMember = typeof workspaceMembers.$inferInsert;
