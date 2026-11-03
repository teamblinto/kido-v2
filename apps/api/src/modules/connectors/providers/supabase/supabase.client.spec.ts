import type { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { plaintext } from '../../../../common/crypto/branded';
import type { Environment } from '../../../../config/environment';
import {
  startSupabaseFixture,
  SUPABASE_CLIENT_ID,
  SUPABASE_CLIENT_SECRET,
  type SupabaseFixture,
} from '../../../../../test/fixtures/provider-fixtures';
import { ProviderFailure } from '../provider';
import { SupabaseClient } from './supabase.client';

const APP_URL = 'http://localhost:5173';

let fixture: SupabaseFixture;
let client: SupabaseClient;

function clientWith(values: Partial<Environment>): SupabaseClient {
  return new SupabaseClient({
    get: (key: keyof Environment) => values[key],
  } as unknown as ConfigService<Environment, true>);
}

beforeAll(async () => {
  fixture = await startSupabaseFixture();
  client = clientWith({
    APP_URL,
    SUPABASE_API_URL: fixture.url,
    SUPABASE_OAUTH_CLIENT_ID: SUPABASE_CLIENT_ID,
    SUPABASE_OAUTH_CLIENT_SECRET: SUPABASE_CLIENT_SECRET,
  });
});

afterAll(() => fixture.close());

beforeEach(() => fixture.reset());

function pkce(): { challenge: string; verifier: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { challenge: createHash('sha256').update(verifier).digest('base64url'), verifier };
}

async function failureOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ProviderFailure) return error.category;
    throw error;
  }
  return 'no error';
}

/** Spec 030 T031 (TDD, crypto boundary): contracts/provider-adapters.md § 4, research R1/R10. */
describe('SupabaseClient', () => {
  it('is not configured without the OAuth client pair', () => {
    expect(clientWith({ APP_URL, SUPABASE_API_URL: fixture.url }).isConfigured()).toBe(false);
    expect(client.isConfigured()).toBe(true);
  });

  it('builds an authorize URL carrying state, the S256 challenge and the redirect', () => {
    const url = new URL(client.authorizeUrl('the-state', 'the-challenge'));

    expect(url.origin + url.pathname).toBe(`${fixture.url}/v1/oauth/authorize`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: SUPABASE_CLIENT_ID,
      code_challenge: 'the-challenge',
      code_challenge_method: 'S256',
      redirect_uri: `${APP_URL}/connectors/supabase/callback`,
      response_type: 'code',
      state: 'the-state',
    });
  });

  it('exchanges a code with the verifier and basic client auth', async () => {
    const { challenge, verifier } = pkce();
    const code = fixture.authorize(challenge, client.redirectUri());

    const grant = await client.exchange(code, verifier);

    expect(grant.accessToken).toMatch(/^sbp_/);
    expect(grant.refreshToken).toMatch(/^sbr_/);
    expect(grant.expiresInSeconds).toBe(3600);

    const request = fixture.requests.at(-1)!;
    expect(request.authorization).toBe(
      `Basic ${Buffer.from(`${SUPABASE_CLIENT_ID}:${SUPABASE_CLIENT_SECRET}`).toString('base64')}`,
    );
    expect(request.body).toMatchObject({
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
    });
  });

  it('refuses an exchange whose verifier does not match the challenge', async () => {
    const { challenge } = pkce();
    const code = fixture.authorize(challenge, client.redirectUri());

    expect(await failureOf(client.exchange(code, pkce().verifier))).toBe('unauthorized');
  });

  it('refreshes a live grant', async () => {
    const { challenge, verifier } = pkce();
    const grant = await client.exchange(
      fixture.authorize(challenge, client.redirectUri()),
      verifier,
    );

    const next = await client.refresh(grant.refreshToken);

    expect(next.accessToken).not.toBe(grant.accessToken);
    expect(fixture.refreshCount).toBe(1);
  });

  it('answers a refused refresh (400) as revoked', async () => {
    expect(await failureOf(client.refresh('sbr_unknown'))).toBe('unauthorized');
  });

  it('answers a refused refresh (401) as revoked', async () => {
    fixture.route('POST', '/v1/oauth/token', () => ({ status: 401 }));
    expect(await failureOf(client.refresh('sbr_unknown'))).toBe('unauthorized');
  });

  it('treats any 4xx from revoke as success', async () => {
    fixture.route('POST', '/v1/oauth/revoke', () => ({ status: 400 }));
    await expect(client.revoke('sbr_unknown')).resolves.toBeUndefined();
    fixture.route('POST', '/v1/oauth/revoke', () => ({ status: 404 }));
    await expect(client.revoke('sbr_unknown')).resolves.toBeUndefined();
  });

  it('verifies through /v1/profile and /v1/organizations', async () => {
    const { challenge, verifier } = pkce();
    const grant = await client.exchange(
      fixture.authorize(challenge, client.redirectUri()),
      verifier,
    );
    fixture.requests.length = 0;

    await expect(client.verify(plaintext(grant.accessToken))).resolves.toEqual({
      accountName: 'Acme Supabase',
      accountRef: 'sb-org-1',
      kind: 'verified',
      scopes: ['projects:read', 'secrets:read'],
    });
    expect(fixture.requests.map((r) => r.path)).toEqual(['/v1/profile', '/v1/organizations']);
  });

  it('answers revoked when the access token is refused', async () => {
    await expect(client.verify(plaintext('sbp_nope'))).resolves.toEqual({ kind: 'revoked' });
  });
});

/** Spec 030 T064, contracts/provider-adapters.md § 4, research R10. */
describe('SupabaseClient projects and the publishable key', () => {
  const token = () => plaintext(fixture.token);
  interface Key {
    api_key: string;
    name: string;
    type: string;
  }

  function keys(list: Key[]): void {
    fixture.route('GET', '/v1/projects/:ref/api-keys', () => ({ body: list, status: 200 }));
  }

  it('listProjects lists the projects the grant sees', async () => {
    fixture.route('GET', '/v1/projects', () => ({
      body: [
        {
          id: 'abcref',
          name: 'Shop',
          organization_id: 'sb-org-1',
          region: 'eu-west-1',
          status: 'ACTIVE_HEALTHY',
        },
      ],
      status: 200,
    }));

    await expect(client.listProjects(token())).resolves.toEqual({
      items: [{ name: 'Shop', ref: 'abcref', region: 'eu-west-1', status: 'ACTIVE_HEALTHY' }],
    });
  });

  it('publishableKey never sends reveal, and prefers the publishable key', async () => {
    keys([
      { api_key: 'eyJlegacy', name: 'anon', type: 'legacy' },
      { api_key: 'sb_publishable_abc', name: 'default', type: 'publishable' },
      { api_key: 'sb_secret_••••', name: 'default', type: 'secret' },
    ]);

    await expect(client.publishableKey(token(), 'abcref')).resolves.toBe('sb_publishable_abc');

    const request = fixture.requests.at(-1)!;

    expect(request.path).toBe('/v1/projects/abcref/api-keys');
    expect(request.query.has('reveal')).toBe(false);
  });

  it('falls back to the legacy anon key', async () => {
    keys([
      { api_key: 'eyJlegacy', name: 'anon', type: 'legacy' },
      { api_key: 'eyJservice', name: 'service_role', type: 'legacy' },
    ]);

    await expect(client.publishableKey(token(), 'abcref')).resolves.toBe('eyJlegacy');
  });

  it('neither → not-found', async () => {
    keys([{ api_key: 'eyJservice', name: 'service_role', type: 'legacy' }]);

    expect(await failureOf(client.publishableKey(token(), 'abcref'))).toBe('not-found');
  });
});
