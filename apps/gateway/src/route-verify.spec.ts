import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import {
  createDomainVerifier,
  createRouteVerifier,
  createSiteVerifier,
  type DomainRecord,
  type PreviewJwks,
  type RouteRecord,
  type SiteRecord,
} from './route-verify.ts';

type Pair = Awaited<ReturnType<typeof generateKeyPair>>;

const NOW = new Date('2026-09-18T10:00:00Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

const claims: Omit<RouteRecord, 'exp' | 'iat'> = {
  label: '8f14e45fceea167a5a36dedd4bea2543',
  org: '0f6c5f9e-3c1a-4c56-9a4e-4b8f8d3c1a11',
  ports: [5173],
  project: '6b1d1a7c-8a1b-4c3e-9e6f-2d3c4b5a6f70',
  sandbox: 'sbx_01',
  state: 'active',
  upstream: 'https://5173-sbx.proxy.example.test',
  upstreamToken: 'tok',
  visibility: 'private',
};

async function jwks(pair: Pair, kid: string): Promise<PreviewJwks> {
  return { keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'EdDSA', kid, use: 'sig' }] };
}

function mint(
  pair: Pair,
  kid: string,
  exp = NOW_SECONDS + 30,
  payload: Record<string, unknown> = claims,
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'EdDSA', kid })
    .setIssuedAt(NOW_SECONDS)
    .setExpirationTime(exp)
    .sign(pair.privateKey);
}

describe('createRouteVerifier', () => {
  let pair: Pair;
  let verify: ReturnType<typeof createRouteVerifier>;

  beforeAll(async () => {
    pair = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
    verify = createRouteVerifier(await jwks(pair, 'k1'));
  });

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('accepts a route signed by a key in the JWKS and returns its record', async () => {
    await expect(verify(await mint(pair, 'k1'))).resolves.toEqual({
      ...claims,
      exp: NOW_SECONDS + 30,
      iat: NOW_SECONDS,
    });
  });

  it('refuses a route signed with a key that is not in the JWKS', async () => {
    const other = await generateKeyPair('EdDSA', { crv: 'Ed25519' });

    await expect(verify(await mint(other, 'k1'))).resolves.toBeUndefined();
  });

  it('refuses an unknown kid', async () => {
    await expect(verify(await mint(pair, 'k2'))).resolves.toBeUndefined();
  });

  it('refuses an expired route', async () => {
    const jws = await mint(pair, 'k1', NOW_SECONDS + 30);
    vi.setSystemTime(new Date(NOW.getTime() + 31_000));

    await expect(verify(jws)).resolves.toBeUndefined();
  });

  it('refuses a tampered payload', async () => {
    const [header, payload, signature] = (await mint(pair, 'k1')).split('.');
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload!, 'base64url').toString()),
        ports: [22],
      }),
    ).toString('base64url');

    await expect(verify(`${header}.${forged}.${signature}`)).resolves.toBeUndefined();
  });

  it('refuses a verified signature over a payload that is not a route record', async () => {
    const jws = await mint(pair, 'k1', NOW_SECONDS + 30, { ...claims, ports: ['5173'] });

    await expect(verify(jws)).resolves.toBeUndefined();
  });

  // T065 (contracts/site-serving.md § 3): a validly signed preview record that also carries a
  // `kind`, whatever its value, is not a preview record.
  it.each([['site'], ['preview'], ['']])(
    'refuses a validly signed preview record carrying kind: %j',
    async (kind) => {
      await expect(
        verify(await mint(pair, 'k1', NOW_SECONDS + 30, { ...claims, kind })),
      ).resolves.toBeUndefined();
    },
  );

  it('refuses garbage', async () => {
    await expect(verify('not.a.jws')).resolves.toBeUndefined();
  });
});

/** contracts/site-serving.md § 3: the signed site record. */
const siteClaims: Omit<SiteRecord, 'exp' | 'iat'> = {
  artifact: 'a'.repeat(64),
  deployment: '3c2b1a0f-9e8d-4c7b-8a6f-5e4d3c2b1a0f',
  kind: 'site',
  label: 'my-site-7f3a',
  org: '0f6c5f9e-3c1a-4c56-9a4e-4b8f8d3c1a11',
  project: '6b1d1a7c-8a1b-4c3e-9e6f-2d3c4b5a6f70',
};

describe('createSiteVerifier', () => {
  let pair: Pair;
  let verifySite: ReturnType<typeof createSiteVerifier>;
  let verifyRoute: ReturnType<typeof createRouteVerifier>;

  beforeAll(async () => {
    pair = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
    verifySite = createSiteVerifier(await jwks(pair, 'k1'));
    verifyRoute = createRouteVerifier(await jwks(pair, 'k1'));
  });

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('accepts a site record signed by a key in the JWKS', async () => {
    await expect(verifySite(await mint(pair, 'k1', NOW_SECONDS + 30, siteClaims))).resolves.toEqual(
      {
        ...siteClaims,
        exp: NOW_SECONDS + 30,
        iat: NOW_SECONDS,
      },
    );
  });

  it('refuses a preview route record: no kind, never a site', async () => {
    await expect(verifySite(await mint(pair, 'k1'))).resolves.toBeUndefined();
  });

  it('the preview verifier refuses a site record, so neither replays as the other', async () => {
    const both = { ...claims, ...siteClaims, label: claims.label };

    await expect(
      verifyRoute(await mint(pair, 'k1', NOW_SECONDS + 30, both)),
    ).resolves.toBeUndefined();
  });

  it('refuses a validly signed preview record even when it carries every site field but kind', async () => {
    const previewish: Record<string, unknown> = { ...claims, ...siteClaims, label: claims.label };
    delete previewish.kind;

    await expect(
      verifyRoute(await mint(pair, 'k1', NOW_SECONDS + 30, previewish)),
    ).resolves.not.toBeUndefined();
    await expect(
      verifySite(await mint(pair, 'k1', NOW_SECONDS + 30, previewish)),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['another kind', { kind: 'preview' }],
    ['an uppercase label', { label: 'My-Site' }],
    ['a label ending in "-"', { label: 'site-' }],
    ['a short artifact', { artifact: 'a'.repeat(63) }],
    ['a non-uuid deployment', { deployment: 'dep_1' }],
  ])('refuses %s', async (_name, change) => {
    const jws = await mint(pair, 'k1', NOW_SECONDS + 30, { ...siteClaims, ...change });

    await expect(verifySite(jws)).resolves.toBeUndefined();
  });

  it('refuses a site record signed with another key, or expired', async () => {
    const other = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
    await expect(
      verifySite(await mint(other, 'k1', NOW_SECONDS + 30, siteClaims)),
    ).resolves.toBeUndefined();

    const jws = await mint(pair, 'k1', NOW_SECONDS + 30, siteClaims);
    vi.setSystemTime(new Date(NOW.getTime() + 31_000));
    await expect(verifySite(jws)).resolves.toBeUndefined();
  });
});

/** contracts/domain-serving.md § 2: the signed domain record. */
const HOSTNAME = 'www.acme-example.com';
const domainClaims: Omit<DomainRecord, 'exp' | 'iat'> = {
  artifact: 'a'.repeat(64),
  deployment: '3c2b1a0f-9e8d-4c7b-8a6f-5e4d3c2b1a0f',
  hostname: HOSTNAME,
  kind: 'domain',
  org: '0f6c5f9e-3c1a-4c56-9a4e-4b8f8d3c1a11',
  project: '6b1d1a7c-8a1b-4c3e-9e6f-2d3c4b5a6f70',
};

describe('createDomainVerifier', () => {
  let pair: Pair;
  let verifyDomain: ReturnType<typeof createDomainVerifier>;
  let verifySite: ReturnType<typeof createSiteVerifier>;
  let verifyRoute: ReturnType<typeof createRouteVerifier>;

  beforeAll(async () => {
    pair = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
    const keys = await jwks(pair, 'k1');
    verifyDomain = createDomainVerifier(keys);
    verifySite = createSiteVerifier(keys);
    verifyRoute = createRouteVerifier(keys);
  });

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('accepts a domain record for the requested hostname', async () => {
    await expect(
      verifyDomain(await mint(pair, 'k1', NOW_SECONDS + 30, domainClaims), HOSTNAME),
    ).resolves.toEqual({ ...domainClaims, exp: NOW_SECONDS + 30, iat: NOW_SECONDS });
  });

  it('refuses a bad signature: another key, or a tampered payload', async () => {
    const other = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
    await expect(
      verifyDomain(await mint(other, 'k1', NOW_SECONDS + 30, domainClaims), HOSTNAME),
    ).resolves.toBeUndefined();

    const [header, payload, signature] = (
      await mint(pair, 'k1', NOW_SECONDS + 30, domainClaims)
    ).split('.');
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload!, 'base64url').toString()),
        artifact: 'b'.repeat(64),
      }),
    ).toString('base64url');
    await expect(
      verifyDomain(`${header}.${forged}.${signature}`, HOSTNAME),
    ).resolves.toBeUndefined();
    await expect(verifyDomain('not.a.jws', HOSTNAME)).resolves.toBeUndefined();
  });

  it('refuses an expired record, with no clock tolerance', async () => {
    const jws = await mint(pair, 'k1', NOW_SECONDS + 30, domainClaims);

    vi.setSystemTime(new Date(NOW.getTime() + 30_000));
    await expect(verifyDomain(jws, HOSTNAME)).resolves.toBeUndefined();
  });

  it('refuses a site record and a preview record: kind "site", and a missing kind', async () => {
    await expect(
      verifyDomain(
        await mint(pair, 'k1', NOW_SECONDS + 30, { ...domainClaims, kind: 'site' }),
        HOSTNAME,
      ),
    ).resolves.toBeUndefined();

    const kindless: Record<string, unknown> = { ...domainClaims };
    delete kindless.kind;
    await expect(
      verifyDomain(await mint(pair, 'k1', NOW_SECONDS + 30, kindless), HOSTNAME),
    ).resolves.toBeUndefined();

    // A real site record (with its label) and a real preview route never verify as a domain.
    await expect(
      verifyDomain(await mint(pair, 'k1', NOW_SECONDS + 30, siteClaims), HOSTNAME),
    ).resolves.toBeUndefined();
    await expect(verifyDomain(await mint(pair, 'k1'), HOSTNAME)).resolves.toBeUndefined();
  });

  it('refuses a record signed for another hostname (host A presented for host B)', async () => {
    const jws = await mint(pair, 'k1', NOW_SECONDS + 30, domainClaims);

    await expect(verifyDomain(jws, 'shop.acme-example.com')).resolves.toBeUndefined();
    await expect(verifyDomain(jws, HOSTNAME.toUpperCase())).resolves.toBeUndefined();
    await expect(verifyDomain(jws, `${HOSTNAME}.`)).resolves.toBeUndefined();
  });

  it.each<[string, Partial<DomainRecord>]>([
    ['a short artifact', { artifact: 'a'.repeat(63) }],
    ['a non-uuid deployment', { deployment: 'dep_1' }],
    ['a non-uuid org', { org: 'org_1' }],
    ['a hostname over 253 characters', { hostname: 'a'.repeat(254) }],
  ])('refuses %s', async (_name, change) => {
    const record = { ...domainClaims, ...change };
    const jws = await mint(pair, 'k1', NOW_SECONDS + 30, record);

    await expect(verifyDomain(jws, record.hostname!)).resolves.toBeUndefined();
  });

  it('the site and preview verifiers refuse a domain record', async () => {
    const jws = await mint(pair, 'k1', NOW_SECONDS + 30, domainClaims);
    await expect(verifySite(jws)).resolves.toBeUndefined();
    await expect(verifyRoute(jws)).resolves.toBeUndefined();

    // Even one that carries every site and preview field besides.
    const everything = { ...claims, ...siteClaims, ...domainClaims, label: 'my-site-7f3a' };
    const loaded = await mint(pair, 'k1', NOW_SECONDS + 30, everything);
    await expect(verifySite(loaded)).resolves.toBeUndefined();
    await expect(verifyRoute(loaded)).resolves.toBeUndefined();
    await expect(verifyDomain(loaded, HOSTNAME)).resolves.toMatchObject({ kind: 'domain' });
  });
});
