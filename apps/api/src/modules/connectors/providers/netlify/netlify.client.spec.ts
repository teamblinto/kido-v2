import { createHash } from 'node:crypto';

import type { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { plaintext } from '../../../../common/crypto/branded';
import type { Environment } from '../../../../config/environment';
import {
  NETLIFY_TOKEN,
  type NetlifyFixture,
  startNetlifyFixture,
} from '../../../../../test/fixtures/provider-fixtures';
import { NetlifyClient } from './netlify.client';

let fixture: NetlifyFixture;
let client: NetlifyClient;

beforeAll(async () => {
  fixture = await startNetlifyFixture();
  client = new NetlifyClient({
    get: () => fixture.url,
  } as unknown as ConfigService<Environment, true>);
});

afterAll(() => fixture.close());

beforeEach(() => fixture.reset());

/** Spec 030 T027, contracts/provider-adapters.md § 2, research R5/R6 — against the fixture. */
describe('NetlifyClient.verify', () => {
  it('answers verified with the account slug when /user and /accounts answer 200', async () => {
    await expect(client.verify(plaintext(NETLIFY_TOKEN))).resolves.toEqual({
      accountName: 'Acme Owner',
      accountRef: 'acme-team',
      kind: 'verified',
      scopes: ['account'],
    });
    expect(fixture.requests.map((r) => r.path)).toEqual(['/user', '/accounts']);
    expect(fixture.requests[0]!.authorization).toBe(`Bearer ${NETLIFY_TOKEN}`);
  });

  it('answers revoked on 401', async () => {
    fixture.mode = 'revoked';
    await expect(client.verify(plaintext(NETLIFY_TOKEN))).resolves.toEqual({ kind: 'revoked' });
  });

  it('answers missing-scope on 403', async () => {
    fixture.mode = 'missing-scope';
    await expect(client.verify(plaintext(NETLIFY_TOKEN))).resolves.toEqual({
      kind: 'missing-scope',
      missing: ['account'],
    });
  });

  it('answers a retryable rate limit with retryAfterSeconds from X-RateLimit-Reset on 429', async () => {
    fixture.mode = 'rate-limited';
    const result = await client.verify(plaintext(NETLIFY_TOKEN));

    expect(result).toMatchObject({ category: 'rate-limited', kind: 'failed' });
    const seconds = (result as { retryAfterSeconds?: number }).retryAfterSeconds;
    expect(seconds).toBeGreaterThanOrEqual(25);
    expect(seconds).toBeLessThanOrEqual(31);
  });

  it('answers unavailable on 5xx', async () => {
    fixture.mode = 'unavailable';
    await expect(client.verify(plaintext(NETLIFY_TOKEN))).resolves.toEqual({
      category: 'unavailable',
      kind: 'failed',
    });
  });
});

const token = plaintext(NETLIFY_TOKEN);

function sha1(body: string): string {
  return createHash('sha1').update(body).digest('hex');
}

/** Spec 030 T079, contracts/provider-adapters.md § 2, research R11 — the publish half. */
describe('NetlifyClient sites and deploys', () => {
  it('lists the sites matching q', async () => {
    await expect(client.listSites(token, { q: 'acme' })).resolves.toEqual({
      items: [{ id: 'site-1', name: 'acme-site', url: 'https://acme-site.netlify.app' }],
    });
    const request = fixture.requests[0]!;
    expect(request.path).toBe('/sites');
    expect(request.query.get('name')).toBe('acme');
    expect(request.query.get('filter')).toBe('all');
    expect(request.query.get('per_page')).toBe('50');
  });

  it('creates a site under the account and answers conflict when the name is taken (422)', async () => {
    await expect(client.createSite(token, 'acme-team', 'fresh-site')).resolves.toMatchObject({
      name: 'fresh-site',
      url: 'https://fresh-site.netlify.app',
    });
    expect(fixture.requests[0]!.path).toBe('/acme-team/sites');

    await expect(client.createSite(token, 'acme-team', 'acme-site')).rejects.toMatchObject({
      category: 'conflict',
    });
  });

  it('reads a site and answers not-found on 404', async () => {
    await expect(client.site(token, 'site-1')).resolves.toMatchObject({ id: 'site-1' });
    await expect(client.site(token, 'gone')).rejects.toMatchObject({ category: 'not-found' });
  });

  it('creates a digest deploy with SHA1 files, async: true and the title', async () => {
    const files = { 'assets/app.js': sha1('a'), 'index.html': sha1('i') };
    const deploy = await client.createDeploy(token, 'site-1', files, 'forge:op-1');

    expect(deploy).toEqual({
      id: 'deploy-1',
      required: expect.arrayContaining([sha1('a'), sha1('i')]) as string[],
      state: 'uploading',
    });
    const request = fixture.requests[0]!;
    expect(request.method).toBe('POST');
    expect(request.path).toBe('/sites/site-1/deploys');
    expect(request.body).toEqual({
      async: true,
      files: { '/assets/app.js': sha1('a'), '/index.html': sha1('i') },
      title: 'forge:op-1',
    });
  });

  it('finds a deploy by its exact title only', async () => {
    await client.createDeploy(token, 'site-1', { 'a.txt': sha1('a') }, 'forge:op-10');
    await client.createDeploy(token, 'site-1', { 'a.txt': sha1('a') }, 'forge:op-1');
    fixture.requests.length = 0;

    await expect(client.findDeployByTitle(token, 'site-1', 'forge:op-1')).resolves.toMatchObject({
      id: 'deploy-2',
    });
    await expect(client.findDeployByTitle(token, 'site-1', 'forge:op')).resolves.toBeUndefined();
    expect(fixture.requests[0]!.query.get('per_page')).toBe('20');
  });

  it('uploads a file as octet-stream under its encoded path, then reads the deploy', async () => {
    const body = Buffer.from('hello world');
    const path = 'assets/my file%.txt';
    const deploy = await client.createDeploy(
      token,
      'site-1',
      { [path]: createHash('sha1').update(body).digest('hex') },
      'forge:op-2',
    );

    await client.uploadFile(token, deploy.id, path, body, body.length);

    const put = fixture.requests.at(-1)!;
    expect(put.method).toBe('PUT');
    expect(put.raw.equals(body)).toBe(true);
    expect(fixture.uploads.get(deploy.id)?.get(`/${path}`)).toBe(
      createHash('sha1').update(body).digest('hex'),
    );
    await expect(client.deploy(token, deploy.id)).resolves.toMatchObject({ required: [] });
  });

  it.each(['a#b.html', 'q?x=1.html'])('refuses the path %s before any call', async (path) => {
    await expect(
      client.createDeploy(token, 'site-1', { [path]: sha1('x') }, 'forge:op-3'),
    ).rejects.toMatchObject({ category: 'validation' });
    await expect(
      client.uploadFile(token, 'deploy-1', path, Buffer.from('x'), 1),
    ).rejects.toMatchObject({ category: 'validation' });
    expect(fixture.requests).toEqual([]);
  });
});
