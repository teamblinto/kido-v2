import type {
  CreateWebhookEndpointRequest,
  RotateWebhookSecretRequest,
  UpdateWebhookEndpointRequest,
  WebhookDeliveryListQuery,
} from '@repo/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  getWebhookDelivery,
  listWebhookDeliveries,
  listWebhookEndpoints,
  replayWebhookDelivery,
  rotateWebhookSecret,
  sendWebhookTest,
  updateWebhookEndpoint,
} from './webhooks-api';

export function webhookEndpointsKey(orgId: string): readonly unknown[] {
  return ['webhooks', orgId, 'endpoints'];
}

export function useWebhookEndpoints(orgId: string) {
  return useQuery({
    enabled: orgId !== '',
    queryFn: ({ signal }) => listWebhookEndpoints(orgId, signal),
    queryKey: webhookEndpointsKey(orgId),
  });
}

function useInvalidate(orgId: string): () => Promise<void> {
  const queryClient = useQueryClient();

  return () => queryClient.invalidateQueries({ queryKey: webhookEndpointsKey(orgId) });
}

export function useCreateWebhookEndpoint(orgId: string) {
  const invalidate = useInvalidate(orgId);

  return useMutation({
    mutationFn: (body: CreateWebhookEndpointRequest) => createWebhookEndpoint(orgId, body),
    onSuccess: invalidate,
  });
}

export function useUpdateWebhookEndpoint(orgId: string) {
  const invalidate = useInvalidate(orgId);

  return useMutation({
    mutationFn: ({ body, id }: { body: UpdateWebhookEndpointRequest; id: string }) =>
      updateWebhookEndpoint(orgId, id, body),
    onSuccess: invalidate,
  });
}

export function useDeleteWebhookEndpoint(orgId: string) {
  const invalidate = useInvalidate(orgId);

  return useMutation({
    mutationFn: (endpointId: string) => deleteWebhookEndpoint(orgId, endpointId),
    onSuccess: invalidate,
  });
}

export function useRotateWebhookSecret(orgId: string) {
  const invalidate = useInvalidate(orgId);

  return useMutation({
    mutationFn: ({ body, id }: { body: RotateWebhookSecretRequest; id: string }) =>
      rotateWebhookSecret(orgId, id, body),
    onSuccess: invalidate,
  });
}

/** Send test creates a `ping` delivery; the summary comes back `pending`. */
export function useSendWebhookTest(orgId: string) {
  const invalidate = useInvalidate(orgId);

  return useMutation({
    mutationFn: (endpointId: string) => sendWebhookTest(orgId, endpointId),
    onSuccess: invalidate,
  });
}

export function webhookDeliveriesKey(orgId: string, endpointId: string): readonly unknown[] {
  return ['webhooks', orgId, 'endpoints', endpointId, 'deliveries'];
}

/** The first page of an endpoint's delivery log, under its filters. */
export function useWebhookDeliveries(
  orgId: string,
  endpointId: string,
  query: WebhookDeliveryListQuery,
) {
  return useQuery({
    queryFn: ({ signal }) => listWebhookDeliveries(orgId, endpointId, query, signal),
    queryKey: [...webhookDeliveriesKey(orgId, endpointId), 'list', query],
  });
}

export function useWebhookDelivery(orgId: string, endpointId: string, deliveryId: string | null) {
  return useQuery({
    enabled: deliveryId !== null,
    queryFn: ({ signal }) => getWebhookDelivery(orgId, endpointId, deliveryId!, signal),
    queryKey: [...webhookDeliveriesKey(orgId, endpointId), 'one', deliveryId],
  });
}

/** Replay (R11); the log and the open delivery are read again afterwards. */
export function useReplayWebhookDelivery(orgId: string, endpointId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (deliveryId: string) => replayWebhookDelivery(orgId, endpointId, deliveryId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: webhookDeliveriesKey(orgId, endpointId) }),
  });
}
