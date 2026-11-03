import { sql } from 'drizzle-orm';
import {
  bigint,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  type PgTableExtraConfigValue,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { timestamps } from './columns';
import { users } from './identity';
import { orgs, projects } from './tenancy';

/**
 * The agent run as a durable job (spec 008, data-model.md). Two conventional tenant-owned tables
 * here — `agent_runs` and `run_messages`, both `unique (org_id, id)` with composite foreign keys —
 * and the *typing* of a third, `run_events`, whose DDL lives in
 * `migrations/0011_run_events_partitioned.sql` because it is partitioned (ADR 032).
 */

/** The states of `docs/specs/008-agent-run-lifecycle/data-model.md` § State machine. */
export const runStatus = pgEnum('run_status', [
  'queued',
  'starting',
  'running',
  'awaiting_input',
  'tool_error',
  'paused',
  'cancelled',
  'failed',
  'succeeded',
]);

export const runFailureClass = pgEnum('run_failure_class', [
  'executor',
  'tool_error',
  'stalled',
  'cancelled_by_system',
  'internal',
  // Spec 020: a BYOK attempt that ended on a provider 401 or an exhausted 429 (research R7).
  'credential',
]);

export const runMessageRole = pgEnum('run_message_role', ['user', 'assistant', 'tool']);

/**
 * What paid for a run. `PLATFORM` (platform credits) is retired and never written; it stays in the
 * enum, and as `agent_runs`' column default, so runs paid with credits still read — dropping an
 * enum value or changing the default would be a migration for no reader. Run create stamps
 * `BYOK` or `BYOS` explicitly.
 */
export const credentialMode = pgEnum('credential_mode', ['PLATFORM', 'BYOK', 'BYOS']);

/** Spec 021 (research R7): one entry per turn whose context step was skipped, and why. */
export interface ContextSkip {
  kind: 'summary';
  reason: string;
  turn: number;
}

/**
 * One run. `next_seq` is the per-run event counter (research R3) and `lease_*` the fence a worker
 * writes under: every claim and every reaper pass bumps `lease_epoch`, and a worker whose epoch is
 * stale finds its writes refused rather than interleaved. `lease_owner` is diagnostics only.
 */
export const agentRuns = pgTable(
  'agent_runs',
  {
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' }).notNull().default(0),
    cacheWriteTokens: bigint('cache_write_tokens', { mode: 'number' }).notNull().default(0),
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
    contextSkips: jsonb('context_skips').$type<ContextSkip[]>().notNull().default([]),
    costMicros: bigint('cost_micros', { mode: 'number' }).notNull().default(0),
    // Spec 032 A3: `organisation` when the starter asked for the organisation's credential while
    // their subscription was limited; the executor honours it only while still limited (drift D8).
    credentialChoice: text('credential_choice', { enum: ['organisation'] }),
    credentialMode: credentialMode('credential_mode').notNull().default('PLATFORM'),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    failureClass: runFailureClass('failure_class'),
    id: uuid('id').primaryKey().defaultRandom(),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    leaseEpoch: integer('lease_epoch').notNull().default(0),
    leaseOwner: text('lease_owner'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    model: text('model').notNull(),
    nextSeq: integer('next_seq').notNull().default(1),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    projectId: uuid('project_id').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    status: runStatus('status').notNull().default('queued'),
    // Spec 021 (research R4): the running summary and the last `run_messages` row it covers — a
    // marker looked up by position in the ordered conversation, never compared with `<`. The
    // composite FK is declared below; set null (of the marker alone, as 0024 does for
    // `sync_operations.link_id`) rather than cascade: losing the marker costs one re-summary.
    summary: text('summary'),
    summaryThroughMessageId: uuid('summary_through_message_id'),
    summaryTokens: integer('summary_tokens').notNull().default(0),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  // Annotated because the marker FK below closes a cycle with `runMessages`.
  (table): PgTableExtraConfigValue[] => [
    unique('agent_runs_org_id_id_key').on(table.orgId, table.id),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.id],
      name: 'agent_runs_org_id_project_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.orgId, table.summaryThroughMessageId],
      foreignColumns: [runMessages.orgId, runMessages.id],
      name: 'agent_runs_org_id_summary_through_message_id_fk',
    }).onDelete('set null'),
    index('agent_runs_org_id_project_id_created_at_idx').on(
      table.orgId,
      table.projectId,
      table.createdAt.desc(),
    ),
    // The reaper's scan: only leased rows, which is a small set however many runs there are.
    index('agent_runs_status_lease_until_idx')
      .on(table.status, table.leaseUntil)
      .where(sql`${table.leaseUntil} is not null`),
    // 031 R1a: the backstop — at most one started, non-terminal run (the holder) per project.
    uniqueIndex('agent_runs_one_holder_per_project')
      .on(table.orgId, table.projectId)
      .where(
        sql`${table.startedAt} is not null and ${table.status} not in ('succeeded', 'failed', 'cancelled')`,
      ),
    // 031 R1: the line — never-started, non-terminal runs in `(created_at, id)` order.
    index('agent_runs_line_idx')
      .on(table.orgId, table.projectId, table.createdAt, table.id)
      .where(
        sql`${table.startedAt} is null and ${table.status} not in ('succeeded', 'failed', 'cancelled')`,
      ),
  ],
);

/** The conversation: the prompt, each input, and (from 011) what the model said. */
export const runMessages = pgTable(
  'run_messages',
  {
    at: timestamp('at', { withTimezone: true }).notNull(),
    content: text('content').notNull(),
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    role: runMessageRole('role').notNull(),
    runId: uuid('run_id').notNull(),
    toolCalls: jsonb('tool_calls').$type<unknown[]>().notNull().default([]),
    ...timestamps,
  },
  (table) => [
    unique('run_messages_org_id_id_key').on(table.orgId, table.id),
    foreignKey({
      columns: [table.orgId, table.runId],
      foreignColumns: [agentRuns.orgId, agentRuns.id],
      name: 'run_messages_org_id_run_id_fk',
    }).onDelete('cascade'),
    index('run_messages_org_id_run_id_at_idx').on(table.orgId, table.runId, table.at),
  ],
);

/**
 * The event log, **typed here and created elsewhere**. `run_events` is `partition by range (at)`
 * with a primary key of `(org_id, run_id, seq, at)` and no `id`, none of which drizzle-kit can
 * emit or diff, so `migrations/0011_run_events_partitioned.sql` owns every constraint, the
 * partitions, the policy and the grants (ADR 032). This declaration exists so the store can build
 * typed statements against it; `db:generate` output for this table is deleted, never applied.
 */
export const runEvents = pgTable('run_events', {
  at: timestamp('at', { withTimezone: true }).notNull(),
  data: jsonb('data').$type<Record<string, unknown>>().notNull(),
  orgId: uuid('org_id').notNull(),
  runId: uuid('run_id').notNull(),
  seq: integer('seq').notNull(),
  type: text('type').notNull(),
  ...timestamps,
});

export type AgentRun = typeof agentRuns.$inferSelect;
export type NewAgentRun = typeof agentRuns.$inferInsert;
export type RunMessage = typeof runMessages.$inferSelect;
export type NewRunMessage = typeof runMessages.$inferInsert;
export type RunEventRow = typeof runEvents.$inferSelect;
export type NewRunEventRow = typeof runEvents.$inferInsert;
