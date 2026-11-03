import {
  deploymentFailureReasonSchema,
  domainFailureReasonSchema,
  llmProviderSchema,
  orgRoleSchema,
  projectTemplateSchema,
} from '@repo/contracts';
import { z } from 'zod';

/**
 * The closed catalogue of domain events, and the review point for "ids, never contents" (§10).
 *
 * Every event a producer may append is a key here, with the aggregate it belongs to and a
 * `z.strictObject` for its payload. Strict, so an undeclared key is a refused write rather than a
 * name or an address riding along into Redis; the schema is the place a reviewer sees what a
 * payload carries. A record rather than a registry the modules add to at runtime, so `EventType`
 * is a compile-time union and an exhaustive switch over it stops compiling when an entry is added
 * — the discipline `mailer.port.ts` applies to template ids.
 *
 * The four `mail.*` entries carry the recipient and the row id, never the token, link, subject or
 * body — the consumer issues the token and renders (spec 006, ADR 030). The recipient rides along
 * because verification records the address the flow was asked to mail, not the user's current one.
 *
 * `outbox.probe` is the one test-only entry and stays in shipped code: `EventType` is a closed
 * union a test cannot extend, and the two ways to hide it — an environment-conditional catalogue
 * or a runtime `registerEvent()` — are both worse than a documented probe (spec 006 research R8).
 * No shipped consumer routes it, so a probe appended in production is marked published with one
 * `warn`.
 *
 * The two `project.*` entries (spec 007) carry ids and the template slug, never the name — a name
 * is content, and the consumer that wants one reads the row.
 *
 * `agent-run.requested` (spec 008) is how a run reaches a worker: appended on create, on input and
 * on resume, so every path back into a run is the same consumer path. Ids only — the prompt is a
 * `run_messages` row the worker reads under its own tenant transaction.
 *
 * `sandbox.op.requested` and `maintenance.due` (spec 014) carry a target id and an op, or a job
 * and its period — `aggregateId` is the sandbox / pool id, or `${job}:${periodStart}` as the
 * scheduler's durable dedupe key (research R7). Labels, owners and names stay in the rows.
 *
 * `checkpoint.created` (spec 016) fires in the row's own transaction; ids only — the mirror
 * consumer reads the checkpoint row for the git sha.
 *
 * `project.preview-label.rotated` (spec 017) fires on the same handle as the `projects` update
 * and the audit row (FR-040). Ids and the rotated-away label only — `PreviewRotationConsumer`
 * uses it to write the `pv:revoked:<label>` marker, never a name.
 *
 * The three `deploy.*` and two `site.*` entries (spec 027 data-model § Events) fire in the
 * transaction that moves the deployment or the site pointer. Ids, the public site label and the
 * failure reason from its closed vocabulary only — never a log line, an artifact key or a file.
 * `deploy.requested` is `BuildDeployConsumer`'s; the other four have no consumer yet.
 *
 * The nine `domain.*` entries and `mail.domain` (spec 028 data-model § Events) fire in the
 * transaction that moves a custom domain. Ids, and the failure reason from its closed vocabulary,
 * only — never the hostname, the ownership token or a DNS answer, which the consumer reads from the
 * row. `domain.removing` and `domain.check-requested` are `DomainCheckConsumer`'s; the rest have no
 * consumer yet. `mail.domain` is one event per recipient: the recipient is a user id, not an address
 * (the consumer resolves it at send time), and `notice` is the closed set of domain mails.
 *
 * Spec 029 (data-model § 7) adds five. `agent-run.finished` and `member.joined` fire at existing
 * state changes (a run's terminal transition, an accepted invitation) so the webhook fan-out has a
 * source for `run.completed` and `member.joined`; ids and a closed outcome or role only — never a
 * prompt, a name or an email. `webhook.attempt-due` names one send, `webhook.endpoint-paused` one
 * endpoint; the URL, the body and the secret stay in the rows. `mail.webhook` is one event per
 * recipient, as `mail.domain` is: a user id, and `notice` is the closed set of webhook mails.
 *
 * Spec 031 (data-model § 4) adds two. `project.access-removed` fires when a grant is removed or
 * lowered below `project:agent.run`, so that user's runs on that project stop; ids only.
 * `mail.project-invitation` carries the org and the invitation row id — the consumer reads the
 * address and re-mints the token, as `mail.invitation` does.
 */
// `next` (spec 031, R7): a same-origin relative return address, carried from sign-up to the link.
const mailPayload = z.strictObject({
  next: z.string().max(2048).optional(),
  recipient: z.email(),
  userId: z.uuid(),
});
const deploymentIds = { deploymentId: z.uuid(), orgId: z.uuid(), projectId: z.uuid() };
const domainIds = { domainId: z.uuid(), orgId: z.uuid(), projectId: z.uuid() };

export const EVENTS = {
  'agent-run.finished': {
    aggregate: 'agent-run',
    payload: z.strictObject({
      orgId: z.uuid(),
      outcome: z.enum(['succeeded', 'failed', 'cancelled']),
      projectId: z.uuid(),
      runId: z.uuid(),
    }),
  },
  'agent-run.requested': {
    aggregate: 'agent-run',
    payload: z.strictObject({ orgId: z.uuid(), projectId: z.uuid(), runId: z.uuid() }),
  },
  'checkpoint.created': {
    aggregate: 'checkpoint',
    payload: z.strictObject({ checkpointId: z.uuid(), orgId: z.uuid(), projectId: z.uuid() }),
  },
  /** Spec 030 R15: one queued provider write; the consumer reads the operation row — ids only. */
  'connector.op.requested': {
    aggregate: 'connector-operation',
    payload: z.strictObject({ operationId: z.uuid(), orgId: z.uuid() }),
  },
  'deploy.failed': {
    aggregate: 'deployment',
    payload: z.strictObject({ ...deploymentIds, reason: deploymentFailureReasonSchema }),
  },
  'deploy.requested': { aggregate: 'deployment', payload: z.strictObject(deploymentIds) },
  'deploy.succeeded': {
    aggregate: 'deployment',
    payload: z.strictObject({ ...deploymentIds, siteLabel: z.string() }),
  },
  'domain.activated': { aggregate: 'domain', payload: z.strictObject(domainIds) },
  'domain.added': { aggregate: 'domain', payload: z.strictObject(domainIds) },
  'domain.check-requested': { aggregate: 'domain', payload: z.strictObject(domainIds) },
  'domain.drifted': { aggregate: 'domain', payload: z.strictObject(domainIds) },
  'domain.failed': {
    aggregate: 'domain',
    payload: z.strictObject({ ...domainIds, reason: domainFailureReasonSchema }),
  },
  'domain.recovered': { aggregate: 'domain', payload: z.strictObject(domainIds) },
  'domain.removed': { aggregate: 'domain', payload: z.strictObject(domainIds) },
  /** `reason` is null when a member asked for the removal, the failure reason otherwise. */
  'domain.removing': {
    aggregate: 'domain',
    payload: z.strictObject({ ...domainIds, reason: domainFailureReasonSchema.nullable() }),
  },
  'domain.retried': { aggregate: 'domain', payload: z.strictObject(domainIds) },
  'mail.account-exists': { aggregate: 'user', payload: mailPayload },
  /**
   * Spec 032 contracts § 6: one mail about a person's linked subscription. A user id, never an
   * address or an organisation; the consumer asks identity for the address (R1).
   */
  'mail.byos': {
    aggregate: 'linked-account',
    payload: z.strictObject({
      kind: z.enum(['needs-reauth', 'provider-withdrawn']),
      provider: llmProviderSchema,
      recipientUserId: z.uuid(),
    }),
  },
  'mail.domain': {
    aggregate: 'domain',
    payload: z.strictObject({
      domainId: z.uuid(),
      notice: z.enum(['drifted', 'release-warning', 'released', 'failed']),
      recipient: z.uuid(),
    }),
  },
  'maintenance.due': {
    aggregate: 'maintenance',
    payload: z.strictObject({
      job: z.enum([
        'sandbox.sweep',
        'sandbox.refill',
        'sandbox.reconcile',
        'connector.verify',
        'connector.ops-timeout',
        'byok.verify',
        'byos.verify',
        'webhook.retention',
        'deploy.sweep',
        'domain.check',
        'webhook.redeliver',
      ]),
      periodStart: z.iso.datetime(),
    }),
  },
  'mail.webhook': {
    aggregate: 'webhook-endpoint',
    payload: z.strictObject({
      endpointId: z.uuid(),
      notice: z.enum(['paused']),
      orgId: z.uuid(),
      /** Which pause: with the endpoint it keys the mail's job id, so each pause mails once. */
      pausedAt: z.iso.datetime(),
      recipientUserId: z.uuid(),
    }),
  },
  'mail.email-verification': { aggregate: 'user', payload: mailPayload },
  'mail.invitation': {
    aggregate: 'invitation',
    payload: z.strictObject({ invitationId: z.uuid(), recipient: z.email() }),
  },
  'mail.password-reset': { aggregate: 'user', payload: mailPayload },
  'mail.project-invitation': {
    aggregate: 'project-invitation',
    payload: z.strictObject({ invitationId: z.uuid(), orgId: z.uuid() }),
  },
  'member.joined': {
    aggregate: 'membership',
    payload: z.strictObject({ orgId: z.uuid(), role: orgRoleSchema, userId: z.uuid() }),
  },
  'outbox.probe': { aggregate: 'probe', payload: z.strictObject({ probeId: z.uuid() }) },
  'project.access-removed': {
    aggregate: 'project',
    payload: z.strictObject({ orgId: z.uuid(), projectId: z.uuid(), userId: z.uuid() }),
  },
  'project.archived': {
    aggregate: 'project',
    payload: z.strictObject({
      actorId: z.uuid(),
      orgId: z.uuid(),
      projectId: z.uuid(),
      workspaceId: z.uuid(),
    }),
  },
  'project.created': {
    aggregate: 'project',
    payload: z.strictObject({
      actorId: z.uuid(),
      orgId: z.uuid(),
      projectId: z.uuid(),
      template: projectTemplateSchema,
      workspaceId: z.uuid(),
    }),
  },
  'project.preview-label.rotated': {
    aggregate: 'project',
    payload: z.strictObject({ orgId: z.uuid(), previousLabel: z.string(), projectId: z.uuid() }),
  },
  'sandbox.op.requested': {
    aggregate: 'sandbox',
    payload: z.strictObject({
      leaseEpoch: z.number().int().optional(),
      op: z.enum(['create', 'resume', 'hibernate', 'release', 'label']),
      operationId: z.string().optional(),
      orgId: z.uuid().optional(), // present for a project row, absent for a pool row
      poolId: z.uuid().optional(),
      sandboxId: z.uuid().optional(), // exactly one of poolId / sandboxId
      /** The row's `transition_since` the request was made for: one job per transition cycle (043). */
      since: z.iso.datetime().optional(),
    }),
  },
  'site.offline': {
    aggregate: 'project',
    payload: z.strictObject({ orgId: z.uuid(), projectId: z.uuid() }),
  },
  'site.released': { aggregate: 'project', payload: z.strictObject(deploymentIds) },
  'sync.requested': {
    aggregate: 'sync-operation',
    payload: z.strictObject({ orgId: z.uuid(), projectId: z.uuid(), syncOperationId: z.uuid() }),
  },
  /**
   * One attempt of one outbound send (spec 029 R6). `manual` marks a replay (R11): one attempt
   * outside the schedule, not counted in `attempts`, and never retried.
   */
  'webhook.attempt-due': {
    aggregate: 'webhook-send',
    payload: z.strictObject({
      manual: z.literal(true).optional(),
      orgId: z.uuid(),
      sendId: z.uuid(),
    }),
  },
  'webhook.endpoint-paused': {
    aggregate: 'webhook-endpoint',
    payload: z.strictObject({ endpointId: z.uuid(), orgId: z.uuid() }),
  },
  /**
   * A verified inbound delivery is durable (spec 026 R11). Appended on the same handle as the
   * `webhook_deliveries` insert, so "written down" and "enqueued" are one fact and the provider's
   * retry is safe by construction. The id only — the payload is the row's `body`, which the
   * consumer reads under its own transaction and the retention sweep nulls at seven days. No
   * `orgId`: the delivery arrives before any organisation is known.
   */
  'webhook.received': {
    aggregate: 'webhook-delivery',
    payload: z.strictObject({ deliveryId: z.uuid() }),
  },
} as const;

export type EventType = keyof typeof EVENTS;

export type EventPayload<T extends EventType> = z.infer<(typeof EVENTS)[T]['payload']>;

/**
 * The most a serialised payload may be (FR-007). Large enough for a handful of ids and a reason
 * string; small enough that a payload carrying a document body fails loudly at the writer instead
 * of being discovered as queue-store growth.
 */
export const MAX_PAYLOAD_BYTES = 4_096;
