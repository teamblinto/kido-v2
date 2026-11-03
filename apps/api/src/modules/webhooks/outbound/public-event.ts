/**
 * Internal outbox events → the public webhook catalogue (spec 029 research R4,
 * contracts/webhook-delivery.md § Event catalogue).
 *
 * The public schema is separate from the internal payload, so an internal event can change without
 * breaking a receiver; the mapping below is the only place the two meet. Data is ids, closed
 * vocabularies and one URL: internal-only keys (`actorId`, `workspaceId`, `siteLabel`) never
 * reach a receiver.
 */
import {
  WEBHOOK_CATALOGUE_VERSION,
  type WebhookEnvelope,
  type WebhookEventType,
} from '@repo/contracts';

import type { Envelope } from '../../outbox/envelope';
import type { EventPayload, EventType } from '../../outbox/events';

export interface PublicEventContext {
  /** `SITE_DOMAIN`: deployed sites are served at `https://<siteLabel>.<SITE_DOMAIN>`. */
  readonly siteDomain: string;
}

interface Mapping<T extends EventType> {
  readonly type: WebhookEventType;
  readonly projectId: (payload: EventPayload<T>) => string | null;
  readonly data: (payload: EventPayload<T>, context: PublicEventContext) => object;
}

const project = (payload: { readonly projectId: string }) => payload.projectId;

const MAPPINGS: { readonly [T in EventType]?: Mapping<T> } = {
  'agent-run.finished': {
    data: ({ outcome, runId }) => ({ outcome, runId }),
    projectId: project,
    type: 'run.completed',
  },
  'checkpoint.created': {
    data: ({ checkpointId }) => ({ checkpointId }),
    projectId: project,
    type: 'checkpoint.created',
  },
  'deploy.failed': {
    data: ({ deploymentId, reason }) => ({ deploymentId, reason }),
    projectId: project,
    type: 'deploy.failed',
  },
  'deploy.succeeded': {
    data: ({ deploymentId, siteLabel }, { siteDomain }) => ({
      deploymentId,
      siteUrl: `https://${siteLabel}.${siteDomain}`,
    }),
    projectId: project,
    type: 'deploy.succeeded',
  },
  'domain.activated': {
    data: ({ domainId }) => ({ domainId }),
    projectId: project,
    type: 'domain.activated',
  },
  'domain.drifted': {
    data: ({ domainId }) => ({ domainId }),
    projectId: project,
    type: 'domain.drifted',
  },
  'domain.failed': {
    data: ({ domainId, reason }) => ({ domainId, reason }),
    projectId: project,
    type: 'domain.failed',
  },
  'domain.removed': {
    data: ({ domainId }) => ({ domainId }),
    projectId: project,
    type: 'domain.removed',
  },
  'member.joined': {
    data: ({ role, userId }) => ({ role, userId }),
    projectId: () => null,
    type: 'member.joined',
  },
  'project.archived': { data: () => ({}), projectId: project, type: 'project.archived' },
  'project.created': {
    data: ({ template }) => ({ template }),
    projectId: project,
    type: 'project.created',
  },
  'site.offline': { data: () => ({}), projectId: project, type: 'site.offline' },
  'site.released': {
    data: ({ deploymentId }) => ({ deploymentId }),
    projectId: project,
    type: 'site.released',
  },
};

/** The internal types the fan-out consumes: exactly those with a public mapping. */
export const INTERNAL_SOURCES = Object.keys(MAPPINGS) as readonly EventType[];

/** The public envelope for an internal event, or null when the type is not published. */
export function toPublicEvent<T extends EventType>(
  event: Envelope<T>,
  context: PublicEventContext,
): WebhookEnvelope | null {
  const mapping = MAPPINGS[event.type];
  if (mapping === undefined || event.orgId === null) return null;
  return {
    catalogueVersion: WEBHOOK_CATALOGUE_VERSION,
    data: mapping.data(event.payload, context),
    id: event.eventId,
    occurredAt: event.occurredAt,
    orgId: event.orgId,
    projectId: mapping.projectId(event.payload),
    type: mapping.type,
  } as WebhookEnvelope;
}

/** The exact bytes sent and signed: JSON with keys sorted at every level, no whitespace. */
export function serialiseEnvelope(envelope: WebhookEnvelope): string {
  return JSON.stringify(sortKeys(envelope));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
  );
}
