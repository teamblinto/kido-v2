import { z } from 'zod';

import { cursorSchema } from '../common/cursor';
import {
  WEBHOOK_EVENT_TYPES,
  subscribableEventTypeSchema,
  webhookEventTypeSchema,
} from './catalogue';

/**
 * Outbound webhook endpoints and their delivery log (spec 029, contracts/webhook-endpoints.md §
 * Shapes). The signing secret is never on `webhookEndpointSchema`: it is returned exactly once, by
 * create and rotate, as `webhookSecretResponseSchema`. The API calls a `webhook_sends` row a
 * "delivery"; only the table has another name (research R3).
 */

export const WEBHOOK_ENDPOINT_STATES = ['enabled', 'disabled', 'paused'] as const;

export const webhookEndpointStateSchema = z.enum(WEBHOOK_ENDPOINT_STATES);

export type WebhookEndpointState = z.output<typeof webhookEndpointStateSchema>;

export const WEBHOOK_DELIVERY_STATES = ['pending', 'succeeded', 'failed', 'not_sent'] as const;

export const webhookDeliveryStateSchema = z.enum(WEBHOOK_DELIVERY_STATES);

export type WebhookDeliveryState = z.output<typeof webhookDeliveryStateSchema>;

/** The classified failure of one attempt (research R7). `http-error`: the status is on the attempt. */
export const WEBHOOK_ATTEMPT_FAILURES = [
  'timeout',
  'connection-failed',
  'tls-failed',
  'dns-failed',
  'destination-refused',
  'redirect-not-followed',
  'response-too-large',
  'http-error',
] as const;

export const webhookAttemptFailureSchema = z.enum(WEBHOOK_ATTEMPT_FAILURES);

export type WebhookAttemptFailure = z.output<typeof webhookAttemptFailureSchema>;

/** The `reason` a `409 conflict` carries on the webhook routes; the API and the web share it. */
export const WEBHOOK_CONFLICT_REASONS = [
  'delivery-expired',
  'delivery-in-flight',
  /** A literal special-use address in the URL (FR-003). */
  'destination-not-allowed',
  'endpoint-limit',
  /** "Send test" on a disabled or paused endpoint. */
  'endpoint-not-enabled',
  /** Unparseable, over 2,048 characters, carries credentials, or not https outside local. */
  'invalid-url',
  'project-not-in-org',
] as const;

export type WebhookConflictReason = (typeof WEBHOOK_CONFLICT_REASONS)[number];

const isoDateTime = z.iso.datetime();

export const webhookEndpointSchema = z.strictObject({
  createdAt: isoDateTime,
  description: z.string().max(200),
  eventTypes: z.array(subscribableEventTypeSchema).min(1),
  id: z.uuid(),
  /** The latest attempt's failure while the endpoint is failing; null once a delivery succeeds. */
  lastFailure: webhookAttemptFailureSchema.nullable(),
  lastSuccessAt: isoDateTime.nullable(),
  pausedAt: isoDateTime.nullable(),
  /** `[]` means every project, including ones created later (FR-002). */
  projectIds: z.array(z.uuid()),
  secretRotation: z.strictObject({ previousExpiresAt: isoDateTime }).nullable(),
  state: webhookEndpointStateSchema,
  url: z.string(),
});

export type WebhookEndpoint = z.output<typeof webhookEndpointSchema>;

/** `GET …/webhooks/endpoints`: newest first, at most 20, so no cursor. */
export const webhookEndpointListSchema = z.strictObject({
  items: z.array(webhookEndpointSchema),
});

export type WebhookEndpointList = z.output<typeof webhookEndpointListSchema>;

export const createWebhookEndpointRequestSchema = z.strictObject({
  description: z.string().trim().max(200).default(''),
  eventTypes: z.array(subscribableEventTypeSchema).min(1).max(WEBHOOK_EVENT_TYPES.length),
  projectIds: z.array(z.uuid()).max(100).default([]),
  url: z.string().trim().min(1).max(2048),
});

export type CreateWebhookEndpointRequest = z.input<typeof createWebhookEndpointRequestSchema>;

export const updateWebhookEndpointRequestSchema = z
  .strictObject({
    description: z.string().trim().max(200).optional(),
    /** `true`: disabled or paused → enabled; `false`: → disabled. */
    enabled: z.boolean().optional(),
    eventTypes: z.array(subscribableEventTypeSchema).min(1).optional(),
    projectIds: z.array(z.uuid()).max(100).optional(),
    url: z.string().trim().min(1).max(2048).optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'At least one field is required.',
  });

export type UpdateWebhookEndpointRequest = z.input<typeof updateWebhookEndpointRequestSchema>;

/** Create and rotate: the only responses that ever carry the secret, shown exactly once. */
export const webhookSecretResponseSchema = z.strictObject({
  endpoint: webhookEndpointSchema,
  secret: z.string().startsWith('whsec_'),
});

export type WebhookSecretResponse = z.output<typeof webhookSecretResponseSchema>;

export const rotateWebhookSecretRequestSchema = z.strictObject({
  expireOld: z.boolean().default(false),
});

export type RotateWebhookSecretRequest = z.input<typeof rotateWebhookSecretRequestSchema>;

export const webhookAttemptSchema = z.strictObject({
  address: z.string().nullable(),
  attemptedAt: isoDateTime,
  durationMs: z.number().int(),
  failure: webhookAttemptFailureSchema.nullable(),
  manual: z.boolean(),
  /** Null after 7 days, or when no response arrived. */
  responseBody: z.string().nullable(),
  responseHeaders: z.record(z.string(), z.string()).nullable(),
  status: z.number().int().nullable(),
});

export type WebhookAttempt = z.output<typeof webhookAttemptSchema>;

export const webhookDeliverySummarySchema = z.strictObject({
  attempts: z.number().int(),
  createdAt: isoDateTime,
  eventId: z.uuid(),
  eventType: webhookEventTypeSchema,
  id: z.uuid(),
  lastFailure: webhookAttemptFailureSchema.nullable(),
  nextAttemptAt: isoDateTime.nullable(),
  projectId: z.uuid().nullable(),
  state: webhookDeliveryStateSchema,
});

export type WebhookDeliverySummary = z.output<typeof webhookDeliverySummarySchema>;

export const webhookDeliverySchema = webhookDeliverySummarySchema.extend({
  /** Newest first. */
  attemptLog: z.array(webhookAttemptSchema),
  /** The exact bytes sent; null once expired, and the UI shows "expired". */
  body: z.string().nullable(),
});

export type WebhookDelivery = z.output<typeof webhookDeliverySchema>;

/** `GET …/deliveries`: 50 per page, newest first, within the 30-day window. */
export const webhookDeliveryListQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
  eventType: webhookEventTypeSchema.optional(),
  state: webhookDeliveryStateSchema.optional(),
});

export type WebhookDeliveryListQuery = z.output<typeof webhookDeliveryListQuerySchema>;

export const webhookDeliveryListSchema = z.strictObject({
  items: z.array(webhookDeliverySummarySchema),
  nextCursor: cursorSchema.nullable(),
});

export type WebhookDeliveryList = z.output<typeof webhookDeliveryListSchema>;
