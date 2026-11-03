import { Inject, Injectable } from '@nestjs/common';
import type { CloudflareOffer, DnsRecord, Operation } from '@repo/contracts';

import { isOpen, retryAfterSeconds } from '../../common/circuit/circuit';
import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import type { Plaintext } from '../../common/crypto/branded';
import { ConflictError, NotFoundError } from '../../common/errors/domain-error';
import type { TenantTransaction } from '../../database/database.types';
import { type DomainRecords, DomainRecordsReader } from '../deploy/domains/domain-records';
import { ConnectionRepository } from './connection.repository';
import { ConnectionService } from './connection.service';
import { connectorRefusal, providerUnavailable } from './connectors.errors';
import { OperationService } from './operation.service';
import {
  CLOUDFLARE_DNS_CLIENT,
  type CloudflareDnsClient,
  type CloudflareRecord,
  type CloudflareZone,
} from './providers/cloudflare/cloudflare-dns.client';
import { ProviderFailure } from './providers/provider';
import { ResourceRepository } from './resource.repository';

/** R13: the mark on every record the connector writes; delete only while it still carries it. */
export function recordMarker(domainId: string): string {
  return `forge:domain:${domainId}`;
}

/** The two records 028 asks a member to publish: ownership TXT, then routing CNAME. */
export function wantedRecords(domain: DomainRecords): DnsRecord[] {
  return [
    { content: domain.ownership.content, name: domain.ownership.name, type: 'TXT' },
    { content: domain.cname.content, name: domain.cname.name, type: 'CNAME' },
  ];
}

/** Cloudflare answers TXT content quoted; the comparison is on the value. */
function sameContent(a: string, b: string): boolean {
  const bare = (value: string) => value.replace(/^"(.*)"$/, '$1').toLowerCase();

  return bare(a) === bare(b);
}

export interface RecordPlan {
  /** Already in the zone exactly as wanted: recorded, not written (R13). */
  readonly adopt: { readonly wanted: DnsRecord; readonly existing: CloudflareRecord }[];
  readonly create: DnsRecord[];
  /** A different record at a wanted name and type: nothing may be written (FR-011). */
  readonly conflict?: CloudflareRecord;
}

/** Lists what is at each wanted name and type; decides adopt, create or conflict. Reads only. */
export async function planRecords(
  client: CloudflareDnsClient,
  credential: Plaintext,
  zoneId: string,
  wanted: readonly DnsRecord[],
): Promise<RecordPlan> {
  const adopt: RecordPlan['adopt'][number][] = [];
  const create: DnsRecord[] = [];

  for (const record of wanted) {
    const existing = await client.records(credential, zoneId, {
      name: record.name,
      type: record.type,
    });
    const identical = existing.find((row) => sameContent(row.content, record.content));

    if (identical !== undefined) {
      adopt.push({ existing: identical, wanted: record });
    } else if (existing.length > 0) {
      return { adopt, conflict: existing[0]!, create };
    } else {
      create.push(record);
    }
  }

  return { adopt, create };
}

/**
 * Spec 030 US2, research R13, contracts/bindings.md § 3: the Cloudflare offer on a custom domain
 * and the request to write its records. The write itself is the `dns_write` operation
 * (`DnsWriteHandler`); here the zone and the conflict are read so a conflict is refused before
 * anything is queued.
 */
@Injectable()
export class CloudflareDnsService {
  constructor(
    @Inject(DomainRecordsReader) private readonly domains: DomainRecordsReader,
    @Inject(ConnectionRepository) private readonly repository: ConnectionRepository,
    @Inject(ConnectionService) private readonly connections: ConnectionService,
    @Inject(ResourceRepository) private readonly resources: ResourceRepository,
    @Inject(OperationService) private readonly operations: OperationService,
    @Inject(CLOUDFLARE_DNS_CLIENT) private readonly client: CloudflareDnsClient,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  /** `GET …/domains/:domainId/cloudflare`. Writes nothing at Cloudflare. */
  async offer(tx: TenantTransaction, orgId: string, domainId: string): Promise<CloudflareOffer> {
    const domain = await this.domain(tx, orgId, domainId);
    const records = wantedRecords(domain);

    if (await this.isWritten(tx, orgId, domainId)) return { records, status: 'written' };

    this.ensurePending(domain);

    const connection = await this.repository.byProvider(tx, orgId, 'cloudflare');

    if (connection?.removalRequestedAt !== null) {
      return { records, status: 'not-connected' };
    }

    if (connection.health === 'needs_reauth') return { records, status: 'needs-reauth' };

    const now = this.clock.now();

    if (isOpen(connection, now)) {
      throw providerUnavailable(retryAfterSeconds(connection, now), 'cloudflare');
    }

    const credential = await this.connections.openCredential(tx, connection);
    let zone: CloudflareZone | undefined;
    let plan: RecordPlan | undefined;

    try {
      zone = await this.client.zoneFor(credential, domain.hostname);
      if (zone !== undefined) plan = await planRecords(this.client, credential, zone.id, records);
    } catch (error) {
      if (!(error instanceof ProviderFailure)) throw error;

      if (error.category === 'unauthorized' || error.category === 'forbidden-scope') {
        await this.connections.recordUse(tx, connection, 'needs-reauth');

        return { records, status: 'needs-reauth' };
      }

      await this.connections.recordUse(tx, connection, 'failure');
      throw providerUnavailable(error.retryAfterSeconds ?? 60, 'cloudflare');
    }

    await this.connections.recordUse(tx, connection, 'success');

    if (zone === undefined) return { records, status: 'zone-not-found' };

    return {
      ...(plan?.conflict === undefined
        ? {}
        : {
            conflict: {
              content: plan.conflict.content,
              name: plan.conflict.name,
              type: plan.conflict.type,
            },
          }),
      records,
      status: 'writable',
      zone,
    };
  }

  /**
   * `POST …/write` (step-up, `org:domains.manage`): the zone and a conflict are checked now, and
   * one `dns_write` operation is queued. Only a `pending` domain is writable.
   */
  async requestWrite(
    tx: TenantTransaction,
    orgId: string,
    userId: string,
    domainId: string,
  ): Promise<Operation> {
    const domain = await this.domain(tx, orgId, domainId);

    this.ensurePending(domain);

    if (await this.isWritten(tx, orgId, domainId)) {
      throw new ConflictError("This domain's records were already written with Cloudflare.");
    }

    const connection = await this.connections.ensureUsable(tx, orgId, 'cloudflare');
    const credential = await this.connections.openCredential(tx, connection);
    const records = wantedRecords(domain);
    let zone: CloudflareZone | undefined;
    let plan: RecordPlan | undefined;

    try {
      zone = await this.client.zoneFor(credential, domain.hostname);
      if (zone !== undefined) plan = await planRecords(this.client, credential, zone.id, records);
    } catch (error) {
      if (!(error instanceof ProviderFailure)) throw error;
      if (error.category === 'unauthorized') throw connectorRefusal('needs-reauth');
      if (error.category === 'forbidden-scope') throw connectorRefusal('missing-scope');
      throw providerUnavailable(error.retryAfterSeconds ?? 60, 'cloudflare');
    }

    if (zone === undefined) throw connectorRefusal('zone-not-found');

    if (plan?.conflict !== undefined) {
      throw connectorRefusal('record-conflict', {
        record: {
          content: plan.conflict.content,
          name: plan.conflict.name,
          type: plan.conflict.type,
        },
      });
    }

    const operation = await this.operations.request(tx, orgId, {
      domainId,
      externalRef: zone.id,
      kind: 'dns_write',
      projectId: domain.projectId,
      requestedBy: userId,
    });

    return this.operations.toContract(operation);
  }

  private async domain(
    tx: TenantTransaction,
    orgId: string,
    domainId: string,
  ): Promise<DomainRecords> {
    const domain = await this.domains.records(tx, orgId, domainId);

    if (domain === undefined) throw new NotFoundError('No such domain.');

    return domain;
  }

  private ensurePending(domain: DomainRecords): void {
    if (domain.state !== 'pending') {
      throw new ConflictError("Only a pending domain's records can be written with Cloudflare.");
    }
  }

  private async isWritten(
    tx: TenantTransaction,
    orgId: string,
    domainId: string,
  ): Promise<boolean> {
    const live = await this.resources.listForDomain(tx, orgId, domainId, { liveOnly: true });

    return live.some((row) => row.kind === 'cloudflare_dns_record');
  }
}
