import type { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { plaintext } from '../../../../common/crypto/branded';
import type { Environment } from '../../../../config/environment';
import {
  CLOUDFLARE_TOKEN,
  type CloudflareFixture,
  startCloudflareFixture,
} from '../../../../../test/fixtures/provider-fixtures';
import { CloudflareDnsClient } from './cloudflare-dns.client';

let fixture: CloudflareFixture;
let client: CloudflareDnsClient;

beforeAll(async () => {
  fixture = await startCloudflareFixture();
  client = new CloudflareDnsClient({
    get: () => fixture.url,
  } as unknown as ConfigService<Environment, true>);
});

afterAll(() => fixture.close());

beforeEach(() => fixture.reset());

/** Spec 030 T030, contracts/provider-adapters.md § 6, research R6. */
describe('CloudflareDnsClient.verify', () => {
  it('answers verified zone:read and dns:read when zones list and DNS reads', async () => {
    await expect(client.verify(plaintext(CLOUDFLARE_TOKEN))).resolves.toEqual({
      accountName: 'Acme DNS',
      accountRef: 'cf-acct-1',
      kind: 'verified',
      scopes: ['zone:read', 'dns:read'],
    });
    expect(fixture.requests.map((r) => r.path)).toEqual(['/zones', '/zones/zone-1/dns_records']);
  });

  it('answers missing-scope zone:read when no zone is listed', async () => {
    fixture.mode = 'missing-scope';
    await expect(client.verify(plaintext(CLOUDFLARE_TOKEN))).resolves.toEqual({
      kind: 'missing-scope',
      missing: ['zone:read'],
    });
  });

  it('answers missing-scope dns:read when the DNS list is 403', async () => {
    fixture.dnsDenied = true;
    await expect(client.verify(plaintext(CLOUDFLARE_TOKEN))).resolves.toEqual({
      kind: 'missing-scope',
      missing: ['dns:read'],
    });
  });

  it('answers revoked on 401', async () => {
    fixture.mode = 'revoked';
    await expect(client.verify(plaintext(CLOUDFLARE_TOKEN))).resolves.toEqual({
      kind: 'revoked',
    });
  });

  it('answers a retryable failure on 429', async () => {
    fixture.mode = 'rate-limited';
    await expect(client.verify(plaintext(CLOUDFLARE_TOKEN))).resolves.toMatchObject({
      category: 'rate-limited',
      kind: 'failed',
    });
  });
});

/** Spec 030 T049, contracts/provider-adapters.md § 6, research R13. */
describe('CloudflareDnsClient zones and records', () => {
  const token = () => plaintext(CLOUDFLARE_TOKEN);

  it('zoneFor picks the longest suffix among the token zones', async () => {
    fixture.zones = [
      { id: 'zone-1', name: 'acme.test', status: 'active' },
      { id: 'zone-2', name: 'shop.acme.test', status: 'active' },
    ];

    await expect(client.zoneFor(token(), 'www.shop.acme.test')).resolves.toEqual({
      id: 'zone-2',
      name: 'shop.acme.test',
    });
    expect(fixture.requests.map((r) => r.query.get('name'))).toEqual([
      'www.shop.acme.test',
      'shop.acme.test',
    ]);
    expect(fixture.requests.every((r) => r.query.get('status') === 'active')).toBe(true);
  });

  it('zoneFor answers undefined when no suffix is a zone of the token', async () => {
    await expect(client.zoneFor(token(), 'www.other.test')).resolves.toBeUndefined();
  });

  it('records filters by exact name and type', async () => {
    fixture.records.push(
      {
        comment: null,
        content: 'a',
        id: 'r1',
        name: 'www.acme.test',
        proxied: false,
        ttl: 1,
        type: 'CNAME',
        zoneId: 'zone-1',
      },
      {
        comment: null,
        content: 'b',
        id: 'r2',
        name: 'www.acme.test',
        proxied: false,
        ttl: 1,
        type: 'TXT',
        zoneId: 'zone-1',
      },
      {
        comment: null,
        content: 'c',
        id: 'r3',
        name: 'x.www.acme.test',
        proxied: false,
        ttl: 1,
        type: 'CNAME',
        zoneId: 'zone-1',
      },
    );

    await expect(
      client.records(token(), 'zone-1', { name: 'www.acme.test', type: 'CNAME' }),
    ).resolves.toEqual([
      { comment: null, content: 'a', id: 'r1', name: 'www.acme.test', type: 'CNAME' },
    ]);
    expect(fixture.requests[0]!.query.get('name.exact')).toBe('www.acme.test');
    expect(fixture.requests[0]!.query.get('type')).toBe('CNAME');
  });

  it('createRecord sends the marker comment, unproxied, automatic TTL', async () => {
    const created = await client.createRecord(token(), 'zone-1', {
      comment: 'forge:domain:d-1',
      content: 'edge.forge.test',
      name: 'www.acme.test',
      type: 'CNAME',
    });

    expect(created).toMatchObject({ id: fixture.records[0]!.id, name: 'www.acme.test' });
    expect(fixture.requests[0]).toMatchObject({
      body: {
        comment: 'forge:domain:d-1',
        content: 'edge.forge.test',
        name: 'www.acme.test',
        proxied: false,
        ttl: 1,
        type: 'CNAME',
      },
      method: 'POST',
      path: '/zones/zone-1/dns_records',
    });
  });

  it('createRecord maps 403 to forbidden-scope', async () => {
    fixture.dnsWriteDenied = true;

    await expect(
      client.createRecord(token(), 'zone-1', {
        comment: 'forge:domain:d-1',
        content: 'x',
        name: 'www.acme.test',
        type: 'TXT',
      }),
    ).rejects.toMatchObject({ category: 'forbidden-scope' });
  });

  it('record reads one record by id, and a gone one is undefined', async () => {
    fixture.records.push({
      comment: 'forge:domain:d-1',
      content: 'a',
      id: 'r1',
      name: 'www.acme.test',
      proxied: false,
      ttl: 1,
      type: 'CNAME',
      zoneId: 'zone-1',
    });

    await expect(client.record(token(), 'zone-1', 'r1')).resolves.toEqual({
      comment: 'forge:domain:d-1',
      content: 'a',
      id: 'r1',
      name: 'www.acme.test',
      type: 'CNAME',
    });
    await expect(client.record(token(), 'zone-1', 'r2')).resolves.toBeUndefined();
  });

  it('deleteRecord removes the record, and a 404 is success', async () => {
    fixture.records.push({
      comment: null,
      content: 'a',
      id: 'r1',
      name: 'www.acme.test',
      proxied: false,
      ttl: 1,
      type: 'CNAME',
      zoneId: 'zone-1',
    });

    await client.deleteRecord(token(), 'zone-1', 'r1');
    expect(fixture.records).toEqual([]);
    await expect(client.deleteRecord(token(), 'zone-1', 'r1')).resolves.toBeUndefined();
  });
});
