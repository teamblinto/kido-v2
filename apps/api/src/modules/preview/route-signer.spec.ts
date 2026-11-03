import { generateKeyPairSync } from 'node:crypto';

import { createLocalJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PreviewJwks } from '../../config/environment';
import {
  createRouteSigner,
  domainRecordSchema,
  ROUTE_TTL_SECONDS,
  RouteVerifyError,
  siteRecordSchema,
  verifyRoute,
  type PreviewRoute,
} from './route-signer';

/** An Ed25519 pair in the shapes `environment.ts` hands out: base64 PKCS8 and a public JWK. */
function keyPair(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { crv: string; kty: string; x: string };
  return {
    jwk: { ...jwk, alg: 'EdDSA', kid, use: 'sig' } as PreviewJwks['keys'][number],
    signingKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

const route: PreviewRoute = {
  label: '8f14e45fceea167a5a36dedd4bea2543',
  org: '0b4f7b7e-1a37-4b8e-9c3d-0f3b8a4d2a11',
  ports: [5173],
  project: '9c2a3c3e-5f6d-4a1b-8e2f-7d6c5b4a3f21',
  sandbox: 'dtn-sandbox-1',
  state: 'active',
  upstream: 'https://5173-dtn-sandbox-1.proxy.daytona.works',
  upstreamToken: 'per-sandbox-per-port',
  visibility: 'private',
};

const current = keyPair('k-2026-09');
const jwks: PreviewJwks = { keys: [current.jwk] };
const signer = createRouteSigner({
  jwks,
  signingKey: current.signingKey,
  signingKeyId: 'k-2026-09',
});

describe('route signer', () => {
  afterEach(() => vi.useRealTimers());

  it('round-trips a route with kid in the header and exp = iat + ROUTE_TTL', async () => {
    const jws = await signer.sign(route);

    expect(decodeProtectedHeader(jws)).toMatchObject({ alg: 'EdDSA', kid: 'k-2026-09' });
    const claims = decodeJwt(jws);
    expect(claims.exp).toBe((claims.iat ?? 0) + ROUTE_TTL_SECONDS);
    await expect(signer.verify(jws)).resolves.toEqual(claims);
    await expect(verifyRoute(jws, jwks)).resolves.toMatchObject(route);
  });

  it('refuses a route signed by a key the JWKS does not carry', async () => {
    const stranger = keyPair('k-2026-09');
    const jws = await createRouteSigner({
      jwks: { keys: [stranger.jwk] },
      signingKey: stranger.signingKey,
      signingKeyId: 'k-2026-09',
    }).sign(route);

    await expect(verifyRoute(jws, jwks)).rejects.toBeInstanceOf(RouteVerifyError);
  });

  it('refuses an unknown kid', async () => {
    const other = keyPair('k-unknown');
    const jws = await createRouteSigner({
      jwks: { keys: [other.jwk] },
      signingKey: other.signingKey,
      signingKeyId: 'k-unknown',
    }).sign(route);

    await expect(verifyRoute(jws, jwks)).rejects.toBeInstanceOf(RouteVerifyError);
  });

  it('refuses an expired route', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-18T00:00:00Z') });
    const jws = await signer.sign(route);
    vi.setSystemTime(new Date('2026-09-18T00:01:00Z'));

    await expect(verifyRoute(jws, jwks)).rejects.toMatchObject({ code: 'ERR_JWT_EXPIRED' });
  });

  it('refuses a tampered payload', async () => {
    const [header, , signature] = (await signer.sign(route)).split('.');
    const forged = Buffer.from(JSON.stringify({ ...route, ports: [22] })).toString('base64url');

    await expect(verifyRoute(`${header}.${forged}.${signature}`, jwks)).rejects.toBeInstanceOf(
      RouteVerifyError,
    );
  });

  it('refuses a payload that is not a route', async () => {
    const jws = await signer.sign({ ...route, ports: [] });

    await expect(verifyRoute(jws, jwks)).rejects.toBeInstanceOf(RouteVerifyError);
  });

  it('accepts routes from either key during an overlapping rotation', async () => {
    const next = keyPair('k-2026-10');
    const both: PreviewJwks = { keys: [current.jwk, next.jwk] };
    const nextSigner = createRouteSigner({
      jwks: both,
      signingKey: next.signingKey,
      signingKeyId: 'k-2026-10',
    });

    await expect(verifyRoute(await signer.sign(route), both)).resolves.toMatchObject(route);
    await expect(verifyRoute(await nextSigner.sign(route), both)).resolves.toMatchObject(route);
    await expect(nextSigner.verify(await signer.sign(route))).resolves.toMatchObject(route);
  });

  describe('signSite', () => {
    const site = {
      artifact: 'f'.repeat(64),
      deployment: '3d1c2b4a-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
      kind: 'site' as const,
      label: 'my-site-x7k2',
      org: route.org,
      project: route.project,
    };

    it('signs under the preview key and kid with a 30 s expiry, as a strict site record', async () => {
      const jws = await signer.signSite(site);

      expect(decodeProtectedHeader(jws)).toMatchObject({ alg: 'EdDSA', kid: 'k-2026-09' });
      const { payload } = await jwtVerify(jws, createLocalJWKSet(jwks), { algorithms: ['EdDSA'] });
      expect(payload.exp).toBe((payload.iat ?? 0) + 30);
      expect(ROUTE_TTL_SECONDS).toBe(30);
      expect(siteRecordSchema.parse(payload)).toEqual({
        ...site,
        exp: payload.exp,
        iat: payload.iat,
      });
    });

    it('is refused as a preview route, and the schema refuses a record without kind or with extras', async () => {
      await expect(verifyRoute(await signer.signSite(site), jwks)).rejects.toMatchObject({
        code: 'ERR_ROUTE_SHAPE',
      });

      const claims = { ...site, exp: 2, iat: 1 };
      expect(siteRecordSchema.safeParse(claims).success).toBe(true);
      expect(siteRecordSchema.safeParse({ ...claims, kind: undefined }).success).toBe(false);
      expect(siteRecordSchema.safeParse({ ...claims, upstream: 'https://x' }).success).toBe(false);
      expect(siteRecordSchema.safeParse({ ...claims, artifact: 'F'.repeat(64) }).success).toBe(
        false,
      );
      expect(siteRecordSchema.safeParse({ ...claims, org: 'not-a-uuid' }).success).toBe(false);
    });
  });

  describe('signDomain', () => {
    const domain = {
      artifact: 'f'.repeat(64),
      deployment: '3d1c2b4a-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
      hostname: 'www.acme.example',
      kind: 'domain' as const,
      org: route.org,
      project: route.project,
    };

    it('signs exactly the eight fields under the preview key and kid with a 30 s expiry', async () => {
      const jws = await signer.signDomain(domain);

      expect(decodeProtectedHeader(jws)).toMatchObject({ alg: 'EdDSA', kid: 'k-2026-09' });
      const { payload } = await jwtVerify(jws, createLocalJWKSet(jwks), { algorithms: ['EdDSA'] });
      expect(Object.keys(payload).sort()).toEqual([
        'artifact',
        'deployment',
        'exp',
        'hostname',
        'iat',
        'kind',
        'org',
        'project',
      ]);
      expect(payload.exp).toBe((payload.iat ?? 0) + ROUTE_TTL_SECONDS);
      expect(domainRecordSchema.parse(payload)).toEqual({
        ...domain,
        exp: payload.exp,
        iat: payload.iat,
      });
    });

    it('drops anything a caller spreads in beyond the named fields', async () => {
      const jws = await signer.signDomain({
        ...domain,
        upstream: 'https://x',
      } as unknown as typeof domain);

      expect(decodeJwt(jws)).not.toHaveProperty('upstream');
    });

    it('is refused as a preview route and as a site record, and the schema is strict', async () => {
      const jws = await signer.signDomain(domain);
      await expect(verifyRoute(jws, jwks)).rejects.toMatchObject({ code: 'ERR_ROUTE_SHAPE' });
      expect(siteRecordSchema.safeParse(decodeJwt(jws)).success).toBe(false);

      const claims = { ...domain, exp: 2, iat: 1 };
      expect(domainRecordSchema.safeParse(claims).success).toBe(true);
      expect(domainRecordSchema.safeParse({ ...claims, kind: 'site' }).success).toBe(false);
      expect(domainRecordSchema.safeParse({ ...claims, kind: undefined }).success).toBe(false);
      expect(domainRecordSchema.safeParse({ ...claims, label: 'my-site' }).success).toBe(false);
      expect(domainRecordSchema.safeParse({ ...claims, hostname: 'a'.repeat(254) }).success).toBe(
        false,
      );
      expect(domainRecordSchema.safeParse({ ...claims, artifact: 'F'.repeat(64) }).success).toBe(
        false,
      );
      expect(domainRecordSchema.safeParse({ ...claims, project: 'not-a-uuid' }).success).toBe(
        false,
      );
    });
  });
});
