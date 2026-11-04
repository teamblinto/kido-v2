import { generateKeyPairSync } from 'node:crypto';

import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { decodeProtectedHeader, jwtVerify } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { revealPlaintext } from '../../common/crypto/branded';
import type { Environment } from '../../config/environment';
import { OauthExchangeError } from '../identity/services/oauth.service';
import { GITHUB_TIMEOUT_MS, githubFetch } from './github-fetch';
import { GithubApiError, GithubAppClient } from './github-app.client';
import { type GithubFixture, startGithubFixture } from '../../../test/fixtures/github-fixture';

const APP_ID = 4242;
const INSTALLATION_ID = 77;

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ format: 'pem', type: 'pkcs1' });

function configOf(values: Partial<Environment>): ConfigService<Environment, true> {
  return {
    get: (key: keyof Environment) => values[key],
  } as unknown as ConfigService<Environment, true>;
}

let fixture: GithubFixture;
let client: GithubAppClient;

function clientWith(values: Partial<Environment> = {}): GithubAppClient {
  return new GithubAppClient(
    configOf({
      GITHUB_API_URL: fixture.url,
      GITHUB_APP_CLIENT_ID: 'Iv1.app',
      GITHUB_APP_CLIENT_SECRET: 'client-secret',
      GITHUB_APP_ID: APP_ID,
      GITHUB_APP_PRIVATE_KEY: PEM,
      GITHUB_APP_SLUG: 'forge-test',
      GITHUB_INSTALL_URL: fixture.url,
      ...values,
    }),
  );
}

async function category(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof GithubApiError) {
      return error.category;
    }

    throw error;
  }

  return 'no error';
}

beforeAll(async () => {
  fixture = await startGithubFixture();
});

afterAll(async () => {
  await fixture.close();
});

beforeEach(() => {
  fixture.installations.clear();
  fixture.repositories.clear();
  fixture.tokens.clear();
  fixture.requests.length = 0;
  fixture.user.login = 'jane';
  fixture.installations.set(INSTALLATION_ID, {
    account: { id: 9, login: 'acme', type: 'Organization' },
    id: INSTALLATION_ID,
  });
  fixture.repositories.set(1, {
    branches: { main: 'a'.repeat(40) },
    default_branch: 'main',
    full_name: 'acme/site',
    id: 1,
    name: 'site',
    owner: { login: 'acme' },
    private: true,
  });
  client = clientWith();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the App JWT', () => {
  it('is RS256 without a kid, iss = app id, iat 60 s back, exp 10 min ahead', async () => {
    const before = Math.floor(Date.now() / 1000);

    await client.installation(INSTALLATION_ID);

    const header = fixture.requests[0]?.authorization ?? '';

    expect(header).toMatch(/^Bearer /);

    const jwt = header.slice('Bearer '.length);
    const { payload } = await jwtVerify(jwt, publicKey, { algorithms: ['RS256'] });
    const protectedHeader = decodeProtectedHeader(jwt);

    expect(protectedHeader.alg).toBe('RS256');
    expect(protectedHeader.kid).toBeUndefined();
    expect(payload.iss).toBe(String(APP_ID));
    expect(payload.iat).toBeGreaterThanOrEqual(before - 61);
    expect(payload.iat).toBeLessThanOrEqual(before - 59);
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(660);
  });
});

describe('the seven endpoints', () => {
  it('installation(id) parses the account', async () => {
    await expect(client.installation(INSTALLATION_ID)).resolves.toEqual({
      account: { id: 9, login: 'acme', type: 'Organization' },
      id: INSTALLATION_ID,
    });
  });

  it('installation(id) classifies 404 and 401', async () => {
    expect(await category(client.installation(1))).toBe('not-found');
    fixture.override.status = 401;
    expect(await category(client.installation(INSTALLATION_ID))).toBe('unauthorized');
  });

  it('mintToken sends repository_ids and permissions and returns a sealed-shape token', async () => {
    const minted = await client.mintToken(INSTALLATION_ID, {
      permissions: { contents: 'write', metadata: 'read' },
      repositoryIds: [1],
    });

    expect(fixture.requests[0]).toMatchObject({
      body: { permissions: { contents: 'write', metadata: 'read' }, repository_ids: [1] },
      method: 'POST',
      path: `/app/installations/${String(INSTALLATION_ID)}/access_tokens`,
    });
    expect(minted.expiresAt).toBeInstanceOf(Date);
    expect(minted.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(fixture.tokens.has(revealPlaintext(minted.token).toString('utf8'))).toBe(true);
  });

  it('mintToken without repositoryIds omits the key', async () => {
    await client.mintToken(INSTALLATION_ID, { permissions: { metadata: 'read' } });

    expect(fixture.requests[0]?.body).toEqual({ permissions: { metadata: 'read' } });
  });

  it('listRepositories pages under the token', async () => {
    const { token } = await client.mintToken(INSTALLATION_ID, { permissions: {} });
    const page = await client.listRepositories(token, 1);

    expect(page.totalCount).toBe(1);
    expect(page.repositories).toEqual([
      {
        defaultBranch: 'main',
        fullName: 'acme/site',
        id: 1,
        name: 'site',
        owner: 'acme',
        private: true,
        sizeKib: 0,
      },
    ]);
    expect(fixture.requests[1]?.path).toBe('/installation/repositories');
    expect(fixture.requests[1]?.authorization).toBe(
      `Bearer ${revealPlaintext(token).toString('utf8')}`,
    );
  });

  it('createOrgRepository posts name and private; a taken name is validation', async () => {
    const { token } = await client.mintToken(INSTALLATION_ID, { permissions: {} });
    const created = await client.createOrgRepository(token, 'acme', 'docs', true);

    expect(fixture.requests[1]).toMatchObject({
      body: { name: 'docs', private: true },
      method: 'POST',
      path: '/orgs/acme/repos',
    });
    expect(created).toMatchObject({ fullName: 'acme/docs', owner: 'acme', private: true });
    expect(await category(client.createOrgRepository(token, 'acme', 'site', true))).toBe(
      'validation',
    );
  });

  it('repository(token, id) reads one by id', async () => {
    const { token } = await client.mintToken(INSTALLATION_ID, { permissions: {} });

    await expect(client.repository(token, 1)).resolves.toMatchObject({ fullName: 'acme/site' });
    expect(await category(client.repository(token, 2))).toBe('not-found');
  });

  it('branch(token, owner, repo, branch) reads the head sha', async () => {
    const { token } = await client.mintToken(INSTALLATION_ID, { permissions: {} });

    await expect(client.branch(token, 'acme', 'site', 'main')).resolves.toEqual({
      name: 'main',
      sha: 'a'.repeat(40),
    });
    expect(await category(client.branch(token, 'acme', 'site', 'dev'))).toBe('not-found');
  });

  it('deleteInstallation succeeds on 204 and on 404', async () => {
    await expect(client.deleteInstallation(INSTALLATION_ID)).resolves.toBeUndefined();
    expect(fixture.installations.has(INSTALLATION_ID)).toBe(false);
    await expect(client.deleteInstallation(INSTALLATION_ID)).resolves.toBeUndefined();
    fixture.override.status = 500;
    expect(await category(client.deleteInstallation(INSTALLATION_ID))).toBe('unavailable');
  });
});

describe('branches (spec 044)', () => {
  it('listBranches pages until a short page and reports protection', async () => {
    const branches = Object.fromEntries(
      Array.from({ length: 150 }, (_, index) => [`b${String(index)}`, 'a'.repeat(40)]),
    );

    fixture.repositories.set(2, {
      ...fixture.repositories.get(1)!,
      branches,
      id: 2,
      protected: ['b0'],
    });

    const { token } = await client.mintToken(INSTALLATION_ID, { permissions: {} });
    const listed = await client.listBranches(token, 2);

    expect(listed).toHaveLength(150);
    expect(listed[0]).toEqual({ name: 'b0', protected: true });
    expect(listed[149]).toEqual({ name: 'b149', protected: false });
    expect(fixture.requests.filter((request) => request.path.endsWith('/branches'))).toHaveLength(
      2,
    );
  });

  it('listBranches stops at 300 however many there are', async () => {
    const branches = Object.fromEntries(
      Array.from({ length: 450 }, (_, index) => [`b${String(index)}`, 'a'.repeat(40)]),
    );

    fixture.repositories.set(2, { ...fixture.repositories.get(1)!, branches, id: 2 });

    const { token } = await client.mintToken(INSTALLATION_ID, { permissions: {} });

    await expect(client.listBranches(token, 2)).resolves.toHaveLength(300);
    expect(fixture.requests.filter((request) => request.path.endsWith('/branches'))).toHaveLength(
      3,
    );
  });

  it('createRef posts refs/heads/<name>; a taken name is validation', async () => {
    const { token } = await client.mintToken(INSTALLATION_ID, { permissions: {} });

    await client.createRef(token, 'acme', 'site', 'feature/x', 'a'.repeat(40));

    expect(fixture.requests[1]).toMatchObject({
      body: { ref: 'refs/heads/feature/x', sha: 'a'.repeat(40) },
      method: 'POST',
      path: '/repos/acme/site/git/refs',
    });
    expect(await category(client.createRef(token, 'acme', 'site', 'main', 'a'.repeat(40)))).toBe(
      'validation',
    );
  });
});

describe('the one-shot user token (spec 044)', () => {
  it('canAuthorizeUsers needs both the client id and the secret; isConfigured does not move', () => {
    const noSecret = clientWith({ GITHUB_APP_CLIENT_SECRET: undefined });

    expect(client.canAuthorizeUsers()).toBe(true);
    expect(noSecret.canAuthorizeUsers()).toBe(false);
    expect(noSecret.isConfigured()).toBe(true);
    expect(clientWith({ GITHUB_APP_CLIENT_ID: undefined }).canAuthorizeUsers()).toBe(false);
  });

  it('authorizeUrl names the client and the state and asks for no scope', () => {
    const url = new URL(client.authorizeUrl('st ate'));

    expect(`${url.origin}${url.pathname}`).toBe(`${fixture.url}/login/oauth/authorize`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: 'Iv1.app', state: 'st ate' });
  });

  it('exchangeUserCode sends the client pair and the code in the body, and answers a Plaintext', async () => {
    const token = await client.exchangeUserCode('good');

    expect(revealPlaintext(token).toString('utf8')).toMatch(/^ghu_/u);
    expect(fixture.requests[0]).toMatchObject({
      authorization: undefined,
      body: { client_id: 'Iv1.app', client_secret: 'client-secret', code: 'good' },
      method: 'POST',
      path: '/login/oauth/access_token',
    });
  });

  it('a 200 with `error` is an OauthExchangeError that quotes nothing, and no log line carries the code', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await expect(client.exchangeUserCode('bad')).rejects.toBeInstanceOf(OauthExchangeError);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('bad_verification_code');
  });

  it('a failed exchange logs neither the secret nor the code', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    fixture.override.status = 500;

    expect(await category(client.exchangeUserCode('sensitive-code'))).toBe('unavailable');

    const logged = JSON.stringify(warn.mock.calls);

    expect(logged).not.toContain('client-secret');
    expect(logged).not.toContain('sensitive-code');
  });

  it('exchangeUserCode without the secret never reaches GitHub', async () => {
    const noSecret = clientWith({ GITHUB_APP_CLIENT_SECRET: undefined });

    expect(await category(noSecret.exchangeUserCode('good'))).toBe('not-configured');
    expect(fixture.requests).toHaveLength(0);
  });

  it('userLogin reads /user under the user token', async () => {
    const token = await client.exchangeUserCode('good');

    await expect(client.userLogin(token)).resolves.toBe('jane');
    expect(fixture.requests[1]?.authorization).toBe(
      `Bearer ${revealPlaintext(token).toString('utf8')}`,
    );
  });

  it('createUserRepository posts name and private; a taken name is validation', async () => {
    const token = await client.exchangeUserCode('good');

    await expect(client.createUserRepository(token, 'blog', true)).resolves.toMatchObject({
      fullName: 'jane/blog',
      owner: 'jane',
      private: true,
    });
    expect(fixture.requests[1]).toMatchObject({
      body: { name: 'blog', private: true },
      method: 'POST',
      path: '/user/repos',
    });
    expect(await category(client.createUserRepository(token, 'blog', true))).toBe('validation');
  });

  it('addRepositoryToInstallation puts the repository; a failure keeps its category', async () => {
    const token = await client.exchangeUserCode('good');

    await expect(
      client.addRepositoryToInstallation(token, INSTALLATION_ID, 1),
    ).resolves.toBeUndefined();
    expect(fixture.requests[1]).toMatchObject({
      method: 'PUT',
      path: `/user/installations/${String(INSTALLATION_ID)}/repositories/1`,
    });
    expect(await category(client.addRepositoryToInstallation(token, INSTALLATION_ID, 99))).toBe(
      'not-found',
    );
  });
});

describe('status → category (R11)', () => {
  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [404, 'not-found'],
    [409, 'conflict'],
    [422, 'validation'],
    [429, 'rate-limited'],
    [500, 'unavailable'],
    [502, 'unavailable'],
    [503, 'unavailable'],
  ])('%i → %s, and the body is never read', async (status, expected) => {
    const responses: Response[] = [];
    const realFetch = globalThis.fetch;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const response = await realFetch(input, init);

      responses.push(response);

      return response;
    });
    fixture.override.status = status;

    expect(await category(client.installation(INSTALLATION_ID))).toBe(expected);
    expect(responses).toHaveLength(1);
    expect(responses[0]?.bodyUsed).toBe(false);
  });

  it('a 2xx body that is not the expected shape is unavailable', async () => {
    fixture.installations.set(5, { account: { id: 1 } } as never);
    expect(await category(client.installation(5))).toBe('unavailable');
  });

  it('a connection refused is unavailable', async () => {
    const dead = clientWith({ GITHUB_API_URL: 'http://127.0.0.1:1' });

    expect(await category(dead.installation(INSTALLATION_ID))).toBe('unavailable');
  });
});

describe('the timeout', () => {
  it('is ten seconds', () => {
    expect(GITHUB_TIMEOUT_MS).toBe(10_000);
  });

  it('a server that never answers is unavailable', async () => {
    fixture.override.hang = true;

    const work = githubFetch(
      `${fixture.url}/app/installations/1`,
      {},
      {
        logger: new Logger('test'),
        timeoutMs: 50,
      },
    );

    await expect(work).rejects.toMatchObject({ category: 'unavailable' });
  });
});

describe('not configured', () => {
  it('every call fails with not-configured when the App env is absent', async () => {
    const bare = clientWith({
      GITHUB_APP_CLIENT_ID: undefined,
      GITHUB_APP_ID: undefined,
      GITHUB_APP_PRIVATE_KEY: undefined,
      GITHUB_APP_SLUG: undefined,
    });

    expect(bare.isConfigured()).toBe(false);
    expect(client.isConfigured()).toBe(true);
    expect(await category(bare.installation(INSTALLATION_ID))).toBe('not-configured');
    expect(await category(bare.deleteInstallation(INSTALLATION_ID))).toBe('not-configured');
    expect(fixture.requests).toHaveLength(0);
  });
});
