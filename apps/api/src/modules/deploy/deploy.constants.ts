import type { DeploymentState } from '@repo/contracts';

/**
 * Spec 027's fixed numbers (plan.md § Constraints, research R3/R5/R8). One place, so the worker,
 * the tar reader and the sweep cannot disagree about a limit.
 */

/** The build queue (`agent` profile): one job per deployment, `jobId = deploymentId`. */
export const BUILD_DEPLOY_QUEUE = 'build.deploy';

/**
 * The artifacts bucket (research R7): `DeployModule` binds its own `objectStoreFor(config,
 * 'artifacts')` under this token, beside `checkpoints`' repos bucket under `OBJECT_STORE` — one
 * token cannot name two buckets, and a suite overriding one must not swap the other.
 */
export const ARTIFACT_STORE = Symbol('forge.deploy.artifactStore');

/** The lifecycle queue (`events` profile): archive → offline and cancel (US5). */
export const DEPLOY_LIFECYCLE_QUEUE = 'deploy.lifecycle';

/** The stuck-deployment sweep's queue (`events` profile): `maintenance.due` `deploy.sweep` (R8). */
export const DEPLOY_SWEEP_QUEUE = 'deploy.sweep';

/** The whole build — every command's timeout is cut from what is left of this (FR-013). */
export const BUILD_TIMEOUT_MS = 15 * 60 * 1000;

/** The output caps (FR-014, R5): Σ file bytes and file count, checked before reading on. */
export const OUTPUT_MAX_BYTES = 100 * 1024 * 1024;
export const OUTPUT_MAX_FILES = 10_000;

/** The archive download cap: the output cap plus room for tar headers and padding. */
export const TAR_DOWNLOAD_MAX_BYTES = 110 * 1024 * 1024;

/** `deployments.log_tail` — mirrors the `deployments_log_tail_size_check` CHECK. */
export const LOG_TAIL_MAX_BYTES = 64 * 1024;

/**
 * R8: a `building`/`uploading` row whose current attempt was claimed longer ago than this is failed
 * `platform` by `deploy.sweep` (`started_at` is each claim's, so a young retry is never swept).
 */
export const STALE_AFTER_MS = 30 * 60 * 1000;

/**
 * A `queued` row nobody claimed for this long is failed `platform` by `deploy.sweep`: its job was
 * lost or dead-lettered before a claim, and the row would otherwise hold the in-flight slot for
 * good. Longer than `STALE_AFTER_MS` because a queued row may just be waiting behind a backlog.
 * Measured on the database's clock, against `created_at`.
 */
export const QUEUED_STALE_AFTER_MS = 60 * 60 * 1000;

/** The states `deployments_one_in_flight` covers (FR-004). */
export const IN_FLIGHT_STATES = [
  'queued',
  'building',
  'uploading',
] as const satisfies readonly DeploymentState[];

export type InFlightState = (typeof IN_FLIGHT_STATES)[number];
