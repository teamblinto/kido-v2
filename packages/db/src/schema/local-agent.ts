import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { agentRuns } from './agent';
import { timestamps } from './columns';
import { users } from './identity';

/**
 * A person's paired companion (spec 040 § 3 decision 3). A root table (ADR 015), as
 * `linked_accounts` is: owned by a person, so no `org_id` and no RLS. `token_hash` is the hex
 * SHA-256 of the `bld_` device token — a 256-bit random value needs no slow hash, and a digest
 * is what makes the lookup an index probe. Revocation is a timestamp, not a delete, so a
 * revoked device still names the runs it executed.
 */
export const localAgentDevices = pgTable(
  'local_agent_devices',
  {
    companionVersion: text('companion_version').notNull(),
    id: uuid('id').primaryKey().defaultRandom(),
    /** Spec 041: `cloud` is the hosted runner in a person's agent home, never paired by hand. */
    kind: text('kind', { enum: ['local', 'cloud'] })
      .notNull()
      .default('local'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    name: text('name').notNull(),
    platform: text('platform', { enum: ['windows', 'macos', 'linux'] }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    tokenHash: text('token_hash').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('local_agent_devices_token_hash_key').on(table.tokenHash),
    index('local_agent_devices_user_id_idx').on(table.userId),
  ],
);

/**
 * Which device and CLI executed a run (spec 040 § 3 decisions 4 and 9). Tenant-owned, one row per
 * run and keyed by it — `project_context`'s id-less shape: the primary key `(org_id, run_id)` is
 * also the composite FK to `agent_runs`, so the row goes with its run. `provider_session_id` is
 * the provider's opaque resume reference, never the conversation of record. `permission_mode` is
 * the mode requested at creation (the companion clamps it to its local ceiling), kept with the run
 * so every continuation turn asks for the same one. `tool_mode` (spec 041, sandbox tool bridge):
 * `workspace` runs the CLI's own tools on a registered local folder; `sandbox` switches them off
 * and has the CLI call the project's sandbox tools through the server, so it names no workspace.
 */
export const localAgentRuns = pgTable(
  'local_agent_runs',
  {
    deviceId: uuid('device_id')
      .notNull()
      .references(() => localAgentDevices.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id').notNull(),
    permissionMode: text('permission_mode', { enum: ['plan', 'default', 'acceptEdits'] })
      .notNull()
      .default('default'),
    provider: text('provider', { enum: ['claude', 'codex'] }).notNull(),
    providerSessionId: text('provider_session_id'),
    runId: uuid('run_id').notNull(),
    toolMode: text('tool_mode', { enum: ['workspace', 'sandbox'] })
      .notNull()
      .default('workspace'),
    workspaceId: text('workspace_id'),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.runId], name: 'local_agent_runs_pkey' }),
    foreignKey({
      columns: [table.orgId, table.runId],
      foreignColumns: [agentRuns.orgId, agentRuns.id],
      name: 'local_agent_runs_org_id_run_id_fk',
    }).onDelete('cascade'),
    index('local_agent_runs_device_id_idx').on(table.deviceId),
    check(
      'local_agent_runs_workspace_check',
      sql`(${table.toolMode} = 'workspace') = (${table.workspaceId} is not null)`,
    ),
  ],
);

/**
 * A person's agent home (spec 041): the private Daytona sandbox their own Claude Code runs in,
 * and the `cloud` device its runner connects as. A root (ADR 015), like `local_agent_devices`:
 * owned by a person, no `org_id`, no RLS. One per person and provider. Sign-in state is not
 * stored here; it comes from the runner's status report.
 */
export const agentHomes = pgTable(
  'agent_homes',
  {
    daytonaId: text('daytona_id'),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => localAgentDevices.id, { onDelete: 'cascade' }),
    id: uuid('id').primaryKey().defaultRandom(),
    lastError: text('last_error'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    provider: text('provider', { enum: ['claude'] }).notNull(),
    /** When the current sandbox was created: a sign-in verdict older than this is not its own. */
    sandboxCreatedAt: timestamp('sandbox_created_at', { withTimezone: true }),
    /** When the current start began: a verdict older than this does not skip a new sign-in. */
    startedAt: timestamp('started_at', { withTimezone: true }),
    state: text('state', {
      enum: ['provisioning', 'stopped', 'starting', 'running', 'stopping', 'error'],
    })
      .notNull()
      .default('provisioning'),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('agent_homes_user_id_provider_key').on(table.userId, table.provider),
    uniqueIndex('agent_homes_device_id_key').on(table.deviceId),
    index('agent_homes_state_idx').on(table.state),
  ],
);

export type AgentHomeRow = typeof agentHomes.$inferSelect;
export type NewAgentHomeRow = typeof agentHomes.$inferInsert;
export type LocalAgentDeviceRow = typeof localAgentDevices.$inferSelect;
export type NewLocalAgentDeviceRow = typeof localAgentDevices.$inferInsert;
export type LocalAgentRunRow = typeof localAgentRuns.$inferSelect;
export type NewLocalAgentRunRow = typeof localAgentRuns.$inferInsert;
