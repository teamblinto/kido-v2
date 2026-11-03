import { z } from 'zod';

import { deploymentFailureReasonSchema } from '../deploy/deployment';
import { domainFailureReasonSchema } from '../deploy/domain';
import { orgRoleSchema } from '../tenancy/membership';
import { projectTemplateSchema } from '../tenancy/project';

/**
 * The public webhook event catalogue (spec 029, contracts/webhook-delivery.md § Event catalogue,
 * research R4). This is what a customer's receiver is written against, so it is versioned: a
 * change to any shape below is a new `WEBHOOK_CATALOGUE_VERSION`, never an edit in place.
 *
 * Data is ids, closed-vocabulary states and reasons, and one URL. No personal data: `member.joined`
 * names the user by id and never carries an email. Every schema is strict, so the API can never
 * send a key the contract does not publish.
 */

export const WEBHOOK_CATALOGUE_VERSION = '2026-09-23';

export const WEBHOOK_EVENT_TYPES = [
  'run.completed',
  'deploy.succeeded',
  'deploy.failed',
  'site.released',
  'site.offline',
  'domain.activated',
  'domain.drifted',
  'domain.failed',
  'domain.removed',
  'project.created',
  'project.archived',
  'checkpoint.created',
  'member.joined',
  'ping',
] as const;

export const webhookEventTypeSchema = z.enum(WEBHOOK_EVENT_TYPES);

export type WebhookEventType = z.output<typeof webhookEventTypeSchema>;

/** What an endpoint may subscribe to: every type except `ping`, which is sent only on request. */
export const subscribableEventTypeSchema = webhookEventTypeSchema.exclude(['ping']);

export type SubscribableEventType = z.output<typeof subscribableEventTypeSchema>;

const empty = z.strictObject({});

/** One strict `data` schema per type. */
export const WEBHOOK_EVENT_DATA_SCHEMAS = {
  'checkpoint.created': z.strictObject({ checkpointId: z.uuid() }),
  'deploy.failed': z.strictObject({
    deploymentId: z.uuid(),
    reason: deploymentFailureReasonSchema,
  }),
  'deploy.succeeded': z.strictObject({ deploymentId: z.uuid(), siteUrl: z.url() }),
  'domain.activated': z.strictObject({ domainId: z.uuid() }),
  'domain.drifted': z.strictObject({ domainId: z.uuid() }),
  'domain.failed': z.strictObject({ domainId: z.uuid(), reason: domainFailureReasonSchema }),
  'domain.removed': z.strictObject({ domainId: z.uuid() }),
  'member.joined': z.strictObject({ role: orgRoleSchema, userId: z.uuid() }),
  ping: empty,
  'project.archived': empty,
  'project.created': z.strictObject({ template: projectTemplateSchema }),
  'run.completed': z.strictObject({
    outcome: z.enum(['succeeded', 'failed', 'cancelled']),
    runId: z.uuid(),
  }),
  'site.offline': empty,
  'site.released': z.strictObject({ deploymentId: z.uuid() }),
} as const satisfies Record<WebhookEventType, z.ZodObject>;

/** The types whose envelope carries no project. */
const ORG_LEVEL_TYPES: readonly WebhookEventType[] = ['member.joined', 'ping'];

function envelopeOf<T extends WebhookEventType>(type: T) {
  return z.strictObject({
    catalogueVersion: z.literal(WEBHOOK_CATALOGUE_VERSION),
    data: WEBHOOK_EVENT_DATA_SCHEMAS[type],
    id: z.uuid(),
    occurredAt: z.iso.datetime(),
    orgId: z.uuid(),
    projectId: ORG_LEVEL_TYPES.includes(type) ? z.null() : z.uuid(),
    type: z.literal(type),
  });
}

/** The body a receiver gets: keys sorted, serialised once, signed as those exact bytes. */
export const webhookEnvelopeSchema = z.discriminatedUnion('type', [
  envelopeOf('run.completed'),
  envelopeOf('deploy.succeeded'),
  envelopeOf('deploy.failed'),
  envelopeOf('site.released'),
  envelopeOf('site.offline'),
  envelopeOf('domain.activated'),
  envelopeOf('domain.drifted'),
  envelopeOf('domain.failed'),
  envelopeOf('domain.removed'),
  envelopeOf('project.created'),
  envelopeOf('project.archived'),
  envelopeOf('checkpoint.created'),
  envelopeOf('member.joined'),
  envelopeOf('ping'),
]);

export type WebhookEnvelope = z.output<typeof webhookEnvelopeSchema>;
