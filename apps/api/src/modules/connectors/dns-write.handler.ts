import { Inject, Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { DomainRecordsReader } from '../deploy/domains/domain-records';
import { planRecords, recordMarker, wantedRecords } from './cloudflare-dns.service';
import {
  type OperationContext,
  OperationFailure,
  type OperationHandler,
} from './connector-ops.consumer';
import {
  CLOUDFLARE_DNS_CLIENT,
  type CloudflareDnsClient,
} from './providers/cloudflare/cloudflare-dns.client';
import { ResourceRepository } from './resource.repository';

/**
 * `dns_write` (spec 030 US2, research R13): the zone is found again and what is at each name read
 * again — an identical record is adopted, a different one fails the operation `record-conflict`
 * with nothing written — then the missing records are created, marked `forge:domain:<id>`, and
 * each is recorded as a live `cloudflare_dns_record` resource with its record and zone ids.
 *
 * A retry after a crash between the create and the insert finds its own records identical and
 * adopts them, so nothing is written twice. A `403` at create is `forbidden-scope`: the consumer
 * fails the operation `missing-scope` and moves the connection to `needs_reauth`.
 */
@Injectable()
export class DnsWriteHandler implements OperationHandler {
  constructor(
    @Inject(DomainRecordsReader) private readonly domains: DomainRecordsReader,
    @Inject(ResourceRepository) private readonly resources: ResourceRepository,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CLOUDFLARE_DNS_CLIENT) private readonly client: CloudflareDnsClient,
  ) {}

  async run({ connection, credential, inTenant, operation }: OperationContext): Promise<void> {
    const { orgId } = operation;
    const domainId = operation.domainId;

    if (domainId === null) throw new OperationFailure('not-found');

    const found = await inTenant(async (tx) => ({
      domain: await this.domains.records(tx, orgId, domainId),
      live: await this.resources.listForDomain(tx, orgId, domainId, { liveOnly: true }),
    }));

    if (found.live.some((row) => row.kind === 'cloudflare_dns_record')) return;
    if (found.domain?.state !== 'pending') throw new OperationFailure('not-found');

    const domain = found.domain;
    const zone = await this.client.zoneFor(credential, domain.hostname);

    if (zone === undefined) throw new OperationFailure('zone-not-found');

    const plan = await planRecords(this.client, credential, zone.id, wantedRecords(domain));

    if (plan.conflict !== undefined) throw new OperationFailure('record-conflict');

    const written = [...plan.adopt.map(({ existing }) => existing)];

    for (const record of plan.create) {
      written.push(
        await this.client.createRecord(credential, zone.id, {
          ...record,
          comment: recordMarker(domainId),
        }),
      );
    }

    await inTenant(async (tx) => {
      for (const record of written) {
        await this.resources.insert(tx, {
          connectionId: connection.id,
          domainId,
          externalId: record.id,
          kind: 'cloudflare_dns_record',
          name: record.name,
          orgId,
          scopeRef: zone.id,
          state: 'live',
        });
      }

      await this.audit.record(tx, {
        action: 'connector.dns-written',
        actorId: operation.requestedBy,
        metadata: {
          adopted: plan.adopt.length,
          created: plan.create.length,
          domainId,
          provider: 'cloudflare',
          zoneId: zone.id,
        },
        orgId,
        target: domainId,
      });
    });
  }
}
