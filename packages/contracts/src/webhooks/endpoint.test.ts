import { describe, expect, it } from 'vitest';

import {
  WEBHOOK_CONFLICT_REASONS,
  createWebhookEndpointRequestSchema,
  updateWebhookEndpointRequestSchema,
  webhookDeliveryListQuerySchema,
  webhookDeliveryListSchema,
  webhookDeliverySchema,
  webhookEndpointListSchema,
  webhookEndpointSchema,
  webhookSecretResponseSchema,
} from './endpoint';

const UUID = '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5a';
const AT = '2026-09-23T10:00:00.000Z';

const endpoint = {
  createdAt: AT,
  description: '',
  eventTypes: ['deploy.succeeded'],
  id: UUID,
  lastFailure: null,
  lastSuccessAt: null,
  pausedAt: null,
  projectIds: [],
  secretRotation: null,
  state: 'enabled',
  url: 'https://hooks.example.com/x',
} as const;

describe('webhook endpoint contracts', () => {
  it('parses a create request and fills its defaults', () => {
    expect(
      createWebhookEndpointRequestSchema.parse({
        eventTypes: ['deploy.succeeded'],
        url: ' https://hooks.example.com/x ',
      }),
    ).toEqual({
      description: '',
      eventTypes: ['deploy.succeeded'],
      projectIds: [],
      url: 'https://hooks.example.com/x',
    });
  });

  it.each([
    ['an unknown key', { eventTypes: ['deploy.succeeded'], url: 'https://a.test', secret: 'x' }],
    ['empty eventTypes', { eventTypes: [], url: 'https://a.test' }],
    ['ping as an event type', { eventTypes: ['ping'], url: 'https://a.test' }],
    [
      'a url over 2,048 characters',
      { eventTypes: ['deploy.succeeded'], url: `https://a.test/${'x'.repeat(2048)}` },
    ],
  ])('refuses a create request with %s', (_, body) => {
    expect(createWebhookEndpointRequestSchema.safeParse(body).success).toBe(false);
  });

  it('refuses an empty update, and accepts one key', () => {
    expect(updateWebhookEndpointRequestSchema.safeParse({}).success).toBe(false);
    expect(updateWebhookEndpointRequestSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(updateWebhookEndpointRequestSchema.safeParse({ extra: 1 }).success).toBe(false);
  });

  it('requires the secret to start with whsec_', () => {
    expect(webhookSecretResponseSchema.safeParse({ endpoint, secret: 'whsec_abc' }).success).toBe(
      true,
    );
    expect(webhookSecretResponseSchema.safeParse({ endpoint, secret: 'abc' }).success).toBe(false);
  });

  it('never carries a secret on the endpoint', () => {
    expect(Object.keys(webhookEndpointSchema.shape)).not.toContain('secret');
    expect(webhookEndpointSchema.safeParse({ ...endpoint, secret: 'whsec_abc' }).success).toBe(
      false,
    );
  });

  it('lists endpoints as {items}, each without a secret', () => {
    expect(webhookEndpointListSchema.safeParse({ items: [endpoint] }).success).toBe(true);
    expect(webhookEndpointListSchema.safeParse({ items: [] }).success).toBe(true);
    expect(webhookEndpointListSchema.safeParse({ items: [], nextCursor: null }).success).toBe(
      false,
    );
    expect(
      webhookEndpointListSchema.safeParse({ items: [{ ...endpoint, secret: 'whsec_abc' }] })
        .success,
    ).toBe(false);
  });

  it('lists the seven conflict reasons, sorted', () => {
    expect(WEBHOOK_CONFLICT_REASONS).toEqual([
      'delivery-expired',
      'delivery-in-flight',
      'destination-not-allowed',
      'endpoint-limit',
      'endpoint-not-enabled',
      'invalid-url',
      'project-not-in-org',
    ]);
    expect([...WEBHOOK_CONFLICT_REASONS].sort()).toEqual([...WEBHOOK_CONFLICT_REASONS]);
  });

  it('parses a delivery with its attempt log and an expired body', () => {
    expect(
      webhookDeliverySchema.safeParse({
        attemptLog: [
          {
            address: '1.1.1.1',
            attemptedAt: AT,
            durationMs: 12,
            failure: 'http-error',
            manual: false,
            responseBody: null,
            responseHeaders: { 'content-type': 'text/plain' },
            status: 500,
          },
        ],
        attempts: 1,
        body: null,
        createdAt: AT,
        eventId: UUID,
        eventType: 'ping',
        id: UUID,
        lastFailure: 'http-error',
        nextAttemptAt: AT,
        projectId: null,
        state: 'pending',
      }).success,
    ).toBe(true);
  });

  it('parses the delivery list query strictly, and a page with its cursor', () => {
    expect(
      webhookDeliveryListQuerySchema.safeParse({ eventType: 'ping', state: 'failed' }).success,
    ).toBe(true);
    expect(webhookDeliveryListQuerySchema.safeParse({ state: 'cancelled' }).success).toBe(false);
    expect(webhookDeliveryListQuerySchema.safeParse({ limit: '10' }).success).toBe(false);
    expect(webhookDeliveryListSchema.safeParse({ items: [], nextCursor: null }).success).toBe(true);
    expect(webhookDeliveryListSchema.safeParse({ items: [], nextCursor: 'a/b' }).success).toBe(
      false,
    );
  });
});
