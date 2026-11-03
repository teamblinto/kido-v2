import { describe, expect, it } from 'vitest';

import {
  WEBHOOK_CATALOGUE_VERSION,
  WEBHOOK_EVENT_DATA_SCHEMAS,
  WEBHOOK_EVENT_TYPES,
  subscribableEventTypeSchema,
  webhookEnvelopeSchema,
  webhookEventTypeSchema,
} from './catalogue';

const UUID = '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5a';

const envelope = {
  catalogueVersion: '2026-09-23',
  data: { deploymentId: UUID, siteUrl: 'https://acme.sites.example.test' },
  id: UUID,
  occurredAt: '2026-09-23T12:00:00.000Z',
  orgId: UUID,
  projectId: UUID,
  type: 'deploy.succeeded',
} as const;

/** One valid `data` per type, so each strictness case below starts from something that parses. */
const VALID_DATA: Record<(typeof WEBHOOK_EVENT_TYPES)[number], Record<string, unknown>> = {
  'checkpoint.created': { checkpointId: UUID },
  'deploy.failed': { deploymentId: UUID, reason: 'build-failed' },
  'deploy.succeeded': { deploymentId: UUID, siteUrl: 'https://acme.sites.example.test' },
  'domain.activated': { domainId: UUID },
  'domain.drifted': { domainId: UUID },
  'domain.failed': { domainId: UUID, reason: 'caa-blocked' },
  'domain.removed': { domainId: UUID },
  'member.joined': { role: 'member', userId: UUID },
  ping: {},
  'project.archived': {},
  'project.created': { template: 'vite-react' },
  'run.completed': { outcome: 'succeeded', runId: UUID },
  'site.offline': {},
  'site.released': { deploymentId: UUID },
};

describe('webhook event catalogue', () => {
  it('lists exactly the fourteen types of contracts/webhook-delivery.md', () => {
    expect([...WEBHOOK_EVENT_TYPES].sort()).toEqual([
      'checkpoint.created',
      'deploy.failed',
      'deploy.succeeded',
      'domain.activated',
      'domain.drifted',
      'domain.failed',
      'domain.removed',
      'member.joined',
      'ping',
      'project.archived',
      'project.created',
      'run.completed',
      'site.offline',
      'site.released',
    ]);
    expect(WEBHOOK_CATALOGUE_VERSION).toBe('2026-09-23');
  });

  it.each(WEBHOOK_EVENT_TYPES)('%s: data is strict and refuses an extra key', (type) => {
    const schema = WEBHOOK_EVENT_DATA_SCHEMAS[type];

    expect(schema.safeParse(VALID_DATA[type]).success).toBe(true);
    expect(schema.safeParse({ ...VALID_DATA[type], extra: 1 }).success).toBe(false);
  });

  it('parses an envelope and requires catalogueVersion 2026-09-23', () => {
    expect(webhookEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(
      webhookEnvelopeSchema.safeParse({ ...envelope, catalogueVersion: '2026-01-01' }).success,
    ).toBe(false);
    expect(webhookEnvelopeSchema.safeParse({ ...envelope, extra: 1 }).success).toBe(false);
  });

  it('refuses data that belongs to another type', () => {
    expect(webhookEnvelopeSchema.safeParse({ ...envelope, data: { domainId: UUID } }).success).toBe(
      false,
    );
  });

  it('keeps member.joined free of any email', () => {
    const shape = WEBHOOK_EVENT_DATA_SCHEMAS['member.joined'].shape;

    expect(Object.keys(shape).sort()).toEqual(['role', 'userId']);
    expect(
      WEBHOOK_EVENT_DATA_SCHEMAS['member.joined'].safeParse({
        email: 'a@b.test',
        role: 'member',
        userId: UUID,
      }).success,
    ).toBe(false);
  });

  it('refuses ping as a subscribable type, and accepts it as an event type', () => {
    expect(subscribableEventTypeSchema.safeParse('ping').success).toBe(false);
    expect(subscribableEventTypeSchema.safeParse('deploy.succeeded').success).toBe(true);
    expect(webhookEventTypeSchema.safeParse('ping').success).toBe(true);
  });
});
