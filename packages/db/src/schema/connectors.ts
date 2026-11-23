import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  boolean,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { checkpoints } from './checkpoints';
import { timestamps } from './columns';
import { deployments, domains } from './deploy';
import { users } from './identity';
import { secrets } from './secrets';
import { orgs, projects } from './tenancy';

/**
 * `checkpoints.ts` imports `syncOperations` from here and `repo_links` points back at
 * `checkpoints`, so the two modules are a cycle. At runtime that is harmless — each side names the
 * other only inside a lazily evaluated constraint callback — but TypeScript cannot infer two table
 * types from each other, so this side reads the other through a declared signature.
 */
function checkpointKeys(): { id: AnyPgColumn; orgId: AnyPgColumn } {
  return { id: checkpoints.id, orgId: checkpoints.orgId };
}

/**
 * Spec 030 adds the five remaining providers (data-model § 1). Migration 0040 adds them alone in
 * its file: no later statement in the same run may use the new literals (the 0021 pitfall), so
 * every CHECK that names a provider compares `provider::text`.
 */
export const connectorProvider = pgEnum('connector_provider', [
  'github',
  'netlify',
  'supabase',
  'neon',
  'resend',
  'cloudflare',
]);

/** Decides whether "create repository" is offered (research R4). */
export const connectorAccountType = pgEnum('connector_account_type', ['organization', 'user']);

export const connectorHealth = pgEnum('connector_health', [
  'healthy',
  'needs_reauth',
  'unavailable',
]);

/** How a connection's credential was obtained (spec 030 R2); existing rows are GitHub's App. */
export const connectorAuthType = pgEnum('connector_auth_type', [
  'app_installation',
  'oauth',
  'token',
]);

/** Spec 030 data-model § 3. */
export const bindingState = pgEnum('binding_state', ['bound', 'disconnected']);

/** What the platform created in a provider account (spec 030 R8, data-model § 4). */
export const resourceKind = pgEnum('resource_kind', [
  'neon_branch',
  'resend_sending_key',
  'supabase_publishable_key',
  'cloudflare_dns_record',
]);

export const resourceState = pgEnum('resource_state', [
  'provisioning',
  'live',
  'releasing',
  'released',
  'failed',
]);

/** One queued provider write (spec 030 data-model § 5). */
export const connectorOpKind = pgEnum('connector_op_kind', [
  'netlify_publish',
  'neon_branch_create',
  'neon_branch_reset',
  'resource_release',
  'supabase_key_fetch',
  'resend_key_mint',
  'dns_write',
  'connection_remove',
]);

export const connectorOpState = pgEnum('connector_op_state', [
  'queued',
  'running',
  'succeeded',
  'failed',
]);

/** The `CONNECTOR_OP_REASONS` vocabulary (contracts/bindings.md § 5); null unless `failed`. */
export const connectorOpReason = pgEnum('connector_op_reason', [
  'needs-reauth',
  'missing-scope',
  'in-flight',
  'removing',
  'provider-unavailable',
  'rate-limited',
  'quota-exceeded',
  'not-found',
  'site-gone',
  'record-conflict',
  'zone-not-found',
  'disconnected',
  'timed-out',
  'provider-refused',
  'build-failed',
]);

export const repoLinkState = pgEnum('repo_link_state', ['linked', 'disconnected']);

/** `import` is spec 026's third kind: a repository becoming a project (spec 026, data-model § 2). */
export const syncKind = pgEnum('sync_kind', ['push', 'pull', 'import']);

export const syncState = pgEnum('sync_state', ['queued', 'running', 'succeeded', 'failed']);

/** Spec 044: who asked for an operation. */
export const syncTrigger = pgEnum('sync_trigger', ['manual', 'auto']);

/** The `SYNC_FAILURE_REASONS` vocabulary (contracts/connectors.md § 3); null unless `failed`. */
export const syncFailureReason = pgEnum('sync_failure_reason', [
  'remote-ahead',
  'diverged',
  'nothing-to-push',
  'run-active',
  'operation-in-flight',
  'needs-reauth',
  'provider-unavailable',
  'not-linked',
  'create-unsupported',
  'name-taken',
  'timed-out',
  'git-failed',
  'bundle-too-large',
  'empty-repo',
  'repo-too-large',
  'branch-not-found',
  'import-checkout-failed',
  'branch-protected',
  'push-rejected',
  'workflow-permission',
  'repo-gone',
  'account-mismatch',
]);

/**
 * A connector is "a stored credential plus a capability set plus a health state" (§12): one row
 * per organisation per provider. The credential itself is a `secrets` row reached through a
 * composite `(org_id, secret_id)` key, so the sealed token can never be another tenant's; it is
 * null only between a failed mint and the next. `account_id` is GitHub's stable id, which a
 * reconnect matches on (R13). `failure_count` / `circuit_open_until` are R10's breaker.
 */
export const connections = pgTable(
  'connections',
  {
    /** GitHub's stable account id; null for every other provider (spec 030 R2). */
    accountId: bigint('account_id', { mode: 'number' }),
    /** The display name for every provider. */
    accountLogin: text('account_login').notNull(),
    /** The provider's own account / project / team identifier; required unless GitHub. */
    accountRef: text('account_ref'),
    accountType: connectorAccountType('account_type'),
    authType: connectorAuthType('auth_type').notNull().default('app_installation'),
    circuitOpenUntil: timestamp('circuit_open_until', { withTimezone: true }),
    connectedBy: uuid('connected_by')
      .notNull()
      .references(() => users.id),
    failureCount: integer('failure_count').notNull().default(0),
    grantedScopes: text('granted_scopes')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    health: connectorHealth('health').notNull(),
    id: uuid('id').primaryKey().defaultRandom(),
    installationId: bigint('installation_id', { mode: 'number' }),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    provider: connectorProvider('provider').notNull(),
    /** Set by a removal request; while set the connection takes no new work (`reason: removing`). */
    removalRequestedAt: timestamp('removal_requested_at', { withTimezone: true }),
    secretId: uuid('secret_id'),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    unique('connections_org_id_id_key').on(table.orgId, table.id),
    unique('connections_org_id_provider_key').on(table.orgId, table.provider),
    foreignKey({
      columns: [table.orgId, table.secretId],
      foreignColumns: [secrets.orgId, secrets.id],
      name: 'connections_org_id_secret_id_fk',
    }),
    // Spec 030 R2. On `::text` (the 0021 pitfall); the SQL lives in 0042.
    check(
      'connections_github_shape',
      sql`${table.provider}::text <> 'github' or (${table.accountId} is not null and ${table.installationId} is not null and ${table.accountType} is not null)`,
    ),
    check(
      'connections_account_ref',
      sql`${table.provider}::text = 'github' or ${table.accountRef} is not null`,
    ),
  ],
);

/**
 * One per project. A `disconnected` link outlives its connection (R13): `connection_id` is set null
 * when the row goes, and the check pins `linked` to exactly the rows that still point at one.
 * `branch` is named at link time and never re-read (spec § Assumptions); `repo_id` is GitHub's id,
 * so renames survive.
 */
export const repoLinks = pgTable(
  'repo_links',
  {
    /** Spec 044: push after every turn. Rows that predate the column are false (0057). */
    autoSync: boolean('auto_sync').notNull().default(true),
    branch: text('branch').notNull(),
    connectionId: uuid('connection_id'),
    id: uuid('id').primaryKey().defaultRandom(),
    lastPushedCheckpointId: uuid('last_pushed_checkpoint_id'),
    linkedBy: uuid('linked_by')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    owner: text('owner').notNull(),
    projectId: uuid('project_id').notNull(),
    remoteHeadSha: text('remote_head_sha'),
    repoId: bigint('repo_id', { mode: 'number' }).notNull(),
    /** Spec 044: set while the project's work waits on a side branch; a level push clears it. */
    sideBranch: text('side_branch'),
    state: repoLinkState('state').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('repo_links_org_id_id_key').on(table.orgId, table.id),
    unique('repo_links_org_id_project_id_key').on(table.orgId, table.projectId),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.id],
      name: 'repo_links_org_id_project_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.orgId, table.connectionId],
      foreignColumns: [connections.orgId, connections.id],
      name: 'repo_links_org_id_connection_id_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.orgId, table.lastPushedCheckpointId],
      foreignColumns: [checkpointKeys().orgId, checkpointKeys().id],
      name: 'repo_links_org_id_last_pushed_checkpoint_id_fk',
    }),
    check(
      'repo_links_state_check',
      sql`(${table.state} = 'linked') = (${table.connectionId} is not null)`,
    ),
  ],
);

/**
 * One row per push or pull — the record FR-023/FR-029 promise; `id` doubles as the outbox
 * aggregate and the BullMQ job id. The partial unique index is R7's one-at-a-time rule: a
 * project has at most one operation `queued` or `running`. Terminal states never change; the row
 * is append-only by convention, not by grant (it is not audit).
 */
export const syncOperations = pgTable(
  'sync_operations',
  {
    commits: integer('commits').notNull().default(0),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    fromSha: text('from_sha'),
    id: uuid('id').primaryKey().defaultRandom(),
    kind: syncKind('kind').notNull(),
    /** Null once the link is removed: the history outlives the link (corrected at T032). */
    linkId: uuid('link_id'),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').notNull(),
    reason: syncFailureReason('reason'),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id),
    startedAt: timestamp('started_at', { withTimezone: true }),
    state: syncState('state').notNull(),
    /** Spec 044: the branch a push landed on; null for a pull, an import, or a push that did not land. */
    targetBranch: text('target_branch'),
    toSha: text('to_sha'),
    trigger: syncTrigger('trigger').notNull().default('manual'),
    ...timestamps,
  },
  (table) => [
    unique('sync_operations_org_id_id_key').on(table.orgId, table.id),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.id],
      name: 'sync_operations_org_id_project_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.orgId, table.linkId],
      foreignColumns: [repoLinks.orgId, repoLinks.id],
      name: 'sync_operations_org_id_link_id_fk',
    }).onDelete('set null'),
    uniqueIndex('sync_operations_one_in_flight')
      .on(table.orgId, table.projectId)
      .where(sql`${table.state} in ('queued', 'running')`),
    index('sync_operations_org_project_created_idx').on(
      table.orgId,
      table.projectId,
      table.createdAt.desc(),
    ),
  ],
);

/**
 * A project's link to one provider resource (spec 030 data-model § 3). 018's `repo_links` stays
 * the GitHub instance. `config` is the per-provider shape, Zod-parsed on every read. The composite
 * `SET NULL` to `connections` names `connection_id` only in the SQL (0041, the 0024 column list).
 * The CHECKs compare on `::text` and live in 0042; they are declared here so the snapshot records
 * them.
 */
export const connectorBindings = pgTable(
  'connector_bindings',
  {
    boundBy: uuid('bound_by')
      .notNull()
      .references(() => users.id),
    config: jsonb('config').$type<Record<string, unknown>>().notNull(),
    connectionId: uuid('connection_id'),
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').notNull(),
    provider: connectorProvider('provider').notNull(),
    state: bindingState('state').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('connector_bindings_org_id_id_key').on(table.orgId, table.id),
    unique('connector_bindings_org_id_project_id_provider_key').on(
      table.orgId,
      table.projectId,
      table.provider,
    ),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.id],
      name: 'connector_bindings_org_id_project_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.orgId, table.connectionId],
      foreignColumns: [connections.orgId, connections.id],
      name: 'connector_bindings_org_id_connection_id_fk',
    }).onDelete('set null'),
    check('connector_bindings_not_github', sql`${table.provider}::text <> 'github'`),
    check(
      'connector_bindings_state_check',
      sql`${table.state}::text = 'disconnected' or ${table.connectionId} is not null`,
    ),
  ],
);

/**
 * Everything the platform created in a provider account (spec 030 R8, data-model § 4). One owner:
 * the binding for a branch or key, the domain for a DNS record. At most one live resource per
 * binding and kind.
 */
export const connectorResources = pgTable(
  'connector_resources',
  {
    bindingId: uuid('binding_id'),
    connectionId: uuid('connection_id'),
    domainId: uuid('domain_id'),
    externalId: text('external_id'),
    id: uuid('id').primaryKey().defaultRandom(),
    kind: resourceKind('kind').notNull(),
    name: text('name').notNull(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    scopeRef: text('scope_ref'),
    secretId: uuid('secret_id'),
    state: resourceState('state').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('connector_resources_org_id_id_key').on(table.orgId, table.id),
    foreignKey({
      columns: [table.orgId, table.connectionId],
      foreignColumns: [connections.orgId, connections.id],
      name: 'connector_resources_org_id_connection_id_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.orgId, table.bindingId],
      foreignColumns: [connectorBindings.orgId, connectorBindings.id],
      name: 'connector_resources_org_id_binding_id_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.orgId, table.domainId],
      foreignColumns: [domains.orgId, domains.id],
      name: 'connector_resources_org_id_domain_id_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.orgId, table.secretId],
      foreignColumns: [secrets.orgId, secrets.id],
      name: 'connector_resources_org_id_secret_id_fk',
    }),
    check(
      'connector_resources_single_owner',
      sql`(${table.kind}::text = 'cloudflare_dns_record' and ${table.bindingId} is null) or (${table.kind}::text <> 'cloudflare_dns_record' and ${table.domainId} is null)`,
    ),
    uniqueIndex('connector_resources_one_live_per_binding')
      .on(table.orgId, table.bindingId, table.kind)
      .where(sql`${table.state} in ('provisioning', 'live', 'releasing')`),
    index('connector_resources_org_domain_idx').on(table.orgId, table.domainId),
  ],
);

/**
 * One queued provider write (spec 030 data-model § 5; FR-017's record). `id` doubles as the outbox
 * aggregate and the job id. At most one publish or branch change in flight per binding.
 */
export const connectorOperations = pgTable(
  'connector_operations',
  {
    bindingId: uuid('binding_id'),
    deploymentId: uuid('deployment_id'),
    domainId: uuid('domain_id'),
    externalRef: text('external_ref'),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    id: uuid('id').primaryKey().defaultRandom(),
    kind: connectorOpKind('kind').notNull(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id'),
    providerState: text('provider_state'),
    reason: connectorOpReason('reason'),
    requestedBy: uuid('requested_by').references(() => users.id),
    resourceId: uuid('resource_id'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    state: connectorOpState('state').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('connector_operations_org_id_id_key').on(table.orgId, table.id),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.id],
      name: 'connector_operations_org_id_project_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.orgId, table.bindingId],
      foreignColumns: [connectorBindings.orgId, connectorBindings.id],
      name: 'connector_operations_org_id_binding_id_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.orgId, table.resourceId],
      foreignColumns: [connectorResources.orgId, connectorResources.id],
      name: 'connector_operations_org_id_resource_id_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.orgId, table.domainId],
      foreignColumns: [domains.orgId, domains.id],
      name: 'connector_operations_org_id_domain_id_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.orgId, table.deploymentId],
      foreignColumns: [deployments.orgId, deployments.id],
      name: 'connector_operations_org_id_deployment_id_fk',
    }).onDelete('set null'),
    check(
      'connector_operations_reason_when_failed',
      sql`(${table.state}::text = 'failed') = (${table.reason} is not null)`,
    ),
    check(
      'connector_operations_publish_deployment',
      sql`${table.kind}::text <> 'netlify_publish' or ${table.deploymentId} is not null`,
    ),
    uniqueIndex('connector_operations_one_in_flight')
      .on(table.orgId, table.bindingId)
      .where(
        sql`${table.state} in ('queued', 'running') and ${table.kind} in ('netlify_publish', 'neon_branch_create', 'neon_branch_reset')`,
      ),
    index('connector_operations_org_binding_created_idx').on(
      table.orgId,
      table.bindingId,
      table.createdAt.desc(),
    ),
  ],
);

export type Connection = typeof connections.$inferSelect;
export type NewConnection = typeof connections.$inferInsert;
export type RepoLink = typeof repoLinks.$inferSelect;
export type NewRepoLink = typeof repoLinks.$inferInsert;
export type SyncOperation = typeof syncOperations.$inferSelect;
export type NewSyncOperation = typeof syncOperations.$inferInsert;
export type ConnectorBinding = typeof connectorBindings.$inferSelect;
export type NewConnectorBinding = typeof connectorBindings.$inferInsert;
export type ConnectorResource = typeof connectorResources.$inferSelect;
export type NewConnectorResource = typeof connectorResources.$inferInsert;
export type ConnectorOperation = typeof connectorOperations.$inferSelect;
export type NewConnectorOperation = typeof connectorOperations.$inferInsert;
