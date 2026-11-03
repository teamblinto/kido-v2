import { sql } from 'drizzle-orm';
import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { timestamps } from './columns';
import { orgs, projects } from './tenancy';

/**
 * The project's sandbox (spec 010, amended by 014's lifecycle, data-model.md). One row per project
 * and one project per Daytona sandbox, both said as unique constraints rather than application
 * checks. `pooled` stays declared but is never written here — a pool entry is a `sandbox_pool`
 * row — and `archived` is refused by a CHECK until spec 016 (FR-013).
 */
export const sandboxState = pgEnum('sandbox_state', [
  'pooled',
  'active',
  'idle',
  'hibernated',
  'archived',
]);

/** The in-flight provider op on a row; null when settled. Paired with `transition_since` (CHECK). */
export const sandboxTransition = pgEnum('sandbox_transition', [
  'creating',
  'resuming',
  'hibernating',
  'releasing',
]);

/**
 * `daytona_id` is the vendor's id and is the one thing the port never takes: callers address a
 * sandbox by `(org_id, project_id)` and this row is where the two vocabularies meet.
 * `workspace_root` is the daemon's work dir and the root every path is jailed to — null until the
 * daemon answers `work-dir`, which needs the sandbox `started`. `state_entered_at` is the sweep's
 * clock for `idle → hibernated`; `last_seen_at` the one for `active → idle`. `lost_at` is set by
 * the reconciler when Daytona no longer knows the id — a lost row is "no sandbox" to the port.
 * `failure_reason` is the last dead-lettered op, cleared by the next success. `snapshot_key` stays
 * null until 016. No `deleted_at`: the row is not a container of user data.
 * Invariants live as CHECKs in `migrations/0014_sandbox_pool_grants.sql`.
 */
export const sandboxes = pgTable(
  'sandboxes',
  {
    daytonaId: text('daytona_id').notNull(),
    failureReason: text('failure_reason'),
    hibernatedAt: timestamp('hibernated_at', { withTimezone: true }),
    id: uuid('id').primaryKey().defaultRandom(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    lostAt: timestamp('lost_at', { withTimezone: true }),
    node: text('node'),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    ports: jsonb('ports').notNull().default({}),
    projectId: uuid('project_id').notNull(),
    snapshotKey: text('snapshot_key'),
    state: sandboxState('state').notNull().default('active'),
    stateEnteredAt: timestamp('state_entered_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * The `template_versions.snapshot` this sandbox was created from (spec 015): copied from the
     * pool row on claim or the current version on a cold create; null = unknown (hand-registered,
     * pre-015). Informational — nothing branches on it.
     */
    templateSnapshot: text('template_snapshot'),
    transition: sandboxTransition('transition'),
    transitionSince: timestamp('transition_since', { withTimezone: true }),
    workspaceRoot: text('workspace_root'),
    ...timestamps,
  },
  (table) => [
    unique('sandboxes_org_id_id_key').on(table.orgId, table.id),
    unique('sandboxes_org_id_project_id_key').on(table.orgId, table.projectId),
    unique('sandboxes_daytona_id_key').on(table.daytonaId),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.id],
      name: 'sandboxes_org_id_project_id_fk',
    }).onDelete('cascade'),
  ],
);

export const sandboxPoolState = pgEnum('sandbox_pool_state', ['creating', 'ready', 'releasing']);

/**
 * The warm pool (spec 014, data-model.md § sandbox_pool). A **platform** table: a pool entry
 * belongs to no tenant until the claim transaction deletes it here and inserts it into
 * `sandboxes`, so there is no `org_id` and no policy. `template` is one of `PROJECT_TEMPLATES`,
 * checked at the application boundary rather than by a CHECK 015 would have to rewrite.
 * `workspace_root` and `node` are filled at readiness and copied on claim; `ready_at` orders the
 * surplus release oldest-first. Grants in `migrations/0014_sandbox_pool_grants.sql`.
 */
export const sandboxPool = pgTable(
  'sandbox_pool',
  {
    daytonaId: text('daytona_id').notNull().unique(),
    failureReason: text('failure_reason'),
    id: uuid('id').primaryKey().defaultRandom(),
    node: text('node'),
    readyAt: timestamp('ready_at', { withTimezone: true }),
    snapshot: text('snapshot').notNull(),
    state: sandboxPoolState('state').notNull().default('creating'),
    template: text('template').notNull(),
    workspaceRoot: text('workspace_root'),
    ...timestamps,
  },
  (table) => [
    // The claim fallback (`where template and state = 'ready' order by ready_at`) and the refill's
    // count per template both walk this.
    index('sandbox_pool_template_state_ready_at_idx').on(
      table.template,
      table.state,
      table.readyAt,
    ),
  ],
);

/**
 * Per-template pool depth (data-model.md § sandbox_pool_settings), written only by the
 * `sandbox:pool` command. An absent row means the environment default. The refill creates from
 * the template's current `template_versions` row, never from a setting (spec 015 dropped
 * `snapshot`). Platform table, four verbs for forge_app.
 */
export const sandboxPoolSettings = pgTable('sandbox_pool_settings', {
  targetDepth: integer('target_depth').notNull(),
  template: text('template').primaryKey(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

export const templateVersionState = pgEnum('template_version_state', [
  'building',
  'ready',
  'failed',
  'retired',
]);

/**
 * A built image of a template definition (spec 015, data-model.md § template_versions). Platform
 * table: no `org_id`, no policy — a version belongs to the catalogue, not a tenant. `(template,
 * digest)` is the identity; `snapshot` is the provider name `forge-tpl-<template>-<digest[0:12]>`
 * that `sandbox_pool.snapshot` and `sandboxes.template_snapshot` copy. At most one `current`
 * row per template (partial unique index); `current ⇒ ready` and `failed ⇒ failure_reason` are
 * CHECKs in `migrations/0016_template_versions_grants.sql`. `created_at` is reset on every
 * takeover to `building` — it is the stale-building clock.
 */
export const templateVersions = pgTable(
  'template_versions',
  {
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    current: boolean('current').notNull().default(false),
    digest: text('digest').notNull(),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    failureReason: text('failure_reason'),
    readyAt: timestamp('ready_at', { withTimezone: true }),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    snapshot: text('snapshot').notNull(),
    state: templateVersionState('state').notNull().default('building'),
    template: text('template').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.template, table.digest], name: 'template_versions_pk' }),
    unique('template_versions_snapshot_key').on(table.snapshot),
    uniqueIndex('template_versions_current_idx')
      .on(table.template)
      .where(sql`${table.current}`),
  ],
);

export type Sandbox = typeof sandboxes.$inferSelect;
export type NewSandbox = typeof sandboxes.$inferInsert;
export type SandboxPoolEntry = typeof sandboxPool.$inferSelect;
export type NewSandboxPoolEntry = typeof sandboxPool.$inferInsert;
export type SandboxPoolSetting = typeof sandboxPoolSettings.$inferSelect;
export type NewSandboxPoolSetting = typeof sandboxPoolSettings.$inferInsert;
export type TemplateVersion = typeof templateVersions.$inferSelect;
export type NewTemplateVersion = typeof templateVersions.$inferInsert;
