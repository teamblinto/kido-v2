import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';

import './support/developer-dotenv';
import { plaintext } from '../src/common/crypto/branded';
import type { Environment } from '../src/config/environment';
import { CloudflareDnsClient } from '../src/modules/connectors/providers/cloudflare/cloudflare-dns.client';
import { NeonClient } from '../src/modules/connectors/providers/neon/neon.client';
import { NetlifyClient } from '../src/modules/connectors/providers/netlify/netlify.client';
import type { VerifyResult } from '../src/modules/connectors/providers/provider';
import { ResendClient } from '../src/modules/connectors/providers/resend/resend.client';
import { SupabaseClient } from '../src/modules/connectors/providers/supabase/supabase.client';

/**
 * Spec 030 T100: the automatable half of quickstart § 9 — each shipped adapter against its
 * provider's real API, read-only. A walk runs only when its `CONNECTOR_REAL_*` variable is set
 * (test-only, deliberately absent from `environment.ts`), so CI and every local run skip it. The
 * banner is `CONNECTOR-SKIP`, one line per provider, distinct from the `SKIPPING` word CI greps.
 * Spec 018's GitHub walk keeps `connectors-real.e2e-spec.ts`.
 *
 * - `CONNECTOR_REAL_NETLIFY_TOKEN` — a personal access token
 * - `CONNECTOR_REAL_NEON_KEY` — a project-scoped or organisation API key
 * - `CONNECTOR_REAL_SUPABASE_ACCESS_TOKEN` — an access token from the OAuth app's grant
 * - `CONNECTOR_REAL_RESEND_KEY` — a `full_access` key (and, optionally,
 *   `CONNECTOR_REAL_RESEND_SENDING_KEY`, a sending-only key, to prove the refusal)
 * - `CONNECTOR_REAL_CLOUDFLARE_TOKEN` + `CONNECTOR_REAL_CLOUDFLARE_HOSTNAME` — a token with Zone
 *   Read + DNS Edit, and a hostname inside one of its zones
 */

const REAL_TIMEOUT_MS = 30_000;
const env = process.env;

/** The adapters' defaults from `environment.ts`: the providers' own endpoints. */
const DEFAULTS: Partial<Record<keyof Environment, string>> = {
  APP_URL: 'http://localhost:5173',
  CLOUDFLARE_API_URL: 'https://api.cloudflare.com/client/v4',
  CONNECTOR_RESEND_API_URL: 'https://api.resend.com',
  NEON_API_URL: 'https://console.neon.tech/api/v2',
  NETLIFY_API_URL: 'https://api.netlify.com/api/v1',
  SUPABASE_API_URL: 'https://api.supabase.com',
  SUPABASE_OAUTH_CLIENT_ID: '',
  SUPABASE_OAUTH_CLIENT_SECRET: '',
};
const config = {
  get: (key: keyof Environment) => DEFAULTS[key],
} as unknown as ConfigService<Environment, true>;

function gate(provider: string, ...names: string[]): boolean {
  const set = names.every((name) => Boolean(env[name]));
  if (!set) {
    process.stderr.write(
      `CONNECTOR-SKIP "connectors-030-real" ${provider}: ${names.join(', ')} not set\n`,
    );
  }

  return set;
}

const note = (line: string) => process.stderr.write(`connectors-030-real ${line}\n`);

function expectVerified(result: VerifyResult, scopes: readonly string[]) {
  expect(result).toMatchObject({ kind: 'verified' });
  if (result.kind !== 'verified') return;
  expect(result.accountRef).not.toBe('');
  expect(result.scopes).toEqual(expect.arrayContaining([...scopes]));
}

describe('Spec 030 connectors against the real providers (e2e)', () => {
  describe.skipIf(!gate('netlify', 'CONNECTOR_REAL_NETLIFY_TOKEN'))('Netlify', () => {
    const client = new NetlifyClient(config);
    const token = () => plaintext(env.CONNECTOR_REAL_NETLIFY_TOKEN!);

    it(
      'a PAT verifies with the account scope and lists sites',
      async () => {
        expectVerified(await client.verify(token()), ['account']);
        const page = await client.listSites(token());
        note(`netlify sites on page 1: ${String(page.items.length)}`);
        expect(Array.isArray(page.items)).toBe(true);
      },
      REAL_TIMEOUT_MS,
    );

    it(
      'a made-up token is revoked, not a failure',
      async () => {
        expect(await client.verify(plaintext('nfp_not-a-real-token'))).toEqual({ kind: 'revoked' });
      },
      REAL_TIMEOUT_MS,
    );
  });

  describe.skipIf(!gate('neon', 'CONNECTOR_REAL_NEON_KEY'))('Neon', () => {
    const client = new NeonClient(config);
    const key = () => plaintext(env.CONNECTOR_REAL_NEON_KEY!);

    it(
      'a key verifies with projects:read and lists at least one project',
      async () => {
        expectVerified(await client.verify(key()), ['projects:read']);
        const page = await client.listProjects(key());
        expect(page.items.length).toBeGreaterThan(0);
      },
      REAL_TIMEOUT_MS,
    );

    it(
      'a made-up key is revoked',
      async () => {
        expect(await client.verify(plaintext('napi_not-a-real-key'))).toEqual({ kind: 'revoked' });
      },
      REAL_TIMEOUT_MS,
    );
  });

  describe.skipIf(!gate('supabase', 'CONNECTOR_REAL_SUPABASE_ACCESS_TOKEN'))('Supabase', () => {
    const client = new SupabaseClient(config);
    const token = () => plaintext(env.CONNECTOR_REAL_SUPABASE_ACCESS_TOKEN!);

    it(
      'an OAuth access token verifies and lists projects',
      async () => {
        expect(await client.verify(token())).toMatchObject({ kind: 'verified' });
        const page = await client.listProjects(token());
        expect(Array.isArray(page.items)).toBe(true);
      },
      REAL_TIMEOUT_MS,
    );
  });

  describe.skipIf(!gate('resend', 'CONNECTOR_REAL_RESEND_KEY'))('Resend', () => {
    const client = new ResendClient(config);
    const key = () => plaintext(env.CONNECTOR_REAL_RESEND_KEY!);

    it(
      "a full-access key verifies with ['full_access'] and lists domains",
      async () => {
        expectVerified(await client.verify(key()), ['full_access']);
        expect(Array.isArray(await client.listDomains(key()))).toBe(true);
      },
      REAL_TIMEOUT_MS,
    );

    it.skipIf(!env.CONNECTOR_REAL_RESEND_SENDING_KEY)(
      "a sending-only key is missing-scope ['full_access'] (Resend's inverted 401)",
      async () => {
        expect(await client.verify(plaintext(env.CONNECTOR_REAL_RESEND_SENDING_KEY!))).toEqual({
          kind: 'missing-scope',
          missing: ['full_access'],
        });
      },
      REAL_TIMEOUT_MS,
    );
  });

  describe.skipIf(
    !gate('cloudflare', 'CONNECTOR_REAL_CLOUDFLARE_TOKEN', 'CONNECTOR_REAL_CLOUDFLARE_HOSTNAME'),
  )('Cloudflare', () => {
    const client = new CloudflareDnsClient(config);
    const token = () => plaintext(env.CONNECTOR_REAL_CLOUDFLARE_TOKEN!);

    it(
      'a scoped token verifies with zone and DNS read, and finds the zone for the hostname',
      async () => {
        expectVerified(await client.verify(token()), ['zone:read', 'dns:read']);
        const zone = await client.zoneFor(token(), env.CONNECTOR_REAL_CLOUDFLARE_HOSTNAME!);
        expect(zone).toBeDefined();
      },
      REAL_TIMEOUT_MS,
    );
  });
});
