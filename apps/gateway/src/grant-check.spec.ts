import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import { createGrantVerifier, grantCookie } from './grant-check.ts';
import type { PreviewJwks } from './route-verify.ts';

type Pair = Awaited<ReturnType<typeof generateKeyPair>>;

const NOW = new Date('2026-09-18T10:00:00Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const HOST = '8f14e45fceea167a5a36dedd4bea2543-5173.forge-preview.localhost';
const SUB = '0f6c5f9e-3c1a-4c56-9a4e-4b8f8d3c1a11';

async function jwks(pair: Pair, kid: string): Promise<PreviewJwks> {
  return { keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'EdDSA', kid, use: 'sig' }] };
}

function mint(pair: Pair, kid: string, aud = HOST, exp = NOW_SECONDS + 600): Promise<string> {
  return new SignJWT({ label: HOST.split('-')[0] })
    .setProtectedHeader({ alg: 'EdDSA', kid })
    .setSubject(SUB)
    .setAudience(aud)
    .setIssuedAt(NOW_SECONDS)
    .setExpirationTime(exp)
    .sign(pair.privateKey);
}

describe('createGrantVerifier', () => {
  let pair: Pair;
  let verify: ReturnType<typeof createGrantVerifier>;

  beforeAll(async () => {
    pair = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
    verify = createGrantVerifier(await jwks(pair, 'k1'));
  });

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('accepts a grant for the requested host and returns its claims', async () => {
    await expect(verify(await mint(pair, 'k1'), HOST)).resolves.toEqual({
      aud: HOST,
      exp: NOW_SECONDS + 600,
      sub: SUB,
    });
  });

  it('refuses a grant whose audience is another preview host', async () => {
    const jws = await mint(pair, 'k1', 'ffffffffffffffffffff-5173.forge-preview.localhost');

    await expect(verify(jws, HOST)).resolves.toBeUndefined();
  });

  it('refuses an expired grant', async () => {
    const jws = await mint(pair, 'k1');
    vi.setSystemTime(new Date(NOW.getTime() + 601_000));

    await expect(verify(jws, HOST)).resolves.toBeUndefined();
  });

  it('refuses a grant without exp', async () => {
    const jws = await new SignJWT({})
      .setProtectedHeader({ alg: 'EdDSA', kid: 'k1' })
      .setSubject(SUB)
      .setAudience(HOST)
      .sign(pair.privateKey);

    await expect(verify(jws, HOST)).resolves.toBeUndefined();
  });

  it('refuses a verified grant whose claims are not a grant (no sub)', async () => {
    const jws = await new SignJWT({})
      .setProtectedHeader({ alg: 'EdDSA', kid: 'k1' })
      .setAudience(HOST)
      .setExpirationTime(NOW_SECONDS + 600)
      .sign(pair.privateKey);

    await expect(verify(jws, HOST)).resolves.toBeUndefined();
  });

  it('refuses a tampered grant', async () => {
    const [header, payload, signature] = (await mint(pair, 'k1')).split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload!, 'base64url').toString()), sub: 'x' }),
    ).toString('base64url');

    await expect(verify(`${header}.${forged}.${signature}`, HOST)).resolves.toBeUndefined();
  });

  it('refuses a key outside the JWKS, an unknown kid, and garbage', async () => {
    const other = await generateKeyPair('EdDSA', { crv: 'Ed25519' });

    await expect(verify(await mint(other, 'k1'), HOST)).resolves.toBeUndefined();
    await expect(verify(await mint(pair, 'k2'), HOST)).resolves.toBeUndefined();
    await expect(verify('not.a.jws', HOST)).resolves.toBeUndefined();
  });
});

describe('grantCookie', () => {
  it('reads the grant out of a Cookie header and ignores the rest', () => {
    expect(grantCookie('a=1; __Host-preview_grant=abc.def.ghi; b=2')).toBe('abc.def.ghi');
    expect(grantCookie('a=1')).toBeUndefined();
    expect(grantCookie(undefined)).toBeUndefined();
  });
});
