import { z } from 'zod';

import { cursorPageQuerySchema, cursorSchema } from '../common/cursor';

/**
 * Connector operations (spec 030, contracts/bindings.md § 4, data-model § 5): one queued provider
 * write. A failure found by the consumer lands on the row as a `reason`; a refusal before enqueue
 * carries the same vocabulary as the problem document's `reason` extension (§ 5).
 */

export const CONNECTOR_OP_KINDS = [
  'netlify_publish',
  'neon_branch_create',
  'neon_branch_reset',
  'resource_release',
  'supabase_key_fetch',
  'resend_key_mint',
  'dns_write',
  'connection_remove',
] as const;

export const connectorOpKindSchema = z.enum(CONNECTOR_OP_KINDS);

export type ConnectorOpKind = z.output<typeof connectorOpKindSchema>;

export const CONNECTOR_OP_STATES = ['queued', 'running', 'succeeded', 'failed'] as const;

export const connectorOpStateSchema = z.enum(CONNECTOR_OP_STATES);

export type ConnectorOpState = z.output<typeof connectorOpStateSchema>;

/** data-model § 1, exact list — the `reason` on a failed row and on a refused request. */
export const CONNECTOR_OP_REASONS = [
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
] as const;

export const connectorOpReasonSchema = z.enum(CONNECTOR_OP_REASONS);

export type ConnectorOpReason = z.output<typeof connectorOpReasonSchema>;

export const operationSchema = z.strictObject({
  bindingId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  deploymentId: z.uuid().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  id: z.uuid(),
  kind: connectorOpKindSchema,
  projectId: z.uuid().nullable(),
  /** Netlify: `uploading`, `processing`, `ready`, `error`, … — the provider's own word. */
  providerState: z.string().nullable(),
  reason: connectorOpReasonSchema.nullable(),
  /** Null when a platform flow (archive, sweep) requested it. */
  requestedBy: z.uuid().nullable(),
  startedAt: z.iso.datetime().nullable(),
  state: connectorOpStateSchema,
});

export type Operation = z.output<typeof operationSchema>;

/** `GET …/projects/:projectId/connectors/operations`, newest first. */
export const operationPageSchema = z.strictObject({
  items: z.array(operationSchema),
  nextCursor: cursorSchema.optional(),
});

export type OperationPage = z.output<typeof operationPageSchema>;

export const operationQuerySchema = cursorPageQuerySchema.extend({
  kind: connectorOpKindSchema.optional(),
});

export type OperationQuery = z.output<typeof operationQuerySchema>;
