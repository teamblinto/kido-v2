import { Inject, Injectable } from '@nestjs/common';
import type { ConnectorResource } from '@repo/db';

import type { Plaintext } from '../../common/crypto/branded';
import { recordMarker } from './cloudflare-dns.service';
import type { ResourceReleaser } from './connection-remove.handler';
import {
  CLOUDFLARE_DNS_CLIENT,
  type CloudflareDnsClient,
} from './providers/cloudflare/cloudflare-dns.client';

/**
 * A `cloudflare_dns_record`'s release (spec 030 FR-011, FR-012, R13): deleted by its stored id only
 * while the live record still carries this domain's mark. A record gone already, or one a person
 * has since re-marked, is released without touching the zone.
 */
@Injectable()
export class CloudflareRecordReleaser implements ResourceReleaser {
  constructor(@Inject(CLOUDFLARE_DNS_CLIENT) private readonly client: CloudflareDnsClient) {}

  async release(credential: Plaintext, resource: ConnectorResource): Promise<void> {
    const { domainId, externalId, scopeRef } = resource;

    if (externalId === null || scopeRef === null || domainId === null) return;

    const live = await this.client.record(credential, scopeRef, externalId);

    if (live?.comment !== recordMarker(domainId)) return;

    await this.client.deleteRecord(credential, scopeRef, externalId);
  }
}
