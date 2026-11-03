import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { timestamps } from './columns';
import { syncOperations } from './connectors';
import { users } from './identity';
import { orgs, projects } from './tenancy';

/**
 * How a checkpoint came to be (spec 016, data-model.md § checkpoints). `pull` is spec 018's: a
 * commit fetched from the linked remote, named by the sync operation that brought it. `edit` is
 * spec 024's: a member's hand edit in the web editor, saved as a checkpoint so it lists, diffs,
 * mirrors and reverts through the paths the other four kinds already use.
 */
export const checkpointKind = pgEnum('checkpoint_kind', [
  'baseline',
  'turn',
  'revert',
  'pull',
  'edit',
]);

/** One entry of the stored change summary (research R7). */
export interface CheckpointFile {
  bytes: number;
  path: string;
  status: 'A' | 'M' | 'D' | 'R';
}

/**
 * A commit the platform made on the project's behalf and the immutable history it belongs to
 * (spec 016). `git_sha` is unique per project — R5's idempotency key. `parent_id` is null only on
 * the `baseline`; `run_id`/`turn` name the run and its 1-based turn on a `turn`; `actor_id`/
 * `reverts_id` name the member and the restored checkpoint on a `revert`; `actor_id`/
 * `sync_operation_id` name who asked and which pull on a `pull`; `actor_id` names the member and
 * `run_id` is null on an `edit`, which belongs to nobody's turn — the five CHECKs say exactly
 * that. `run_id` carries no FK: the run is another module's (R4). `mirrored_at` is the one column
 * that ever changes, by grant (`migrations/0018_checkpoints_are_append_only.sql`).
 * `created_at` comes from `ClockPort`; the list orders and paginates by `(created_at, id)`.
 */
export const checkpoints = pgTable(
  'checkpoints',
  {
    actorId: uuid('actor_id').references(() => users.id),
    files: jsonb('files').$type<CheckpointFile[]>().notNull(),
    gitSha: text('git_sha').notNull(),
    id: uuid('id').primaryKey().defaultRandom(),
    kind: checkpointKind('kind').notNull(),
    label: text('label').notNull(),
    mirroredAt: timestamp('mirrored_at', { withTimezone: true }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id'),
    projectId: uuid('project_id').notNull(),
    revertsId: uuid('reverts_id'),
    runId: uuid('run_id'),
    syncOperationId: uuid('sync_operation_id'),
    turn: integer('turn'),
    ...timestamps,
  },
  (table) => [
    unique('checkpoints_org_id_id_key').on(table.orgId, table.id),
    unique('checkpoints_org_id_project_id_git_sha_key').on(
      table.orgId,
      table.projectId,
      table.gitSha,
    ),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.id],
      name: 'checkpoints_org_id_project_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.orgId, table.parentId],
      foreignColumns: [table.orgId, table.id],
      name: 'checkpoints_org_id_parent_id_fk',
    }),
    foreignKey({
      columns: [table.orgId, table.revertsId],
      foreignColumns: [table.orgId, table.id],
      name: 'checkpoints_org_id_reverts_id_fk',
    }),
    foreignKey({
      columns: [table.orgId, table.syncOperationId],
      foreignColumns: [syncOperations.orgId, syncOperations.id],
      name: 'checkpoints_org_id_sync_operation_id_fk',
    }),
    check(
      'checkpoints_baseline_check',
      sql`(${table.kind} = 'baseline') = (${table.parentId} is null)`,
    ),
    check(
      'checkpoints_turn_check',
      sql`(${table.kind} = 'turn') = (${table.runId} is not null and ${table.turn} is not null)`,
    ),
    check(
      'checkpoints_revert_check',
      sql`(${table.kind} = 'revert') = (${table.actorId} is not null and ${table.revertsId} is not null)`,
    ),
    check(
      'checkpoints_pull_check',
      // `::text`, not the enum literal: 0020 adds 'pull' and drizzle-kit runs pending migrations in
      // one transaction, where a freshly added enum value cannot be named (0021 explains).
      sql`(${table.kind}::text = 'pull') = (${table.actorId} is not null and ${table.syncOperationId} is not null)`,
    ),
    check(
      'checkpoints_edit_shape',
      // `::text`, for the reason the `pull` CHECK above gives: 0029 adds 'edit' and drizzle-kit
      // runs pending migrations in one transaction, where a freshly added enum value cannot be
      // named as a literal (0030 carries the rationale). The revert and pull causes are excluded
      // because those kinds also carry an actor and no run (0046 carries the correction).
      sql`(${table.kind}::text = 'edit') = (${table.actorId} is not null and ${table.runId} is null and ${table.revertsId} is null and ${table.syncOperationId} is null)`,
    ),
    index('checkpoints_org_project_created_idx').on(
      table.orgId,
      table.projectId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
  ],
);

export type Checkpoint = typeof checkpoints.$inferSelect;
export type NewCheckpoint = typeof checkpoints.$inferInsert;
