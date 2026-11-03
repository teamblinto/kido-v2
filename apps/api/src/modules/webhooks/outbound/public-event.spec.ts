import { WEBHOOK_CATALOGUE_VERSION, webhookEnvelopeSchema } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import type { Envelope } from '../../outbox/envelope';
import type { EventPayload, EventType } from '../../outbox/events';
import { INTERNAL_SOURCES, serialiseEnvelope, toPublicEvent } from './public-event';

const ORG = '0f000000-0000-4000-8000-000000000001';
const PROJECT = '0f000000-0000-4000-8000-000000000002';
const ID = '0f000000-0000-4000-8000-000000000003';
const OTHER = '0f000000-0000-4000-8000-000000000004';
const EVENT_ID = '0f000000-0000-4000-8000-0000000000ee';
const OCCURRED_AT = '2026-09-23T12:00:00.000Z';
const SITE_DOMAIN = 'forge-site.example';

function internal<T extends EventType>(type: T, payload: EventPayload<T>): Envelope<T> {
  return {
    aggregate: 'test',
    aggregateId: ID,
    eventId: EVENT_ID,
    occurredAt: OCCURRED_AT,
    orgId: ORG,
    payload,
    traceId: null,
    type,
  };
}

const deployment = { deploymentId: ID, orgId: ORG, projectId: PROJECT };
const domain = { domainId: ID, orgId: ORG, projectId: PROJECT };

/** Each of the 13 internal sources, with the public type and data research R4 maps it to. */
const CASES: readonly (readonly [Envelope, string, Record<string, unknown>, string | null])[] = [
  [
    internal('agent-run.finished', {
      orgId: ORG,
      outcome: 'cancelled',
      projectId: PROJECT,
      runId: ID,
    }),
    'run.completed',
    { outcome: 'cancelled', runId: ID },
    PROJECT,
  ],
  [
    internal('deploy.succeeded', { ...deployment, siteLabel: 'bright-otter-42' }),
    'deploy.succeeded',
    { deploymentId: ID, siteUrl: `https://bright-otter-42.${SITE_DOMAIN}` },
    PROJECT,
  ],
  [
    internal('deploy.failed', { ...deployment, reason: 'build-failed' }),
    'deploy.failed',
    { deploymentId: ID, reason: 'build-failed' },
    PROJECT,
  ],
  [internal('site.released', deployment), 'site.released', { deploymentId: ID }, PROJECT],
  [internal('site.offline', { orgId: ORG, projectId: PROJECT }), 'site.offline', {}, PROJECT],
  [internal('domain.activated', domain), 'domain.activated', { domainId: ID }, PROJECT],
  [internal('domain.drifted', domain), 'domain.drifted', { domainId: ID }, PROJECT],
  [
    internal('domain.failed', { ...domain, reason: 'ownership-not-found' }),
    'domain.failed',
    { domainId: ID, reason: 'ownership-not-found' },
    PROJECT,
  ],
  [internal('domain.removed', domain), 'domain.removed', { domainId: ID }, PROJECT],
  [
    internal('project.created', {
      actorId: OTHER,
      orgId: ORG,
      projectId: PROJECT,
      template: 'vite-react',
      workspaceId: OTHER,
    }),
    'project.created',
    { template: 'vite-react' },
    PROJECT,
  ],
  [
    internal('project.archived', {
      actorId: OTHER,
      orgId: ORG,
      projectId: PROJECT,
      workspaceId: OTHER,
    }),
    'project.archived',
    {},
    PROJECT,
  ],
  [
    internal('checkpoint.created', { checkpointId: ID, orgId: ORG, projectId: PROJECT }),
    'checkpoint.created',
    { checkpointId: ID },
    PROJECT,
  ],
  [
    internal('member.joined', { orgId: ORG, role: 'admin', userId: OTHER }),
    'member.joined',
    { role: 'admin', userId: OTHER },
    null,
  ],
];

describe('toPublicEvent', () => {
  it('covers all 13 internal sources', () => {
    expect(CASES).toHaveLength(13);
    expect([...INTERNAL_SOURCES].sort()).toEqual(CASES.map(([event]) => event.type).sort());
  });

  it.each(CASES)(
    'maps $type to its public type and data, parsing the contract',
    (event, type, data, projectId) => {
      const published = toPublicEvent(event, { siteDomain: SITE_DOMAIN });

      expect(published).toEqual({
        catalogueVersion: WEBHOOK_CATALOGUE_VERSION,
        data,
        id: EVENT_ID,
        occurredAt: OCCURRED_AT,
        orgId: ORG,
        projectId,
        type,
      });
      expect(webhookEnvelopeSchema.safeParse(published).success).toBe(true);
    },
  );

  it('builds deploy.succeeded siteUrl from siteLabel and SITE_DOMAIN', () => {
    const published = toPublicEvent(
      internal('deploy.succeeded', { ...deployment, siteLabel: 'calm-fox-7' }),
      { siteDomain: 'sites.forge.test' },
    );
    expect(published?.data).toEqual({
      deploymentId: ID,
      siteUrl: 'https://calm-fox-7.sites.forge.test',
    });
  });

  it('returns null for an unmapped internal type', () => {
    expect(toPublicEvent(internal('domain.added', domain), { siteDomain: SITE_DOMAIN })).toBeNull();
    expect(
      toPublicEvent(internal('deploy.requested', deployment), { siteDomain: SITE_DOMAIN }),
    ).toBeNull();
  });
});

describe('serialiseEnvelope', () => {
  it('sorts keys at every level and is byte-stable across calls', () => {
    const published = toPublicEvent(
      internal('deploy.succeeded', { ...deployment, siteLabel: 'bright-otter-42' }),
      { siteDomain: SITE_DOMAIN },
    )!;
    const siteUrl = `https://bright-otter-42.${SITE_DOMAIN}`;
    const reordered = { ...published, data: { siteUrl, deploymentId: ID } };

    const first = serialiseEnvelope(published);
    expect(serialiseEnvelope(reordered as typeof published)).toBe(first);
    expect(serialiseEnvelope(published)).toBe(first);
    expect(first).toBe(
      `{"catalogueVersion":"${WEBHOOK_CATALOGUE_VERSION}","data":{"deploymentId":"${ID}","siteUrl":"https://bright-otter-42.${SITE_DOMAIN}"},"id":"${EVENT_ID}","occurredAt":"${OCCURRED_AT}","orgId":"${ORG}","projectId":"${PROJECT}","type":"deploy.succeeded"}`,
    );
  });
});
