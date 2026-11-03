import {
  type CreateWebhookEndpointRequest,
  type RotateWebhookSecretRequest,
  type UpdateWebhookEndpointRequest,
  type WebhookDelivery,
  type WebhookDeliveryList,
  type WebhookDeliveryListQuery,
  type WebhookDeliverySummary,
  type WebhookEndpoint,
  type WebhookSecretResponse,
  createWebhookEndpointRequestSchema,
  rotateWebhookSecretRequestSchema,
  updateWebhookEndpointRequestSchema,
  webhookDeliveryListSchema,
  webhookDeliverySchema,
  webhookDeliverySummarySchema,
  webhookEndpointSchema,
  webhookSecretResponseSchema,
} from '@repo/contracts';
import { z } from 'zod';

import { apiRequest } from '@/lib/api/client';

/** contracts/webhook-endpoints.md (spec 029): everything sits under `/orgs/:orgId/webhooks`. */
function path(orgId: string, rest = ''): string {
  return `/orgs/${encodeURIComponent(orgId)}/webhooks/endpoints${rest}`;
}

function endpointPath(orgId: string, endpointId: string, rest = ''): string {
  return path(orgId, `/${encodeURIComponent(endpointId)}${rest}`);
}

const endpointListSchema = z.strictObject({ items: z.array(webhookEndpointSchema) });

export async function listWebhookEndpoints(
  orgId: string,
  signal?: AbortSignal,
): Promise<WebhookEndpoint[]> {
  const { items } = await apiRequest('GET', path(orgId), { schema: endpointListSchema, signal });

  return items;
}

export function createWebhookEndpoint(
  orgId: string,
  body: CreateWebhookEndpointRequest,
): Promise<WebhookSecretResponse> {
  return apiRequest('POST', path(orgId), {
    body: createWebhookEndpointRequestSchema.parse(body),
    schema: webhookSecretResponseSchema,
  });
}

export function updateWebhookEndpoint(
  orgId: string,
  endpointId: string,
  body: UpdateWebhookEndpointRequest,
): Promise<WebhookEndpoint> {
  return apiRequest('PATCH', endpointPath(orgId, endpointId), {
    body: updateWebhookEndpointRequestSchema.parse(body),
    schema: webhookEndpointSchema,
  });
}

export function deleteWebhookEndpoint(orgId: string, endpointId: string): Promise<void> {
  return apiRequest('DELETE', endpointPath(orgId, endpointId));
}

/** Rotate (US5): the one response besides create that carries the secret. */
export function rotateWebhookSecret(
  orgId: string,
  endpointId: string,
  body: RotateWebhookSecretRequest,
): Promise<WebhookSecretResponse> {
  return apiRequest('POST', endpointPath(orgId, endpointId, '/rotate-secret'), {
    body: rotateWebhookSecretRequestSchema.parse(body),
    schema: webhookSecretResponseSchema,
  });
}

export function sendWebhookTest(
  orgId: string,
  endpointId: string,
): Promise<WebhookDeliverySummary> {
  return apiRequest('POST', endpointPath(orgId, endpointId, '/test'), {
    schema: webhookDeliverySummarySchema,
  });
}

function deliveriesPath(orgId: string, endpointId: string, rest = ''): string {
  return endpointPath(orgId, endpointId, `/deliveries${rest}`);
}

/** One page of an endpoint's delivery log (US4): only the filters that are set go on the query. */
export function listWebhookDeliveries(
  orgId: string,
  endpointId: string,
  query: WebhookDeliveryListQuery,
  signal?: AbortSignal,
): Promise<WebhookDeliveryList> {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) search.set(key, value);
  }
  const suffix = search.size === 0 ? '' : `?${search.toString()}`;

  return apiRequest('GET', deliveriesPath(orgId, endpointId, suffix), {
    schema: webhookDeliveryListSchema,
    signal,
  });
}

export function getWebhookDelivery(
  orgId: string,
  endpointId: string,
  deliveryId: string,
  signal?: AbortSignal,
): Promise<WebhookDelivery> {
  return apiRequest(
    'GET',
    deliveriesPath(orgId, endpointId, `/${encodeURIComponent(deliveryId)}`),
    {
      schema: webhookDeliverySchema,
      signal,
    },
  );
}

export function replayWebhookDelivery(
  orgId: string,
  endpointId: string,
  deliveryId: string,
): Promise<WebhookDeliverySummary> {
  return apiRequest(
    'POST',
    deliveriesPath(orgId, endpointId, `/${encodeURIComponent(deliveryId)}/replay`),
    { schema: webhookDeliverySummarySchema },
  );
}
