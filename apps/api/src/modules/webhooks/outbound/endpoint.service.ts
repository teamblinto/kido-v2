import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type CreateWebhookEndpointRequest,
  type RotateWebhookSecretRequest,
  type UpdateWebhookEndpointRequest,
  WEBHOOK_CATALOGUE_VERSION,
  type WebhookAttemptFailure,
  type WebhookDeliverySummary,
  type WebhookEndpoint,
  type WebhookEndpointList,
  type WebhookEventType,
  type WebhookSecretResponse,
} from '@repo/contracts';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { CLOCK, type ClockPort } from '../../../common/clock/clock.port';
import { revealPlaintext } from '../../../common/crypto/branded';
import { NotFoundError } from '../../../common/errors/domain-error';
import type { Environment } from '../../../config/environment';
import type { TenantTransaction } from '../../../database/database.types';
import { AuditService } from '../../audit/audit.service';
import { OutboxWriter } from '../../outbox/outbox-writer';
import { webhookConflict } from '../webhook.errors';
import { ROTATION_OVERLAP_MS, WEBHOOK_ENDPOINTS_PER_ORG } from '../webhooks.constants';
import { parseEndpointUrl } from './destination';
import { type EndpointPatch, type EndpointRow, EndpointRepository } from './endpoint.repository';
import { serialiseEnvelope } from './public-event';
import { type SendRow, SendRepository } from './send.repository';
import { SigningSecrets } from './signing-secret';

/** The create body after the contract's defaults. */
type CreateBody = Required<CreateWebhookEndpointRequest>;

/**
 * An organisation's webhook endpoints (spec 029 US1, contracts/webhook-endpoints.md): create,
 * list, get, update (including enable and disable), delete and send test; and US5's secret
 * rotation. Every refusal is decided
 * before anything is written; every mutation writes its audit row on the caller's transaction,
 * with metadata that never carries the secret (FR-033). `ClockPort` supplies every timestamp.
 */
@Injectable()
export class EndpointService {
  private readonly allowHttp: boolean;

  constructor(
    @Inject(EndpointRepository) private readonly endpoints: EndpointRepository,
    @Inject(SendRepository) private readonly sends: SendRepository,
    @Inject(SigningSecrets) private readonly secrets: SigningSecrets,
    @Inject(OutboxWriter) private readonly outbox: OutboxWriter,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(ConfigService) config: ConfigService<Environment, true>,
  ) {
    // `http:` only where a receiver on the developer's machine is the point (research R8).
    this.allowHttp = config.get('DEPLOY_ENV', { infer: true }) === 'local';
  }

  /**
   * `POST …/endpoints`. Order: the URL, the project scope, then the limit under the org's lock
   * (held from the count to the end of the caller's transaction), then the secret and the row.
   * The secret is in this response and nowhere else, ever.
   */
  async create(
    tx: TenantTransaction,
    orgId: string,
    actorId: string,
    body: CreateBody,
  ): Promise<WebhookSecretResponse> {
    const url = this.parseUrl(body.url);
    await this.requireProjects(tx, orgId, body.projectIds);

    if ((await this.endpoints.countForOrg(tx, orgId)) >= WEBHOOK_ENDPOINTS_PER_ORG) {
      throw webhookConflict('endpoint-limit', { limit: WEBHOOK_ENDPOINTS_PER_ORG });
    }

    const secret = this.secrets.generate();
    const secretId = await this.secrets.seal(tx, orgId, secret);
    const row = await this.endpoints.insert(tx, {
      createdBy: actorId,
      description: body.description,
      eventTypes: body.eventTypes,
      now: this.clock.now(),
      orgId,
      secretId,
      url,
    });
    await this.endpoints.setScope(tx, orgId, row.id, body.projectIds);

    await this.audit.record(tx, {
      action: 'webhook.endpoint-created',
      actorId,
      metadata: {
        eventTypes: row.eventTypes,
        host: new URL(row.url).host,
        projectIds: [...body.projectIds].sort(),
      },
      orgId,
      target: row.id,
    });

    return {
      endpoint: toContract(row, [...new Set(body.projectIds)].sort()),
      secret: revealPlaintext(secret).toString('utf8'),
    };
  }

  /** `GET …/endpoints`: newest first. */
  async list(tx: TenantTransaction, orgId: string): Promise<WebhookEndpointList> {
    const rows = await this.endpoints.list(tx, orgId);
    const scopes = await this.endpoints.scopes(
      tx,
      orgId,
      rows.map((row) => row.id),
    );
    const failures = await this.lastFailures(tx, rows);
    return {
      items: rows.map((row) =>
        toContract(row, scopes.get(row.id) ?? [], failures.get(row.id) ?? null),
      ),
    };
  }

  /** `GET …/endpoints/:endpointId`. Unknown and another org's are the same `404`. */
  async get(tx: TenantTransaction, orgId: string, id: string): Promise<WebhookEndpoint> {
    const row = await this.require(tx, orgId, id);
    return this.withScope(tx, row);
  }

  /**
   * `PATCH …/endpoints/:endpointId`. `enabled: true` moves `disabled` or `paused` to `enabled` and
   * clears the circuit and the pause (data-model.md § 1); `enabled: false` moves to `disabled`.
   */
  async update(
    tx: TenantTransaction,
    orgId: string,
    actorId: string,
    id: string,
    body: UpdateWebhookEndpointRequest,
  ): Promise<WebhookEndpoint> {
    const current = await this.require(tx, orgId, id);
    const patch: EndpointPatch = {};

    if (body.url !== undefined) patch.url = this.parseUrl(body.url);
    if (body.projectIds !== undefined) await this.requireProjects(tx, orgId, body.projectIds);
    if (body.description !== undefined) patch.description = body.description;
    if (body.eventTypes !== undefined) patch.eventTypes = [...body.eventTypes];
    if (body.enabled === true && current.state !== 'enabled') {
      Object.assign(patch, {
        circuitOpenUntil: null,
        failingSince: null,
        failureCount: 0,
        pausedAt: null,
        state: 'enabled',
      } satisfies EndpointPatch);
    }
    if (body.enabled === false && current.state !== 'disabled') {
      Object.assign(patch, { pausedAt: null, state: 'disabled' } satisfies EndpointPatch);
    }

    const row =
      (await this.endpoints.update(tx, orgId, id, { ...patch, now: this.clock.now() })) ?? current;
    if (body.projectIds !== undefined) {
      await this.endpoints.setScope(tx, orgId, id, body.projectIds);
    }

    await this.audit.record(tx, {
      action: 'webhook.endpoint-updated',
      actorId,
      metadata: {
        changed: Object.keys(body)
          .filter((key) => body[key as keyof UpdateWebhookEndpointRequest] !== undefined)
          .sort(),
        state: row.state,
      },
      orgId,
      target: id,
    });

    return this.withScope(tx, row);
  }

  /** `DELETE …/endpoints/:endpointId`: the row, its scope, sends, attempts and secrets rows. */
  async delete(tx: TenantTransaction, orgId: string, actorId: string, id: string): Promise<void> {
    const row = isUuid(id) ? await this.endpoints.delete(tx, orgId, id) : undefined;
    if (row === undefined) throw new NotFoundError('No such webhook endpoint.');

    await this.audit.record(tx, {
      action: 'webhook.endpoint-deleted',
      actorId,
      metadata: { host: new URL(row.url).host },
      orgId,
      target: id,
    });
  }

  /**
   * `POST …/endpoints/:endpointId/rotate-secret` (research R10): a new secret is sealed and becomes
   * current; the old one signs beside it for `ROTATION_OVERLAP_MS`, or is deleted at once with
   * `expireOld`. A rotation during an overlap deletes the oldest secret first, so at most two are
   * ever live. The row is locked, so two concurrent rotations run one after the other. The new
   * secret is in this response and nowhere else.
   */
  async rotateSecret(
    tx: TenantTransaction,
    orgId: string,
    actorId: string,
    id: string,
    body: RotateWebhookSecretRequest,
  ): Promise<WebhookSecretResponse> {
    const current = isUuid(id) ? await this.endpoints.lock(tx, orgId, id) : undefined;
    if (current === undefined) throw new NotFoundError('No such webhook endpoint.');

    const expireOld = body.expireOld ?? false;
    const now = this.clock.now();
    const secret = this.secrets.generate();
    const secretId = await this.secrets.seal(tx, orgId, secret);
    const row = await this.endpoints.update(tx, orgId, id, {
      now,
      previousSecretExpiresAt: expireOld ? null : new Date(now.getTime() + ROTATION_OVERLAP_MS),
      previousSecretId: expireOld ? null : current.secretId,
      secretId,
    });
    // Only after the row stops referencing them: the oldest, and with `expireOld` the old current.
    await this.endpoints.deleteSecrets(
      tx,
      orgId,
      [current.previousSecretId, expireOld ? current.secretId : null].filter(
        (secretIdToDrop): secretIdToDrop is string => secretIdToDrop !== null,
      ),
    );

    await this.audit.record(tx, {
      action: 'webhook.endpoint-secret-rotated',
      actorId,
      metadata: { expireOld },
      orgId,
      target: id,
    });

    return {
      endpoint: await this.withScope(tx, row!),
      secret: revealPlaintext(secret).toString('utf8'),
    };
  }

  /**
   * `POST …/endpoints/:endpointId/test` (research R11): a `ping` send with a fresh event id,
   * `pending` and due now, and its `webhook.attempt-due`, on the caller's transaction. It then
   * follows the normal path. Refused unless the endpoint is `enabled`.
   */
  async test(
    tx: TenantTransaction,
    orgId: string,
    _actorId: string,
    id: string,
  ): Promise<WebhookDeliverySummary> {
    const endpoint = await this.require(tx, orgId, id);
    if (endpoint.state !== 'enabled') throw webhookConflict('endpoint-not-enabled');

    const now = this.clock.now();
    const eventId = randomUUID();
    const body = serialiseEnvelope({
      catalogueVersion: WEBHOOK_CATALOGUE_VERSION,
      data: {},
      id: eventId,
      occurredAt: now.toISOString(),
      orgId,
      projectId: null,
      type: 'ping',
    });
    const [inserted] = await this.sends.insertFanout(tx, [
      {
        body,
        endpointId: id,
        eventId,
        eventType: 'ping',
        now,
        occurredAt: now,
        orgId,
        projectId: null,
        state: 'pending',
      },
    ]);
    await this.outbox.append(tx, {
      aggregateId: inserted!.id,
      orgId,
      payload: { orgId, sendId: inserted!.id },
      type: 'webhook.attempt-due',
    });

    const send = await this.sends.byId(tx, orgId, inserted!.id);
    return toSummary(send!);
  }

  private async require(tx: TenantTransaction, orgId: string, id: string): Promise<EndpointRow> {
    const row = isUuid(id) ? await this.endpoints.byId(tx, orgId, id) : undefined;
    if (row === undefined) throw new NotFoundError('No such webhook endpoint.');
    return row;
  }

  private async withScope(tx: TenantTransaction, row: EndpointRow): Promise<WebhookEndpoint> {
    const scopes = await this.endpoints.scopes(tx, row.orgId, [row.id]);
    const failures = await this.lastFailures(tx, [row]);
    return toContract(row, scopes.get(row.id) ?? [], failures.get(row.id) ?? null);
  }

  /** The latest failure of each endpoint that is failing (`failing_since` set), for the UI (US3). */
  private async lastFailures(
    tx: TenantTransaction,
    rows: readonly EndpointRow[],
  ): Promise<Map<string, WebhookAttemptFailure | null>> {
    const failures = new Map<string, WebhookAttemptFailure | null>();
    for (const row of rows) {
      if (row.failingSince !== null) {
        failures.set(row.id, await this.sends.lastFailure(tx, row.orgId, row.id));
      }
    }
    return failures;
  }

  private parseUrl(input: string): string {
    const parsed = parseEndpointUrl(input, { allowHttp: this.allowHttp });
    if (!parsed.ok) throw webhookConflict(parsed.reason);
    return parsed.url;
  }

  /** Every entry must be a live project of this org: another org's and an archived one are refused alike. */
  private async requireProjects(
    tx: TenantTransaction,
    orgId: string,
    projectIds: readonly string[],
  ): Promise<void> {
    const live = await this.endpoints.liveProjects(tx, orgId, projectIds);
    if (projectIds.some((projectId) => !live.has(projectId))) {
      throw webhookConflict('project-not-in-org');
    }
  }
}

/** A path id that is not a UUID names nothing: the same `404` as an unknown one. */
function isUuid(id: string): boolean {
  return z.uuid().safeParse(id).success;
}

export function toContract(
  row: EndpointRow,
  projectIds: readonly string[],
  lastFailure: WebhookAttemptFailure | null = null,
): WebhookEndpoint {
  return {
    createdAt: row.createdAt.toISOString(),
    description: row.description,
    eventTypes: row.eventTypes as WebhookEndpoint['eventTypes'],
    id: row.id,
    lastFailure,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    pausedAt: row.pausedAt?.toISOString() ?? null,
    projectIds: [...projectIds],
    secretRotation:
      row.previousSecretExpiresAt === null
        ? null
        : { previousExpiresAt: row.previousSecretExpiresAt.toISOString() },
    state: row.state,
    url: row.url,
  };
}

export function toSummary(send: SendRow): WebhookDeliverySummary {
  return {
    attempts: send.attempts,
    createdAt: send.createdAt.toISOString(),
    eventId: send.eventId,
    eventType: send.eventType as WebhookEventType,
    id: send.id,
    lastFailure: send.lastFailure as WebhookAttemptFailure | null,
    nextAttemptAt: send.nextAttemptAt?.toISOString() ?? null,
    projectId: send.projectId,
    state: send.state,
  };
}
