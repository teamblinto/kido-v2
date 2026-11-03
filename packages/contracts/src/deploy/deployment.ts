import { z } from 'zod';

import { cursorPageQuerySchema, cursorSchema } from '../common/cursor';

/**
 * Deployments (spec 027, contracts/deployments.md § Shapes): one row per build of a checkpoint into
 * a static artifact. `log_tail` is deliberately not on the row — it has its own route, so a list
 * never carries 64 KiB per item.
 */

export const DEPLOYMENT_STATES = [
  'queued',
  'building',
  'uploading',
  'succeeded',
  'failed',
  'cancelled',
] as const;

export const deploymentStateSchema = z.enum(DEPLOYMENT_STATES);

export type DeploymentState = z.output<typeof deploymentStateSchema>;

export const DEPLOYMENT_FAILURE_REASONS = [
  'install-failed',
  'build-failed',
  'no-output',
  'output-too-large',
  'timeout',
  'not-authorised',
  'platform',
] as const;

export const deploymentFailureReasonSchema = z.enum(DEPLOYMENT_FAILURE_REASONS);

export type DeploymentFailureReason = z.output<typeof deploymentFailureReasonSchema>;

export const deploymentSchema = z.strictObject({
  id: z.uuid(),
  checkpointId: z.uuid(),
  state: deploymentStateSchema,
  failureReason: deploymentFailureReasonSchema.nullable(),
  /** Succeeded and named by the site pointer. */
  current: z.boolean(),
  requestedBy: z.uuid(),
  attempts: z.number().int().min(0),
  artifactSha: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .nullable(),
  fileCount: z.number().int().nullable(),
  totalBytes: z.number().int().nullable(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
});

export type Deployment = z.output<typeof deploymentSchema>;

/** `POST …/deployments` — an omitted `checkpointId` means the project's head checkpoint. */
export const createDeploymentRequestSchema = z.strictObject({
  checkpointId: z.uuid().optional(),
});

export type CreateDeploymentRequest = z.output<typeof createDeploymentRequestSchema>;

/** `202` of the create, and `200` of `GET …/deployments/:deploymentId`. */
export const deploymentResponseSchema = z.strictObject({
  deployment: deploymentSchema,
});

export type DeploymentResponse = z.output<typeof deploymentResponseSchema>;

export const deploymentListQuerySchema = cursorPageQuerySchema;

export type DeploymentListQuery = z.output<typeof deploymentListQuerySchema>;

/** `GET …/deployments` — newest first. */
export const deploymentListResponseSchema = z.strictObject({
  items: z.array(deploymentSchema),
  nextCursor: cursorSchema.nullable(),
});

export type DeploymentListResponse = z.output<typeof deploymentListResponseSchema>;

/** The stored tail is capped at 64 KiB (data-model: `char_length(log_tail) <= 65536`). */
export const DEPLOYMENT_LOG_MAX_LENGTH = 65_536;

/** `GET …/deployments/:deploymentId/log` — the scrubbed tail; `''` before the build ends. */
export const deploymentLogResponseSchema = z.strictObject({
  log: z.string().max(DEPLOYMENT_LOG_MAX_LENGTH),
  truncated: z.boolean(),
});

export type DeploymentLogResponse = z.output<typeof deploymentLogResponseSchema>;
