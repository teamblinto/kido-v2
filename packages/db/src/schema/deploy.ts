import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { checkpoints } from './checkpoints';
import { timestamps } from './columns';
import { users } from './identity';
import { orgs, projects } from './tenancy';

/**
 * A deployment's life (spec 027, data-model.md § State transitions). `live` and `superseded` are
 * derived, not stored: a `succeeded` deployment is live when `project_sites.current_deployment_id`
 * names it and the site is not offline.
 */
export const deploymentState = pgEnum('deployment_state', [
  'queued',
  'building',
  'uploading',
  'succeeded',
  'failed',
  'cancelled',
]);

/** Null unless `failed` (contracts/deployments.md § Shapes). */
export const deploymentFailureReason = pgEnum('deployment_failure_reason', [
  'install-failed',
  'build-failed',
  'no-output',
  'output-too-large',
  'timeout',
  'not-authorised',
  'platform',
]);

/** One value today: the gateway serves the site from the artifacts bucket (ADR 053). */
export const deploymentTarget = pgEnum('deployment_target', ['forge-static']);

/**
 * One build-and-release of one checkpoint (spec 027, data-model.md § deployments); `id` doubles as
 * the outbox aggregate and the BullMQ job id. `lease_epoch` fences every worker write (R8): a
 * claim and a cancel both bump it. Terminal rows are never updated again — every write carries
 * `WHERE state IN (…)`. The CHECKs comparing `state::text` live in
 * `migrations/0034_deploys_are_tenant_owned.sql` (the 0021 enum-in-one-transaction gotcha); they
 * are declared here too so drizzle-kit's snapshot records them and never diffs them again.
 */
export const deployments = pgTable(
  'deployments',
  {
    artifactSha: text('artifact_sha'),
    attempts: integer('attempts').notNull().default(0),
    checkpointId: uuid('checkpoint_id').notNull(),
    failureReason: deploymentFailureReason('failure_reason'),
    fileCount: integer('file_count'),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    id: uuid('id').primaryKey().defaultRandom(),
    leaseEpoch: integer('lease_epoch').notNull().default(0),
    logTail: text('log_tail'),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').notNull(),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id),
    startedAt: timestamp('started_at', { withTimezone: true }),
    state: deploymentState('state').notNull().default('queued'),
    target: deploymentTarget('target').notNull().default('forge-static'),
    template: text('template').notNull(),
    templateDigest: text('template_digest'),
    templateSnapshot: text('template_snapshot'),
    totalBytes: bigint('total_bytes', { mode: 'number' }),
    uploadStartedAt: timestamp('upload_started_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    unique('deployments_org_id_id_key').on(table.orgId, table.id),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.id],
      name: 'deployments_org_id_project_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.orgId, table.checkpointId],
      foreignColumns: [checkpoints.orgId, checkpoints.id],
      name: 'deployments_org_id_checkpoint_id_fk',
    }),
    check(
      'deployments_failed_reason_check',
      sql`(${table.state}::text = 'failed') = (${table.failureReason} is not null)`,
    ),
    check(
      'deployments_finished_check',
      sql`(${table.state}::text in ('succeeded', 'failed', 'cancelled')) = (${table.finishedAt} is not null)`,
    ),
    check('deployments_log_tail_size_check', sql`char_length(${table.logTail}) <= 65536`),
    check(
      'deployments_succeeded_artifact_check',
      sql`(${table.state}::text = 'succeeded') = (${table.artifactSha} is not null)`,
    ),
    check(
      'deployments_uploading_check',
      sql`${table.state}::text <> 'uploading' or ${table.uploadStartedAt} is not null`,
    ),
    // FR-004's second net behind the service's `deploy-active` refusal.
    uniqueIndex('deployments_one_in_flight')
      .on(table.orgId, table.projectId)
      .where(sql`${table.state} in ('queued', 'building', 'uploading')`),
    index('deployments_org_project_created_idx').on(
      table.orgId,
      table.projectId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    index('deployments_stale_idx')
      .on(table.state, table.startedAt)
      .where(sql`${table.state} in ('building', 'uploading')`),
  ],
);

/**
 * The release pointer (spec 027, data-model.md § project_sites): one row per project that has ever
 * gone live. `site_label` is unique across every tenant — it is the site's host name (R10).
 * "The current deployment is `succeeded`" cannot be a CHECK; the service writes the pointer only
 * inside the go-live and release transactions. `updated_by` is null when the archive consumer
 * wrote the row.
 */
export const projectSites = pgTable(
  'project_sites',
  {
    currentDeploymentId: uuid('current_deployment_id').notNull(),
    id: uuid('id').primaryKey().defaultRandom(),
    offlineAt: timestamp('offline_at', { withTimezone: true }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').notNull(),
    siteLabel: text('site_label').notNull(),
    updatedBy: uuid('updated_by').references(() => users.id),
    ...timestamps,
  },
  (table) => [
    unique('project_sites_org_id_id_key').on(table.orgId, table.id),
    unique('project_sites_org_id_project_id_key').on(table.orgId, table.projectId),
    unique('project_sites_site_label_key').on(table.siteLabel),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.id],
      name: 'project_sites_org_id_project_id_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.orgId, table.currentDeploymentId],
      foreignColumns: [deployments.orgId, deployments.id],
      name: 'project_sites_org_id_current_deployment_id_fk',
    }),
    check(
      'project_sites_site_label_format_check',
      sql`${table.siteLabel} ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'`,
    ),
  ],
);

/**
 * A custom domain's life (spec 028, data-model.md § State transitions). `removed` is stored and
 * never returned by the API (R9); every end goes through `removing` so the hostname stays held
 * until the edge confirms deregistration.
 */
export const domainState = pgEnum('domain_state', [
  'pending',
  'active',
  'drifted',
  'removing',
  'failed',
  'removed',
]);

/** Set in `failed`, and in `removing` when heading for `failed` (contracts/domains.md § Shapes). */
export const domainFailureReason = pgEnum('domain_failure_reason', [
  'ownership-not-found',
  'routing-not-found',
  'caa-blocked',
  'certificate-failed',
  'verification-timeout',
  'provider-refused',
]);

/**
 * A custom hostname on a project (spec 028, data-model.md § domains). Rows are never deleted (R9):
 * `domains_hostname_live_key` holds a hostname across every tenant while its row is live, and a
 * `failed` or `removed` row lets it go. `next_check_at` is both the due time and the claim lease
 * (R7), and `claimed_at` tells a lease in force from a due time. `last_check` is the latest `DomainCheck`, parsed and size-checked by the repository. The
 * CHECKs comparing `state::text` live in `migrations/0036_domains_are_tenant_owned.sql` (the 0021
 * enum-in-one-transaction gotcha); they are declared here too so drizzle-kit's snapshot records
 * them and never diffs them again.
 */
export const domains = pgTable(
  'domains',
  {
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    addedBy: uuid('added_by').references(() => users.id, { onDelete: 'set null' }),
    certificateActiveAt: timestamp('certificate_active_at', { withTimezone: true }),
    checkRequestedAt: timestamp('check_requested_at', { withTimezone: true }),
    /** The `now` of the check in flight, cleared by its settle: marks the claim lease (R7). */
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    driftedAt: timestamp('drifted_at', { withTimezone: true }),
    edgeId: text('edge_id'),
    failureCount: smallint('failure_count').notNull().default(0),
    failureReason: domainFailureReason('failure_reason'),
    hostname: text('hostname').notNull(),
    id: uuid('id').primaryKey().defaultRandom(),
    lastCheck: jsonb('last_check'),
    nextCheckAt: timestamp('next_check_at', { withTimezone: true }).notNull(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    ownershipToken: text('ownership_token').notNull(),
    ownershipVerifiedAt: timestamp('ownership_verified_at', { withTimezone: true }),
    projectId: uuid('project_id').notNull(),
    releaseWarnedAt: timestamp('release_warned_at', { withTimezone: true }),
    removalRequestedAt: timestamp('removal_requested_at', { withTimezone: true }),
    state: domainState('state').notNull().default('pending'),
    windowStartedAt: timestamp('window_started_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    unique('domains_org_id_id_key').on(table.orgId, table.id),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.id],
      name: 'domains_org_id_project_id_fk',
    }).onDelete('cascade'),
    check(
      'domains_hostname_format_check',
      sql`char_length(${table.hostname}) <= 253 and ${table.hostname} = lower(${table.hostname})`,
    ),
    check('domains_ownership_token_format_check', sql`${table.ownershipToken} ~ '^[a-z2-7]{32}$'`),
    check(
      'domains_failure_reason_check',
      sql`(${table.state}::text <> 'failed' or ${table.failureReason} is not null) and (${table.state}::text not in ('pending', 'active', 'drifted', 'removed') or ${table.failureReason} is null)`,
    ),
    // FR-009: a hostname serves only once ownership, the edge and the certificate are all proven.
    check(
      'domains_serving_proven_check',
      sql`${table.state}::text not in ('active', 'drifted') or (${table.ownershipVerifiedAt} is not null and ${table.certificateActiveAt} is not null and ${table.activatedAt} is not null and ${table.edgeId} is not null)`,
    ),
    check(
      'domains_drifted_check',
      sql`(${table.state}::text = 'drifted') = (${table.driftedAt} is not null)`,
    ),
    check(
      'domains_removing_check',
      sql`${table.state}::text <> 'removing' or ${table.removalRequestedAt} is not null`,
    ),
    check(
      'domains_ended_deregistered_check',
      sql`${table.state}::text not in ('failed', 'removed') or ${table.edgeId} is null`,
    ),
    check('domains_failure_count_check', sql`${table.failureCount} between 0 and 3`),
    // FR-031, R9: global across tenants, as `project_sites_site_label_key` is.
    uniqueIndex('domains_hostname_live_key')
      .on(table.hostname)
      .where(sql`${table.state} in ('pending', 'active', 'drifted', 'removing')`),
    index('domains_org_project_idx').on(table.orgId, table.projectId, table.createdAt.desc()),
    // The sweep's bypass probe (R7).
    index('domains_due_idx')
      .on(table.nextCheckAt)
      .where(sql`${table.state} in ('pending', 'active', 'drifted', 'removing')`),
    // The broker's bypass probe (R11).
    index('domains_serving_idx')
      .on(table.hostname)
      .where(sql`${table.state} in ('active', 'drifted')`),
  ],
);

export type Deployment = typeof deployments.$inferSelect;
export type NewDeployment = typeof deployments.$inferInsert;
export type ProjectSite = typeof projectSites.$inferSelect;
export type NewProjectSite = typeof projectSites.$inferInsert;
export type Domain = typeof domains.$inferSelect;
export type NewDomain = typeof domains.$inferInsert;
