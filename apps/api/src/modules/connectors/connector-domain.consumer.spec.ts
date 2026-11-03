import { schema } from '@repo/db';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import {
  type CloudflareDnsHarness,
  startCloudflareDnsHarness,
} from '../../../test/support/cloudflare-dns-harness';
import type { Envelope } from '../outbox/envelope';
import { CloudflareDnsService } from './cloudflare-dns.service';
import { ConnectorDomainConsumer } from './connector-domain.consumer';
import { OperationRepository } from './operation.repository';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

if (!postgres || !redis) {
  console.warn(
    'SKIPPING connector-domain.consumer.spec.ts: Postgres or the session Redis is not reachable',
  );
}

/**
 * Spec 030 US2 (T051), FR-011, FR-012, contracts/provider-adapters.md § 7: `domain.removing`
 * deletes exactly the records the connector wrote, and never one it no longer owns.
 */
describe('ConnectorDomainConsumer', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and the Cloudflare fixture', () => {
    let h: CloudflareDnsHarness;
    let consumer: ConnectorDomainConsumer;

    /** A pending domain written through the connector: its two records live in the zone. */
    async function written(hostname = host) {
      await h.connect();
      const domain = await h.addDomain(hostname);
      const operation = await h.inTenant((tx) =>
        h.moduleRef
          .get(CloudflareDnsService, { strict: false })
          .requestWrite(tx, h.orgId, h.userId, domain.id),
      );
      await h.runOperation(operation.id);
      expect(h.fixture.records).toHaveLength(2);

      return domain;
    }

    /** The domain moves to `removing` and its event reaches the consumer; the queued release runs. */
    async function remove(domainId: string) {
      await h.inTenant((tx) =>
        tx
          .update(schema.domains)
          .set({ removalRequestedAt: new Date(), state: 'removing' })
          .where(eq(schema.domains.id, domainId)),
      );
      const event: Envelope<'domain.removing'> = {
        aggregate: 'domain',
        aggregateId: domainId,
        eventId: randomUUID(),
        occurredAt: new Date().toISOString(),
        orgId: h.orgId,
        payload: { domainId, orgId: h.orgId, projectId: h.projectId, reason: null },
        traceId: null,
        type: 'domain.removing',
      };
      await h.inTenant((tx) => consumer.handle(event, tx));

      const operations = await h.inTenant((tx) =>
        new OperationRepository().listForDomain(tx, h.orgId, domainId),
      );
      const release = operations.filter((o) => o.kind === 'resource_release');
      expect(release).toHaveLength(1);
      await h.runOperation(release[0]!.id);

      return release[0]!.id;
    }

    function resourceStates(domainId: string) {
      return h
        .inTenant((tx) =>
          tx
            .select({ state: schema.connectorResources.state })
            .from(schema.connectorResources)
            .where(
              and(
                eq(schema.connectorResources.orgId, h.orgId),
                eq(schema.connectorResources.domainId, domainId),
              ),
            ),
        )
        .then((rows) => rows.map((r) => r.state));
    }

    beforeAll(async () => {
      h = await startCloudflareDnsHarness();
      consumer = h.moduleRef.get(ConnectorDomainConsumer, { strict: false });
    }, 60_000);

    afterAll(() => h?.close());

    let host: string;

    beforeEach(async () => {
      await h.reset();
      host = h.host();
    });

    it('rides connector.ops on domain.removing', () => {
      expect(consumer.queue).toBe('connector.ops');
      expect(consumer.types).toEqual(['domain.removing']);
    });

    it('deletes exactly the recorded records; a hand-made record in the zone survives', async () => {
      const domain = await written();
      h.fixture.records.push({
        comment: null,
        content: '1.2.3.4',
        id: 'hand-made',
        name: 'api.acme.test',
        proxied: true,
        ttl: 300,
        type: 'A',
        zoneId: 'zone-1',
      });

      const releaseId = await remove(domain.id);

      expect(h.fixture.records.map((r) => r.id)).toEqual(['hand-made']);
      expect(await resourceStates(domain.id)).toEqual(['released', 'released']);
      await expect(
        h.inTenant((tx) => new OperationRepository().byId(tx, h.orgId, releaseId)),
      ).resolves.toMatchObject({ state: 'succeeded' });
    });

    it('leaves alone a recorded record whose live comment no longer matches', async () => {
      const domain = await written();
      const cname = h.fixture.records.findIndex((r) => r.type === 'CNAME');
      h.fixture.records[cname] = { ...h.fixture.records[cname]!, comment: 'hand-edited' };

      await remove(domain.id);

      expect(h.fixture.records.map((r) => [r.type, r.comment])).toEqual([['CNAME', 'hand-edited']]);
      expect(h.fixture.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1);
    });

    it('a domain with nothing written queues nothing', async () => {
      const domain = await h.addDomain(host, 'removing');
      const event = {
        aggregate: 'domain',
        aggregateId: domain.id,
        eventId: randomUUID(),
        occurredAt: new Date().toISOString(),
        orgId: h.orgId,
        payload: { domainId: domain.id, orgId: h.orgId, projectId: h.projectId, reason: null },
        traceId: null,
        type: 'domain.removing',
      } as const;

      await h.inTenant((tx) => consumer.handle(event, tx));

      await expect(
        h.inTenant((tx) => new OperationRepository().listForDomain(tx, h.orgId, domain.id)),
      ).resolves.toEqual([]);
    });
  });
});
