import type { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { plaintext } from '../../../../common/crypto/branded';
import type { Environment } from '../../../../config/environment';
import {
  type ProviderFixture,
  RESEND_KEY,
  RESEND_SENDING_KEY,
  startResendFixture,
} from '../../../../../test/fixtures/provider-fixtures';
import {
  installResendState,
  RESEND_PENDING_DOMAIN,
  RESEND_VERIFIED_DOMAIN,
  type ResendState,
} from '../../../../../test/fixtures/resend-state';
import { ProviderFailure } from '../provider';
import { ResendClient } from './resend.client';

let fixture: ProviderFixture;
let client: ResendClient;

beforeAll(async () => {
  fixture = await startResendFixture();
  client = new ResendClient({
    get: () => fixture.url,
  } as unknown as ConfigService<Environment, true>);
});

afterAll(() => fixture.close());

beforeEach(() => fixture.reset());

/**
 * Spec 030 T029, research R5: Resend inverts the usual pair — a 401 `restricted_api_key` is a live
 * key short of full access, a 403 is a dead one — so the adapter branches on the error name.
 */
describe('ResendClient.verify', () => {
  it('answers verified full_access on 200', async () => {
    await expect(client.verify(plaintext(RESEND_KEY))).resolves.toMatchObject({
      kind: 'verified',
      scopes: ['full_access'],
    });
    expect(fixture.requests[0]!.path).toBe('/domains');
  });

  it('answers missing-scope full_access on 401 restricted_api_key (a sending-only key)', async () => {
    await expect(client.verify(plaintext(RESEND_SENDING_KEY))).resolves.toEqual({
      kind: 'missing-scope',
      missing: ['full_access'],
    });
  });

  it('answers revoked on 403 restricted_api_key (not active)', async () => {
    await expect(client.verify(plaintext('re_unknownKey_0123456789'))).resolves.toEqual({
      kind: 'revoked',
    });
  });

  it('answers revoked on 403 suspended_api_key', async () => {
    fixture.route('GET', '/domains', () => ({
      body: { message: 'suspended', name: 'suspended_api_key', statusCode: 403 },
      status: 403,
    }));
    await expect(client.verify(plaintext(RESEND_KEY))).resolves.toEqual({ kind: 'revoked' });
  });

  it('answers a retryable failure on 429 rate_limit_exceeded', async () => {
    fixture.mode = 'rate-limited';
    await expect(client.verify(plaintext(RESEND_KEY))).resolves.toEqual({
      category: 'rate-limited',
      kind: 'failed',
      retryAfterSeconds: 1,
    });
  });
});

/** Spec 030 T092: the domains a binding picks from, and the sending key it mints (§ 5). */
describe('ResendClient domains and keys', () => {
  let state: ResendState;
  const key = plaintext(RESEND_KEY);

  beforeEach(() => {
    state = installResendState(fixture);
  });

  it('listDomains pages with after until has_more is false', async () => {
    state.domains.push(
      ...Array.from({ length: 150 }, (_, index) => ({
        id: `dom-extra-${String(index)}`,
        name: `extra-${String(index)}.acme.test`,
        status: 'verified',
      })),
    );

    const domains = await client.listDomains(key);

    expect(domains).toHaveLength(153);
    expect(domains[0]).toEqual({
      id: RESEND_VERIFIED_DOMAIN,
      name: 'mail.acme.test',
      status: 'verified',
    });
    const pages = fixture.requests.filter((request) => request.path === '/domains');
    expect(
      pages.map((request) => [request.query.get('limit'), request.query.get('after')]),
    ).toEqual([
      ['100', null],
      ['100', 'dom-extra-96'],
    ]);
  });

  it("domain reads one domain's status", async () => {
    await expect(client.domain(key, RESEND_PENDING_DOMAIN)).resolves.toEqual({
      id: RESEND_PENDING_DOMAIN,
      name: 'news.acme.test',
      status: 'pending',
    });
    await expect(client.domainStatus(key, RESEND_PENDING_DOMAIN)).resolves.toBe('pending');
  });

  it('createSendingKey sends permission sending_access and domain_id', async () => {
    const created = await client.createSendingKey(key, 'forge-p1', RESEND_VERIFIED_DOMAIN);

    expect(created.id).toBe('key-1');
    expect(created.token).toMatch(/^re_sending_1/);
    const post = fixture.requests.find((request) => request.method === 'POST')!;
    expect(post.path).toBe('/api-keys');
    expect(post.body).toEqual({
      domain_id: RESEND_VERIFIED_DOMAIN,
      name: 'forge-p1',
      permission: 'sending_access',
    });
  });

  it('listKeys lists id and name', async () => {
    await client.createSendingKey(key, 'forge-p1', RESEND_VERIFIED_DOMAIN);

    await expect(client.listKeys(key)).resolves.toEqual([{ id: 'key-1', name: 'forge-p1' }]);
  });

  it('deleteKey deletes, and a 404 is success', async () => {
    await client.createSendingKey(key, 'forge-p1', RESEND_VERIFIED_DOMAIN);

    await client.deleteKey(key, 'key-1');
    expect(state.keys).toEqual([]);
    await expect(client.deleteKey(key, 'key-1')).resolves.toBeUndefined();
  });

  it('a 403 on deleteKey is a ProviderFailure, not success', async () => {
    fixture.route('DELETE', '/api-keys/:id', () => ({
      body: { message: 'not active', name: 'restricted_api_key', statusCode: 403 },
      status: 403,
    }));

    await expect(client.deleteKey(key, 'key-1')).rejects.toBeInstanceOf(ProviderFailure);
  });
});
