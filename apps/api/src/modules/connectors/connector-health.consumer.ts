import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConnectorOpKind, SyncFailureReason } from '@repo/contracts';
import { orgs, schema } from '@repo/db';
import { and, eq, inArray, isNotNull, isNull, lt } from 'drizzle-orm';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import type { Plaintext } from '../../common/crypto/branded';
import { APP_DATABASE, BYPASS_DATABASE } from '../../database/database.constants';
import type { ForgeDatabase, TenantTransaction } from '../../database/database.types';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import { EventConsumer } from '../outbox/consumer';
import type { Envelope } from '../outbox/envelope';
import { ConnectionRepository } from './connection.repository';
import { ConnectionService } from './connection.service';
import { OperationRepository, STALE_PUBLISH_MS } from './operation.repository';
import { OperationService } from './operation.service';
import { RepoLinkRepository } from './repo-link.repository';
import { ResourceRepository } from './resource.repository';
import { SyncRepository } from './sync.repository';
import { SyncService } from './sync.service';

export const CONNECTOR_HEALTH_QUEUE = 'connector.health';
/** R7: a `running` operation this old has lost its worker. */
export const STALE_RUNNING_MS = 15 * 60_000;
/** A row a use (or a check) verified this recently is not probed again by the sweep. */
export const VERIFIED_WITHIN_MS = 60 * 60_000;

/** Spec 044: a `running` sync row this old has lost its worker; three git attempts fit well inside. */
export const STALE_SYNC_MS = 30 * 60_000;
/** Spec 044: a failed auto-sync is retried at this pace, so a stuck link adds ~48 rows a day, not 288. */
export const SYNC_RETRY_SPACING_MS = 30 * 60_000;
/** Spec 044: the failures a later try can fix. Any other reason waits for a new head. */
const TRANSIENT_SYNC_FAILURES: readonly (SyncFailureReason | null)[] = [
  'git-failed',
  'provider-unavailable',
  'timed-out',
];

/**
 * Spec 030 data-model § 5: how long a `connector_operations` row may stay `running` before the
 * `connector.ops-timeout` job closes it `failed` / `timed-out`. {@link STALE_RUNNING_MS} unless its
 * kind names its own — the per-kind hook: a Netlify publish's upload time scales with the site
 * (US4's `STALE_PUBLISH_MS`, 30 min). A kind that needs longer adds one entry here.
 */
export const STALE_OPERATION_MS: Readonly<Partial<Record<ConnectorOpKind, number>>> = {
  netlify_publish: STALE_PUBLISH_MS,
};

export function staleAfter(kind: ConnectorOpKind): number {
  return STALE_OPERATION_MS[kind] ?? STALE_RUNNING_MS;
}

/**
 * Spec 030 US5/US6: what the sweep asks Resend about a bound domain that was `pending` — its status
 * (`verified` lets the sending key be minted). `ConnectorsModule` binds it to the Resend client
 * (T095); `null` — a test's choice — makes the re-check arm a no-op.
 */
export interface ResendDomainReader {
  domainStatus(credential: Plaintext, domainId: string): Promise<string>;
}

export const RESEND_DOMAIN_READER = Symbol('forge.connectors.resendDomainReader');

const OPEN_STATES = ['queued', 'running'] as const;
const LIVE_STATES = ['provisioning', 'live', 'releasing'] as const;

type DueEvent = Envelope<'maintenance.due'>;

/**
 * The arm of `maintenance.due` this module owns. Anything else is another module's tick;
 * `webhook.retention` is `WebhooksMaintenanceConsumer`'s (spec 029 T089).
 */
type OwnedJob = 'connector.ops-timeout' | 'connector.sync-reconcile' | 'connector.verify';

export interface HealthSweepReport {
  /** `running` operations closed as `failed` / `timed-out`. */
  readonly timedOut: number;
  /** Connections checked against their provider. */
  readonly verified: number;
  /** `resend_key_mint` operations requested for a domain that turned `verified`. */
  readonly minted: number;
  /** Deleted organisations whose resources were queued for release or whose connections went. */
  readonly deletedOrgs: number;
}

/**
 * The `connector.verify` arm of `maintenance.due` (spec 018 R9, SC-009) on its own queue, on the
 * `events` lane: every organisation's connections put through `ConnectionService.verify` — a
 * revoked installation reads `needs_reauth` after one tick, the transition audited once — and,
 * while it is there, the stuck `running` operations closed as `timed-out` (R7). The period is
 * `MAINTENANCE_JOBS['connector.verify']`'s day.
 *
 * `connections` is under forced RLS and this process holds no bypass role, so the sweep is one
 * tenant transaction per organisation, as the sandbox sweep and the run reaper do.
 */
// ponytail: one sweep a day; per-connection schedule when a tenant asks
@Injectable()
export class ConnectorHealthConsumer extends EventConsumer<
  'maintenance.due',
  OwnedJob | undefined
> {
  readonly attempts = 3;
  readonly name = 'connector-health';
  override readonly profile = 'events' as const;
  readonly queue = CONNECTOR_HEALTH_QUEUE;
  readonly types = ['maintenance.due'] as const;

  private readonly logger = new Logger(ConnectorHealthConsumer.name);

  constructor(
    @Inject(APP_DATABASE) private readonly db: ForgeDatabase,
    @Inject(TenantTransactionRunner) private readonly transactions: TenantTransactionRunner,
    @Inject(ConnectionService) private readonly connections: ConnectionService,
    @Inject(SyncRepository) private readonly operations: SyncRepository,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(BYPASS_DATABASE) private readonly bypass: ForgeDatabase,
    @Inject(OperationRepository) private readonly operationRows: OperationRepository,
    @Inject(OperationService) private readonly connectorOps: OperationService,
    @Inject(ResourceRepository) private readonly resources: ResourceRepository,
    @Inject(ConnectionRepository) private readonly connectionRows: ConnectionRepository,
    @Inject(RESEND_DOMAIN_READER) private readonly resendDomains: ResendDomainReader | null,
    @Inject(RepoLinkRepository) private readonly links: RepoLinkRepository,
    @Inject(SyncService) private readonly syncs: SyncService,
  ) {
    super();
  }

  /** As `MaintenanceConsumer.jobId`: BullMQ refuses `:` in a custom id, so the period is epoch ms. */
  override jobId(event: DueEvent): string {
    return `${event.payload.job}.${Date.parse(event.payload.periodStart)}.health`;
  }

  handle(event: DueEvent): Promise<OwnedJob | undefined> {
    const { job } = event.payload;

    return Promise.resolve(
      job === 'connector.verify' ||
        job === 'connector.ops-timeout' ||
        job === 'connector.sync-reconcile'
        ? job
        : undefined,
    );
  }

  override async effect(_event: DueEvent, job: OwnedJob | undefined): Promise<void> {
    if (job === undefined) return;

    if (job === 'connector.ops-timeout') {
      const timedOut = await this.timeoutOperations();
      this.logger.log(`timed out ${String(timedOut)} connector operation(s)`);

      return;
    }

    if (job === 'connector.sync-reconcile') {
      const { requested, timedOut } = await this.reconcileSync();
      this.logger.log(
        `sync reconcile: requested ${String(requested)}, timed out ${String(timedOut)}`,
      );

      return;
    }

    const report = await this.sweep();
    this.logger.log(
      `verified ${String(report.verified)} connection(s), timed out ${String(report.timedOut)} operation(s)`,
    );
  }

  /** One pass over every live organisation. Public so a suite can drive it without the queue. */
  async sweep(): Promise<HealthSweepReport> {
    const now = this.clock.now();
    const stale = new Date(now.getTime() - STALE_RUNNING_MS);
    const report = { deletedOrgs: 0, minted: 0, timedOut: 0, verified: 0 };
    const tenants = await this.db.select({ id: orgs.id }).from(orgs).where(isNull(orgs.deletedAt));

    for (const { id: orgId } of tenants) {
      // One organisation's failure rolls its own transaction back and the sweep carries on.
      try {
        await this.transactions.runInTenantTransaction(orgId, async (tx) => {
          for (const operation of await this.operations.staleRunning(tx, orgId, stale)) {
            await this.operations.markDone(tx, orgId, operation.id, {
              finishedAt: now,
              reason: 'timed-out',
              state: 'failed',
            });
            report.timedOut += 1;
          }

          for (const row of await this.connections.list(tx, orgId)) {
            const verifiedAt = row.lastVerifiedAt?.getTime() ?? 0;

            if (now.getTime() - verifiedAt < VERIFIED_WITHIN_MS) continue;

            await this.connections.verify(tx, orgId, row.id);
            report.verified += 1;
          }

          report.minted += await this.recheckResendDomains(tx, orgId);
        });
      } catch (error) {
        this.logger.warn(`sweep skipped org ${orgId}: ${(error as Error).message}`);
      }
    }

    report.deletedOrgs = await this.sweepDeletedOrgs();

    return report;
  }

  /**
   * `connector.ops-timeout` (every 5 min): `running` connector operations past their kind's limit
   * closed `failed` / `timed-out`. forge_bypass finds the organisations holding any (the columns
   * 0042 grants it); each is closed in its own tenant transaction.
   */
  async timeoutOperations(): Promise<number> {
    const now = this.clock.now();
    const earliest = new Date(
      now.getTime() - Math.min(STALE_RUNNING_MS, ...Object.values(STALE_OPERATION_MS)),
    );
    const candidates = await this.bypass
      .select({
        id: schema.connectorOperations.id,
        kind: schema.connectorOperations.kind,
        orgId: schema.connectorOperations.orgId,
        startedAt: schema.connectorOperations.startedAt,
      })
      .from(schema.connectorOperations)
      .where(
        and(
          eq(schema.connectorOperations.state, 'running'),
          lt(schema.connectorOperations.startedAt, earliest),
        ),
      );
    const stale = candidates.filter(
      (row) =>
        row.startedAt !== null && now.getTime() - row.startedAt.getTime() > staleAfter(row.kind),
    );
    let closed = 0;

    for (const orgId of new Set(stale.map((row) => row.orgId))) {
      try {
        await this.transactions.runInTenantTransaction(orgId, async (tx) => {
          for (const row of stale.filter((candidate) => candidate.orgId === orgId)) {
            const done = await this.operationRows.markDone(tx, orgId, row.id, {
              finishedAt: now,
              reason: 'timed-out',
              state: 'failed',
            });
            if (done) closed += 1;
          }
        });
      } catch (error) {
        this.logger.warn(`ops-timeout skipped org ${orgId}: ${(error as Error).message}`);
      }
    }

    return closed;
  }

  /**
   * `connector.sync-reconcile` (every 5 min, spec 044 decision 11): what a lost or transiently failed
   * operation left behind. Stuck `running` rows close first, so the same pass can re-request them;
   * then every auto-sync link whose latest operation is settled well, or failed in a way a later try
   * can fix. `requestAuto` holds the remaining rule: never the head that already went.
   */
  async reconcileSync(): Promise<{ requested: number; timedOut: number }> {
    const now = this.clock.now();
    const stale = new Date(now.getTime() - STALE_SYNC_MS);
    const report = { requested: 0, timedOut: 0 };
    const tenants = await this.db.select({ id: orgs.id }).from(orgs).where(isNull(orgs.deletedAt));

    for (const { id: orgId } of tenants) {
      try {
        await this.transactions.runInTenantTransaction(orgId, async (tx) => {
          for (const operation of [
            ...(await this.operations.staleRunning(tx, orgId, stale)),
            ...(await this.operations.staleQueued(tx, orgId, stale)),
          ]) {
            report.timedOut += await this.operations.markDone(tx, orgId, operation.id, {
              finishedAt: now,
              reason: 'timed-out',
              state: 'failed',
            });
          }

          for (const { id, projectId } of await this.links.autoSyncLinks(tx, orgId)) {
            const ref = { orgId, projectId };
            const latest = await this.operations.latest(tx, ref, id);

            if (
              latest === undefined ||
              latest.state === 'succeeded' ||
              latest.kind === 'pull' ||
              (latest.state === 'failed' &&
                TRANSIENT_SYNC_FAILURES.includes(latest.reason) &&
                (latest.finishedAt?.getTime() ?? 0) <= now.getTime() - SYNC_RETRY_SPACING_MS)
            ) {
              if ((await this.syncs.requestAuto(tx, ref)) !== null) report.requested += 1;
            }
          }
        });
      } catch (error) {
        this.logger.warn(`sync reconcile skipped org ${orgId}: ${(error as Error).message}`);
      }
    }

    return report;
  }

  /**
   * Spec 030 US5: a Resend binding whose domain was `pending` at bind time has no sending key; once
   * Resend reports the domain `verified`, one `resend_key_mint` is requested — never a second while
   * one is open, a key is live, or a mint has already succeeded.
   */
  private async recheckResendDomains(tx: TenantTransaction, orgId: string): Promise<number> {
    if (this.resendDomains === null) return 0;

    const bindings = await tx
      .select()
      .from(schema.connectorBindings)
      .where(
        and(
          eq(schema.connectorBindings.orgId, orgId),
          eq(schema.connectorBindings.provider, 'resend'),
          eq(schema.connectorBindings.state, 'bound'),
          isNotNull(schema.connectorBindings.connectionId),
        ),
      );

    if (bindings.length === 0) return 0;

    const latest = await this.operationRows.latestForBindings(
      tx,
      orgId,
      bindings.map((row) => row.id),
    );
    let minted = 0;

    for (const binding of bindings) {
      const last = latest.get(binding.id);

      if (last !== undefined && (last.state !== 'failed' || last.kind !== 'resend_key_mint')) {
        continue;
      }

      const keys = await this.resources.listForBinding(tx, orgId, binding.id, { liveOnly: true });
      if (keys.length > 0) continue;

      const domainId = binding.config.domainId;
      if (typeof domainId !== 'string') continue;

      try {
        const connection = await this.connections.byId(tx, orgId, binding.connectionId!);
        if (connection.health !== 'healthy') continue;

        const credential = await this.connections.openCredential(tx, connection);
        if ((await this.resendDomains.domainStatus(credential, domainId)) !== 'verified') continue;
      } catch (error) {
        this.logger.warn(
          `resend binding ${binding.id} not re-checked: ${(error as Error).message}`,
        );
        continue;
      }

      await this.connectorOps.request(tx, orgId, {
        bindingId: binding.id,
        kind: 'resend_key_mint',
        projectId: binding.projectId,
        requestedBy: null,
      });
      minted += 1;
    }

    return minted;
  }

  /**
   * Spec 030 R15, SC-005: an organisation soft-deleted with connections (it emits no event). Each
   * `live` resource gets one `resource_release`, run with the credential still sealed; once
   * nothing is live or releasing and no operation is open, the connections go with their secrets
   * and those of released resources. forge_bypass only finds the organisations; every step after
   * runs in the tenant transaction.
   */
  private async sweepDeletedOrgs(): Promise<number> {
    const deleted = await this.bypass
      .selectDistinct({ orgId: schema.connections.orgId })
      .from(schema.connections)
      .innerJoin(orgs, eq(orgs.id, schema.connections.orgId))
      .where(isNotNull(orgs.deletedAt));
    let swept = 0;

    for (const { orgId } of deleted) {
      try {
        await this.transactions.runInTenantTransaction(orgId, (tx) =>
          this.releaseDeletedOrg(tx, orgId),
        );
        swept += 1;
      } catch (error) {
        this.logger.warn(`deleted org ${orgId} not swept: ${(error as Error).message}`);
      }
    }

    return swept;
  }

  private async releaseDeletedOrg(tx: TenantTransaction, orgId: string): Promise<void> {
    const live = await this.resources.listLive(tx, orgId);
    const open = await tx
      .select({
        kind: schema.connectorOperations.kind,
        resourceId: schema.connectorOperations.resourceId,
      })
      .from(schema.connectorOperations)
      .where(
        and(
          eq(schema.connectorOperations.orgId, orgId),
          inArray(schema.connectorOperations.state, [...OPEN_STATES]),
        ),
      );
    const releasing = new Set(
      open.filter((row) => row.kind === 'resource_release').map((row) => row.resourceId),
    );

    for (const resource of live) {
      if (resource.state !== 'live' || releasing.has(resource.id)) continue;

      await this.connectorOps.request(tx, orgId, {
        kind: 'resource_release',
        projectId: null,
        requestedBy: null,
        resourceId: resource.id,
      });
    }

    const settled =
      live.every((row) => !(LIVE_STATES as readonly string[]).includes(row.state)) &&
      open.length === 0;

    if (!settled) return;

    for (const row of await this.connectionRows.forOrg(tx, orgId)) {
      // As a removal does: the grant (Supabase) or installation (GitHub) is revoked at the
      // provider, best effort — a credential that will not open is one nothing can use anyway.
      try {
        // A savepoint: a failed read must not abort the sweep's transaction.
        const credential = await tx.transaction((savepoint) =>
          this.connections.openCredential(savepoint, row),
        );
        await this.connections.revokeAtProvider(row, credential);
      } catch (error) {
        this.logger.warn(
          `deleted org ${orgId}: ${row.provider} not revoked: ${(error as Error).name}`,
        );
      }
      await this.connectionRows.disconnectBindings(tx, orgId, row.id);
      await this.connectionRows.dropResourceValues(tx, orgId, row.id);
      await this.connectionRows.delete(tx, orgId, row.id);
      await this.connectionRows.deleteSecret(tx, orgId, row.secretId);
    }
  }
}
