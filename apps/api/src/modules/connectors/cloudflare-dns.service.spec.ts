import { schema } from '@repo/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import {
  type CloudflareDnsHarness,
  EDGE_TARGET,
  startCloudflareDnsHarness,
} from '../../../test/support/cloudflare-dns-harness';
import { CloudflareDnsService, recordMarker } from './cloudflare-dns.service';
import { OperationRepository } from './operation.repository';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

if (!postgres || !redis) {
  console.warn(
    'SKIPPING cloudflare-dns.service.spec.ts: Postgres or the session Redis is not reachable',
  );
}

/**
 * Spec 030 US2 (T050), research R13, contracts/bindings.md § 3: the domain offer and the write,
 * against Postgres and the Cloudflare fixture, the `dns_write` operation run through the real ops
 * consumer.
 */
describe('CloudflareDnsService', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and the Cloudflare fixture', () => {
    let h: CloudflareDnsHarness;
    let service: CloudflareDnsService;

    function offer(domainId: string) {
      return h.inTenant((tx) => service.offer(tx, h.orgId, domainId));
    }

    function requestWrite(domainId: string) {
      return h.inTenant((tx) => service.requestWrite(tx, h.orgId, h.userId, domainId));
    }

    function resources(domainId: string) {
      return h.inTenant((tx) =>
        tx
          .select()
          .from(schema.connectorResources)
          .where(
            and(
              eq(schema.connectorResources.orgId, h.orgId),
              eq(schema.connectorResources.domainId, domainId),
            ),
          ),
      );
    }

    function seed(type: string, name: string, content: string, comment: string | null = null) {
      h.fixture.records.push({
        comment,
        content,
        id: `seed-${h.fixture.records.length + 1}`,
        name,
        proxied: false,
        ttl: 1,
        type,
        zoneId: 'zone-1',
      });
    }

    beforeAll(async () => {
      h = await startCloudflareDnsHarness();
      service = h.moduleRef.get(CloudflareDnsService, { strict: false });
    }, 60_000);

    afterAll(() => h?.close());

    let host: string;

    beforeEach(async () => {
      await h.reset();
      host = h.host();
    });

    it('is not-connected without a Cloudflare connection, and writes nothing', async () => {
      const domain = await h.addDomain(host);

      await expect(offer(domain.id)).resolves.toMatchObject({ status: 'not-connected' });
      expect(h.fixture.requests).toEqual([]);
    });

    it('is writable with the ownership TXT and the CNAME when a zone holds the hostname', async () => {
      await h.connect();
      const domain = await h.addDomain(host);

      await expect(offer(domain.id)).resolves.toEqual({
        records: [
          {
            content: `forge-verify=${domain.ownershipToken}`,
            name: `_forge-challenge.${host}`,
            type: 'TXT',
          },
          { content: EDGE_TARGET, name: host, type: 'CNAME' },
        ],
        status: 'writable',
        zone: { id: 'zone-1', name: 'acme.test' },
      });
      expect(h.fixture.requests.some((r) => r.method !== 'GET')).toBe(false);
    });

    it('is zone-not-found when no zone of the token holds the hostname', async () => {
      await h.connect();
      const domain = await h.addDomain(h.host('elsewhere.test'));

      await expect(offer(domain.id)).resolves.toMatchObject({ status: 'zone-not-found' });
    });

    it('is needs-reauth while the connection needs re-authorisation', async () => {
      const connection = await h.connect();
      await h.inTenant((tx) =>
        tx
          .update(schema.connections)
          .set({ health: 'needs_reauth' })
          .where(eq(schema.connections.id, connection.id)),
      );
      const domain = await h.addDomain(host);

      await expect(offer(domain.id)).resolves.toMatchObject({ status: 'needs-reauth' });
    });

    it('writes both records marked, unproxied, and records them live; the offer is then written', async () => {
      await h.connect();
      const domain = await h.addDomain(host);

      const operation = await requestWrite(domain.id);
      expect(operation).toMatchObject({ kind: 'dns_write', state: 'queued' });
      await h.runOperation(operation.id);

      expect(h.fixture.records).toHaveLength(2);
      for (const record of h.fixture.records) {
        expect(record).toMatchObject({ comment: recordMarker(domain.id), proxied: false, ttl: 1 });
      }
      const rows = await resources(domain.id);
      expect(rows.map((r) => [r.state, r.scopeRef]).sort()).toEqual([
        ['live', 'zone-1'],
        ['live', 'zone-1'],
      ]);
      expect(rows.map((r) => r.externalId).sort()).toEqual(
        h.fixture.records.map((r) => r.id).sort(),
      );
      await expect(offer(domain.id)).resolves.toMatchObject({ status: 'written' });
      expect(await h.auditActions()).toContain('connector.dns-written');
    });

    it('adopts an identical existing record rather than writing a second', async () => {
      await h.connect();
      const domain = await h.addDomain(host);
      seed('CNAME', host, EDGE_TARGET);

      const operation = await requestWrite(domain.id);
      await h.runOperation(operation.id);

      expect(h.fixture.records.filter((r) => r.type === 'CNAME')).toHaveLength(1);
      expect(h.fixture.records).toHaveLength(2);
      expect((await resources(domain.id)).map((r) => r.externalId)).toContain('seed-1');
    });

    it('a different record at the name is record-conflict: offered with the conflict, refused at write, nothing written', async () => {
      await h.connect();
      const domain = await h.addDomain(host);
      seed('CNAME', host, 'someone-else.example');

      await expect(offer(domain.id)).resolves.toMatchObject({
        conflict: { content: 'someone-else.example', name: host, type: 'CNAME' },
      });
      await expect(requestWrite(domain.id)).rejects.toMatchObject({
        extensions: { reason: 'record-conflict' },
      });
      expect(h.fixture.records).toHaveLength(1);
      expect(h.fixture.requests.some((r) => r.method !== 'GET')).toBe(false);
      await expect(
        h.inTenant((tx) => new OperationRepository().listForDomain(tx, h.orgId, domain.id)),
      ).resolves.toEqual([]);
    });

    it('a 403 at write turns the connection needs_reauth and the operation missing-scope', async () => {
      const connection = await h.connect();
      const domain = await h.addDomain(host);
      const operation = await requestWrite(domain.id);
      h.fixture.dnsWriteDenied = true;

      await h.runOperation(operation.id);

      const row = await h.inTenant((tx) =>
        new OperationRepository().byId(tx, h.orgId, operation.id),
      );
      expect(row).toMatchObject({ reason: 'missing-scope', state: 'failed' });
      const [after] = await h.inTenant((tx) =>
        tx.select().from(schema.connections).where(eq(schema.connections.id, connection.id)),
      );
      expect(after!.health).toBe('needs_reauth');
      expect(await resources(domain.id)).toEqual([]);
    });

    it('only a pending domain is writable', async () => {
      await h.connect();
      const domain = await h.addDomain(host, 'active');

      await expect(requestWrite(domain.id)).rejects.toMatchObject({ type: 'conflict' });
      expect(h.fixture.requests).toEqual([]);
    });
  });
});
