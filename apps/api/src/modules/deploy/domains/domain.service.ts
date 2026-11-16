import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  AddDomainRequest,
  Domain as DomainContract,
  DomainListResponse,
  DomainRecord,
  DomainState,
  RemoveDomainResponse,
} from '@repo/contracts';
import { domainToUnicode } from 'node:url';

import { CLOCK, type ClockPort } from '../../../common/clock/clock.port';
import { NotFoundError, RateLimitedError } from '../../../common/errors/domain-error';
import type { Environment } from '../../../config/environment';
import type { TenantTransaction } from '../../../database/database.types';
import { AuditService } from '../../audit/audit.service';
import { OutboxWriter } from '../../outbox/outbox-writer';
import { PermissionResolutionService } from '../../rbac/permission-resolution.service';
import { resolveBuild } from '../../sandbox/run-config';
import { TemplateCatalogue } from '../../sandbox/template-catalogue';
import { ProjectService } from '../../tenancy/services/project.service';
import type { ProjectRef } from '../deployment.service';
import { DNS, type DnsPort } from './dns.port';
import {
  CHECK_NOW_MIN_INTERVAL_MS,
  DOMAINS_PER_ORG,
  DOMAINS_PER_PROJECT,
  RELEASE_AFTER_MS,
  WINDOW_MS,
} from './domain.constants';
import { domainConflict, HostnameHeld } from './domain.errors';
import { type Domain, DomainRepository } from './domain.repository';
import { recordsOf } from './domain-records';
import { recordRemovalRequested } from './domain-removal';
import { normaliseHostname, reservedSuffixes } from './normalise-hostname';
import { ownershipToken } from './ownership-token';

/**
 * `remove`'s re-reads when the row moves under it. Each move is forward (a check settling it
 * `failed`, or another removal), so the second read always finds a state it can answer.
 */
const REMOVE_ATTEMPTS = 3;

/** Check now's one re-read: a request that lost the race to another answers by the winner's time. */
const CHECK_ATTEMPTS = 2;

/** R8: the add-time SOA probe's budget. Past it the add is accepted; the first check sees an apex. */
export const ADD_SOA_BUDGET_MS = 2_000;

/**
 * A member's custom domains (spec 028 US1, US2, US4, contracts/domains.md): add, list, get, check
 * now, retry and remove. Every refusal
 * of the add is decided before a row exists; what passes is one `pending` row, its `domain.added`
 * and its audit row, all on the caller's one transaction. Checking, registering at the edge and
 * every later transition belong to the checker.
 *
 * "Domains unavailable" is read from configuration, not from the edge: `CUSTOM_HOSTNAME_TARGET` is
 * a member of the all-or-none `CLOUDFLARE_*` group (the environment schema enforces it), and it is
 * also the routing record's value, so without it there is nothing to tell the member to publish.
 */
@Injectable()
export class DomainService {
  private readonly target: string | undefined;
  private readonly reserved: readonly string[];

  constructor(
    @Inject(DomainRepository) private readonly domains: DomainRepository,
    @Inject(ProjectService) private readonly projects: ProjectService,
    @Inject(TemplateCatalogue) private readonly catalogue: TemplateCatalogue,
    @Inject(PermissionResolutionService) private readonly permissions: PermissionResolutionService,
    @Inject(DNS) private readonly dns: DnsPort,
    @Inject(OutboxWriter) private readonly outbox: OutboxWriter,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(ConfigService) config: ConfigService<Environment, true>,
  ) {
    this.target = config.get('CUSTOM_HOSTNAME_TARGET', { infer: true });
    this.reserved = reservedSuffixes({
      appUrl: config.get('APP_URL', { infer: true }),
      customHostnameTarget: this.target,
      previewDomain: config.get('PREVIEW_DOMAIN', { infer: true }),
      reservedDomains: config.get('RESERVED_DOMAINS', { infer: true }),
      siteDomain: config.get('SITE_DOMAIN', { infer: true }),
    });
  }

  /**
   * `POST …/domains`. Order: the project (404, archived, deployable), the edge group, the
   * hostname (R8), the 2 s SOA probe, the limits (FR-004), then the insert — whose
   * `domains_hostname_live_key` is the one answer to "is it held", in this org or another (R9).
   *
   * The limits are counted last, so the org's domain lock `countLive` takes is held only from the
   * count to the end of the caller's transaction, never across the DNS probe; a second add in the
   * org waits on it and counts the first one's row (R9 § Limits).
   */
  async add(
    tx: TenantTransaction,
    ref: ProjectRef,
    actorId: string,
    body: AddDomainRequest,
  ): Promise<DomainContract> {
    const project = await this.projects.deployTarget(tx, ref);

    if (project.archived) throw domainConflict('project-archived');

    if (resolveBuild(this.catalogue, project.runSource) === undefined) {
      throw domainConflict('not-deployable');
    }

    if (this.target === undefined) throw domainConflict('domains-unavailable');

    const normalised = normaliseHostname(body.hostname, this.reserved);

    if (!normalised.ok) throw domainConflict(normalised.reason);

    if (await this.isZoneApex(normalised.hostname)) throw domainConflict('apex-not-supported');

    const live = await this.domains.countLive(tx, ref.orgId, ref.projectId);

    if (live.project >= DOMAINS_PER_PROJECT) {
      throw domainConflict('domain-limit', { limit: DOMAINS_PER_PROJECT });
    }

    if (live.org >= DOMAINS_PER_ORG)
      throw domainConflict('domain-limit', { limit: DOMAINS_PER_ORG });

    let row: Domain;
    try {
      row = await this.domains.insert(tx, {
        addedBy: actorId,
        hostname: normalised.hostname,
        now: this.clock.now(),
        orgId: ref.orgId,
        ownershipToken: ownershipToken(),
        projectId: ref.projectId,
      });
    } catch (error) {
      if (error instanceof HostnameHeld) throw domainConflict('hostname-unavailable');
      throw error;
    }

    await this.outbox.append(tx, {
      aggregateId: row.id,
      orgId: ref.orgId,
      payload: { domainId: row.id, orgId: ref.orgId, projectId: ref.projectId },
      type: 'domain.added',
    });

    await this.audit.record(tx, {
      action: 'domain.added',
      actorId,
      metadata: { hostname: row.hostname, projectId: ref.projectId },
      orgId: ref.orgId,
      target: row.id,
    });

    return this.toContract(row);
  }

  /**
   * `GET …/domains`, newest first. An unknown project is `404`; an archived one stays readable.
   * `canManage` is read off the same resolved set the guard reads (R12).
   */
  async list(tx: TenantTransaction, ref: ProjectRef, userId: string): Promise<DomainListResponse> {
    await this.projects.deployTarget(tx, ref);

    const rows = await this.domains.listForProject(tx, ref.orgId, ref.projectId);
    const held = await this.permissions.for(ref.orgId, userId);

    return {
      canManage: held.has('org:domains.manage'),
      items: rows.map((row) => this.toContract(row)),
    };
  }

  /** `GET …/domains/:domainId`. Another project's domain, or a removed one, is as absent as none. */
  async get(tx: TenantTransaction, ref: ProjectRef, domainId: string): Promise<DomainContract> {
    const row = await this.domains.findForProject(tx, ref.orgId, ref.projectId, domainId);

    if (row === undefined) throw new NotFoundError('No such domain.');

    return this.toContract(row);
  }

  /**
   * `DELETE …/domains/:domainId` (research R10, FR-024, FR-025), idempotent by target state:
   *
   * - `pending`, `active` or `drifted` → `removing`, stamped and due at once, with
   *   `domain.removal-requested` and `domain.removing` (reason null) on the caller's transaction.
   *   The broker stops serving it at once; the checker deregisters it and only then releases the
   *   hostname.
   * - `removing` is answered as it is, writing nothing.
   * - `failed` holds nothing at the edge and no hostname, so it goes straight to `removed`, with
   *   `domain.removed`. The answer is its last view, since `removed` is never reported (R9).
   * - Unknown, another project's, or `removed`: `404`.
   *
   * `deletableRecords` lists every record shown for it: the member published them, the member
   * deletes them.
   */
  async remove(
    tx: TenantTransaction,
    ref: ProjectRef,
    actorId: string,
    domainId: string,
  ): Promise<RemoveDomainResponse> {
    for (let attempt = 0; attempt < REMOVE_ATTEMPTS; attempt += 1) {
      const row = await this.domains.findForProject(tx, ref.orgId, ref.projectId, domainId);

      if (row === undefined) throw new NotFoundError('No such domain.');

      if (row.state === 'removing') return this.removal(row);

      if (row.state === 'failed') {
        if ((await this.domains.releaseFailed(tx, row.id)) === undefined) continue;

        const ids = { domainId: row.id, orgId: row.orgId, projectId: row.projectId };
        await this.audit.record(tx, {
          action: 'domain.removed',
          actorId,
          metadata: { hostname: row.hostname, projectId: row.projectId },
          orgId: row.orgId,
          target: row.id,
        });
        await this.outbox.append(tx, {
          aggregateId: row.id,
          orgId: row.orgId,
          payload: ids,
          type: 'domain.removed',
        });
        return this.removal(row);
      }

      const [moved] = await this.domains.markRemoving(
        tx,
        ref.orgId,
        { ids: [row.id] },
        this.clock.now(),
      );
      // A check settled it (to `failed`) between the read and the write: read it again.
      if (moved === undefined) continue;

      await recordRemovalRequested(tx, { audit: this.audit, outbox: this.outbox }, moved, actorId);
      return this.removal(moved);
    }

    throw new Error(`domain ${domainId}: kept moving during its removal`);
  }

  /**
   * `POST …/domains/:domainId/retry` (FR-013, contracts/domains.md): a `failed` domain goes back to
   * `pending` with a new ownership token and a new 72 h window, due at once, with `domain.retried`
   * and its audit row on the caller's transaction. It is held to what an add is: the project
   * (404, archived), the edge group, the limits (FR-004 — a `failed` row does not count, a
   * `pending` one does) and the hostname, which a live row anywhere may have taken since it failed
   * (`hostname-unavailable`, with the add's fixed detail). Any state but `failed` is `not-retryable`;
   * a `removed` one — including a failed domain the member already removed — is `404`. A replay is
   * answered by the optional `Idempotency-Key`, not here.
   */
  async retry(
    tx: TenantTransaction,
    ref: ProjectRef,
    actorId: string,
    domainId: string,
  ): Promise<DomainContract> {
    const project = await this.projects.deployTarget(tx, ref);
    const row = await this.domains.findForProject(tx, ref.orgId, ref.projectId, domainId);

    if (row === undefined) throw new NotFoundError('No such domain.');

    if (row.state !== 'failed') throw domainConflict('not-retryable');

    if (project.archived) throw domainConflict('project-archived');

    if (this.target === undefined) throw domainConflict('domains-unavailable');

    const live = await this.domains.countLive(tx, ref.orgId, ref.projectId);

    if (live.project >= DOMAINS_PER_PROJECT) {
      throw domainConflict('domain-limit', { limit: DOMAINS_PER_PROJECT });
    }

    if (live.org >= DOMAINS_PER_ORG)
      throw domainConflict('domain-limit', { limit: DOMAINS_PER_ORG });

    let retried: Domain | undefined;
    try {
      retried = await this.domains.retry(tx, row.id, {
        now: this.clock.now(),
        ownershipToken: ownershipToken(),
      });
    } catch (error) {
      if (error instanceof HostnameHeld) throw domainConflict('hostname-unavailable');
      throw error;
    }
    // A removal released it between the read and the write: it is no longer failed.
    if (retried === undefined) throw domainConflict('not-retryable');

    await this.outbox.append(tx, {
      aggregateId: retried.id,
      orgId: retried.orgId,
      payload: { domainId: retried.id, orgId: retried.orgId, projectId: retried.projectId },
      type: 'domain.retried',
    });

    await this.audit.record(tx, {
      action: 'domain.retried',
      actorId,
      metadata: { hostname: retried.hostname, projectId: retried.projectId },
      orgId: retried.orgId,
      target: retried.id,
    });

    return this.toContract(retried);
  }

  /**
   * `POST …/domains/:domainId/check` (FR-012, research R7): a `pending` or `drifted` domain gets
   * `check_requested_at` and `next_check_at` set to now and `domain.check-requested`, which
   * `DomainCheckConsumer` runs at once. Within `CHECK_NOW_MIN_INTERVAL_MS` of the last request it
   * is `429 rate-limited` with `retryAfter` in seconds. Any other state is answered unchanged and
   * runs nothing: `active` is covered by the schedule, and the rest have nothing to check.
   */
  async checkNow(
    tx: TenantTransaction,
    ref: ProjectRef,
    domainId: string,
  ): Promise<DomainContract> {
    for (let attempt = 0; attempt < CHECK_ATTEMPTS; attempt += 1) {
      const row = await this.domains.findForProject(tx, ref.orgId, ref.projectId, domainId);

      if (row === undefined) throw new NotFoundError('No such domain.');

      if (row.state !== 'pending' && row.state !== 'drifted') return this.toContract(row);

      const now = this.clock.now();

      if (row.checkRequestedAt !== null) {
        const waitMs = row.checkRequestedAt.getTime() + CHECK_NOW_MIN_INTERVAL_MS - now.getTime();

        if (waitMs > 0) {
          throw new RateLimitedError(
            'A check was asked for less than a minute ago.',
            waitMs / 1000,
          );
        }
      }

      const requested = await this.domains.requestCheck(tx, row.id, now);
      // Another request, or a check settling the row, moved it in between: read it again.
      if (requested === undefined) continue;

      await this.outbox.append(tx, {
        aggregateId: requested.id,
        orgId: requested.orgId,
        payload: {
          domainId: requested.id,
          orgId: requested.orgId,
          projectId: requested.projectId,
        },
        type: 'domain.check-requested',
      });

      return this.toContract(requested);
    }

    throw new Error(`domain ${domainId}: kept moving during a check-now request`);
  }

  private removal(row: Domain): RemoveDomainResponse {
    const domain = this.toContract(row);
    return {
      deletableRecords: domain.records.map(({ name, type, value }) => ({ name, type, value })),
      domain,
    };
  }

  /**
   * R8: an SOA owned by the name itself is a zone apex. Any other answer — none, a resolver down,
   * a failed lookup or no answer within the budget — lets the add through; the check's apex status is the net.
   */
  private async isZoneApex(hostname: string): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<undefined>((resolve) => {
      timer = setTimeout(resolve, ADD_SOA_BUDGET_MS, undefined);
    });

    try {
      const probe = this.dns.resolveSoaOwner(hostname).catch(() => undefined);
      const answer = await Promise.race([probe, budget]);
      return answer?.kind === 'answer' && answer.owner === hostname;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The contract view of a row (contracts/domains.md § Shapes and § Records shown). */
  private toContract(row: Domain): DomainContract {
    const check = row.lastCheck;
    const statusOf = (purpose: DomainRecord['purpose']): DomainRecord['status'] =>
      check?.records.find((record) => record.purpose === purpose)?.status ?? 'unchecked';
    const { cname, ownership } = recordsOf(row, this.target);
    const records: DomainRecord[] = [
      {
        name: ownership.name,
        purpose: 'ownership',
        status: statusOf('ownership'),
        type: 'TXT',
        value: ownership.content,
      },
      {
        name: cname.name,
        purpose: 'routing',
        status: statusOf('routing'),
        type: 'CNAME',
        value: cname.content,
      },
      ...(check?.certificateRecords ?? []).map((record): DomainRecord => ({
        name: record.name,
        purpose: 'certificate',
        status: statusOf('certificate'),
        type: 'TXT',
        value: record.value,
      })),
    ];
    const checkAvailableAt =
      row.checkRequestedAt === null
        ? null
        : new Date(row.checkRequestedAt.getTime() + CHECK_NOW_MIN_INTERVAL_MS);

    return {
      activatedAt: row.activatedAt?.toISOString() ?? null,
      addedBy: row.addedBy,
      check:
        check === null
          ? null
          : {
              at: check.at,
              caa: check.caa,
              certificateActive: check.edge === null ? null : check.edge.certificate === 'active',
              conclusive: check.conclusive,
              hostnameActive: check.edge === null ? null : check.edge.hostname === 'active',
              message: check.edgeMessage,
            },
      checkAvailableAt:
        checkAvailableAt !== null && checkAvailableAt > this.clock.now()
          ? checkAvailableAt.toISOString()
          : null,
      createdAt: row.createdAt.toISOString(),
      displayHostname: domainToUnicode(row.hostname),
      driftedAt: row.driftedAt?.toISOString() ?? null,
      failureReason: row.failureReason,
      hostname: row.hostname,
      id: row.id,
      records,
      releaseAt:
        row.state === 'drifted' && row.driftedAt !== null
          ? new Date(row.driftedAt.getTime() + RELEASE_AFTER_MS).toISOString()
          : null,
      state: reported(row.state),
      windowEndsAt:
        row.state === 'pending'
          ? new Date(row.windowStartedAt.getTime() + WINDOW_MS).toISOString()
          : null,
    };
  }
}

/** The repository never answers a `removed` row (R9); one reaching the mapper is a bug, not data. */
function reported(state: Domain['state']): DomainState {
  if (state === 'removed') throw new Error('A removed domain is never reported.');
  return state;
}
