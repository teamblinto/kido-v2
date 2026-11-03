import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { citext, timestamps } from './columns';
import { users } from './identity';
import { orgRole, orgs, projectRole, projects } from './tenancy';

/**
 * RBAC has no catalogue tables by design: §11's three role vocabularies are the enums in
 * `./tenancy`, and the permission set each role expands to is code in the resolver (T24), not rows.
 * What is left is the one row-shaped part of it — a role granted to someone who is not a member yet.
 *
 * An invitation is tenant-owned: it is issued by an organisation, names one of that organisation's
 * roles, and is exactly the kind of thing a cross-tenant read must not reach. It grants access, so
 * it carries no `deleted_at` (ADR 012) — a revoked invitation is stamped, and a stamped row is what
 * the partial unique index below reads.
 *
 * `token_hash` is a SHA-256 digest, and it is globally unique rather than unique per organisation
 * because it is looked up by itself. That lookup happens under RLS like every other read, which
 * means the accept route has to establish a tenant context before it runs; the invitation link
 * therefore carries the organisation id alongside the token. The id is not the secret — the token
 * is — and this keeps acceptance inside the policy rather than around it. See
 * `docs/adr/015-account-scoped-auth-tables-are-roots.md`.
 */
export const invitations = pgTable(
  'invitations',
  {
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    email: citext('email').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    id: uuid('id').primaryKey().defaultRandom(),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    role: orgRole('role').notNull(),
    tokenHash: text('token_hash').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('invitations_org_id_id_key').on(table.orgId, table.id),
    uniqueIndex('invitations_token_hash_key').on(table.tokenHash),
    // One open invitation per address per organisation. Success criterion 10 wants a repeated
    // invite to be idempotent; this makes the second one a conflict the service can resolve to the
    // first, rather than two links that both work.
    uniqueIndex('invitations_org_id_email_open_key')
      .on(table.orgId, table.email)
      .where(sql`${table.acceptedAt} is null and ${table.revokedAt} is null`),
    index('invitations_org_id_email_idx').on(table.orgId, table.email),
  ],
);

export type Invitation = typeof invitations.$inferSelect;
export type NewInvitation = typeof invitations.$inferInsert;

/**
 * Spec 031 (research R5, data-model § 2): an invitation to one project, for an address that need
 * not be a member of the organisation.
 *
 * Why a table of its own rather than a widening of `invitations`: an `invitations` row names an
 * *organisation* role and its acceptance creates a membership, with every consequence
 * `MembershipService` attaches to one. This row names a *project* role and its acceptance creates a
 * `project_grants` row and nothing else. Folding both into one table would make `role` two
 * vocabularies in one column, `project_id` a nullable that decides which, and every reader of
 * `invitations` one forgotten `where project_id is null` away from turning a project invitation into
 * membership. Two tables keep each acceptance path unable to produce the other's effect.
 *
 * Otherwise it mirrors `invitations`: tenant-owned, no `deleted_at` (it grants access, ADR 012),
 * withdrawn and accepted are stamps, one open row per address per project, and a globally unique
 * token digest.
 */
export const projectInvitations = pgTable(
  'project_invitations',
  {
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedBy: uuid('accepted_by').references(() => users.id, { onDelete: 'set null' }),
    email: citext('email').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    id: uuid('id').primaryKey().defaultRandom(),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    role: projectRole('role').notNull(),
    tokenHash: text('token_hash').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('project_invitations_org_id_id_key').on(table.orgId, table.id),
    uniqueIndex('project_invitations_token_hash_key').on(table.tokenHash),
    // The spec's "invited twice" edge case: a second invite resolves to the first, never two links.
    uniqueIndex('project_invitations_open_key')
      .on(table.orgId, table.projectId, table.email)
      .where(sql`${table.acceptedAt} is null and ${table.revokedAt} is null`),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.id],
      name: 'project_invitations_org_id_project_id_fk',
    }).onDelete('cascade'),
    check(
      'project_invitations_accepted_or_revoked_check',
      sql`not (${table.acceptedAt} is not null and ${table.revokedAt} is not null)`,
    ),
  ],
);

export type ProjectInvitation = typeof projectInvitations.$inferSelect;
export type NewProjectInvitation = typeof projectInvitations.$inferInsert;
