import { createPrivateKey, generateKeyPairSync } from 'node:crypto';

import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { decodeJwt, SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';

import { ForbiddenError, RateLimitedError } from '../../common/errors/domain-error';
import type { Environment, PreviewJwks } from '../../config/environment';
import type { TenantTransactionRunner } from '../../database/tenant-transaction';
import type { AuditService } from '../audit/audit.service';
import { callbackRateKey } from './preview.constants';
import {
  CALLBACK_RATE_LIMIT,
  CALLBACK_RATE_WINDOW_SECONDS,
  SANDBOX_CALLBACK,
  SANDBOX_LEASE_EPOCH,
  SandboxCallbackGuard,
} from './sandbox-callback.guard';
import {
  createSandboxCallbackSigner,
  SANDBOX_CALLBACK_TTL_SECONDS,
  verifySandboxCallbackToken,
} from './sandbox-callback.token';

const ORG = '0b4f7b7e-1a37-4b8e-9c3d-0f3b8a4d2a11';
const PROJECT = '9c2a3c3e-5f6d-4a1b-8e2f-7d6c5b4a3f21';
const SANDBOX = 'dtn-sandbox-1';
const OTHER_PROJECT = '1c2a3c3e-5f6d-4a1b-8e2f-7d6c5b4a3f22';

function keyPair(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    jwk: {
      ...(publicKey.export({ format: 'jwk' }) as { crv: 'Ed25519'; kty: 'OKP'; x: string }),
      alg: 'EdDSA' as const,
      kid,
      use: 'sig' as const,
    },
    signingKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}
const primary = keyPair('k-test');
const stranger = keyPair('k-stranger');
const jwks: PreviewJwks = { keys: [primary.jwk] };
const mint = createSandboxCallbackSigner({
  signingKey: primary.signingKey,
  signingKeyId: 'k-test',
});
const strangerMint = createSandboxCallbackSigner({
  signingKey: stranger.signingKey,
  signingKeyId: 'k-stranger',
});

const CLAIMS = { leaseEpoch: SANDBOX_LEASE_EPOCH, org: ORG, project: PROJECT, sandbox: SANDBOX };

/** `INCR` / `EXPIRE` as the guard drives them, with a clock so the window's end is observable. */
function fakeRedis(options: { broken?: boolean } = {}) {
  const counters = new Map<string, number>();
  const expiresAt = new Map<string, number>();
  const clock = { now: 0 };
  const redis = {
    expire: (key: string, ttl: number) => {
      expiresAt.set(key, clock.now + ttl);
      return Promise.resolve(1);
    },
    incr: (key: string) => {
      if (options.broken) return Promise.reject(new Error('ECONNREFUSED'));
      const expiry = expiresAt.get(key);
      if (expiry !== undefined && expiry <= clock.now) {
        counters.delete(key);
        expiresAt.delete(key);
      }
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return Promise.resolve(next);
    },
  };
  return { clock, counters, expiresAt, redis: redis as unknown as Redis };
}

function build(
  world: {
    broken?: boolean;
    row?: { daytonaId: string; lostAt: Date | null } | undefined;
  } = {},
) {
  const { clock, counters, expiresAt, redis } = fakeRedis({ broken: world.broken });
  const record = vi.fn(() => Promise.resolve());
  const opened: string[] = [];
  // The fake `where` is blind to its predicate: `table.rows` is whatever the next read answers.
  const rows =
    'row' in world
      ? world.row === undefined
        ? []
        : [world.row]
      : [{ daytonaId: SANDBOX, lostAt: null }];
  const table = { rows };
  const transactions = {
    runInTenantTransaction: async (
      orgId: string,
      fn: (tx: { select: unknown }) => Promise<unknown>,
    ) => {
      opened.push(orgId);
      return fn({
        select: () => ({ from: () => ({ where: () => ({ limit: () => table.rows }) }) }),
      });
    },
  } as unknown as TenantTransactionRunner;
  const config = { get: () => jwks } as unknown as ConfigService<Environment, true>;
  const guard = new SandboxCallbackGuard(
    redis,
    transactions,
    { record } as unknown as AuditService,
    config,
  );
  return { clock, counters, expiresAt, guard, opened, record, table };
}

function contextWith(token: string | undefined) {
  const request: Record<PropertyKey, unknown> = {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

describe('sandbox callback token', () => {
  it('mints the audience, the sandbox identity and a 12 h life', async () => {
    const claims = decodeJwt(await mint(CLAIMS));

    expect(claims).toMatchObject({ aud: 'forge-sandbox-callback', ...CLAIMS });
    expect(claims.exp! - claims.iat!).toBe(SANDBOX_CALLBACK_TTL_SECONDS);
    expect(SANDBOX_CALLBACK_TTL_SECONDS).toBe(12 * 60 * 60);
  });

  it('refuses a token minted without exp', async () => {
    const eternal = await new SignJWT({ ...CLAIMS, aud: 'forge-sandbox-callback' })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'k-test' })
      .setIssuedAt()
      .sign(
        createPrivateKey({
          format: 'der',
          key: Buffer.from(primary.signingKey, 'base64'),
          type: 'pkcs8',
        }),
      );

    await expect(verifySandboxCallbackToken(eternal, jwks)).rejects.toMatchObject({
      code: 'ERR_JWT_CLAIM_VALIDATION_FAILED',
    });
  });

  it('verifies against the JWKS and refuses another key or another audience', async () => {
    await expect(verifySandboxCallbackToken(await mint(CLAIMS), jwks)).resolves.toMatchObject(
      CLAIMS,
    );
    await expect(
      verifySandboxCallbackToken(await strangerMint(CLAIMS), jwks),
    ).rejects.toMatchObject({
      code: 'ERR_JWKS_NO_MATCHING_KEY',
    });
  });
});

describe('SandboxCallbackGuard', () => {
  it('admits a live sandbox, opens the tenant tx for the token org and attaches the claims', async () => {
    const { guard, opened, record } = build();
    const { context, request } = contextWith(await mint(CLAIMS));

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(opened).toEqual([ORG]);
    expect(request[SANDBOX_CALLBACK]).toMatchObject(CLAIMS);
    expect(record).not.toHaveBeenCalled();
  });

  it('refuses a missing token and one under a key the JWKS does not carry', async () => {
    const { guard, opened } = build();

    await expect(guard.canActivate(contextWith(undefined).context)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(
      guard.canActivate(contextWith(await strangerMint(CLAIMS)).context),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(opened).toEqual([]); // nothing verified, nothing read
  });

  it.each([
    [
      'a lost sandbox',
      { daytonaId: SANDBOX, lostAt: new Date('2026-09-18T00:00:00Z') },
      CLAIMS,
      'sandbox-lost',
    ],
    [
      'a daytonaId mismatch',
      { daytonaId: 'dtn-replacement', lostAt: null },
      CLAIMS,
      'sandbox-mismatch',
    ],
    ['no row at all', undefined, CLAIMS, 'sandbox-mismatch'],
    [
      'a stale lease epoch',
      { daytonaId: SANDBOX, lostAt: null },
      { ...CLAIMS, leaseEpoch: SANDBOX_LEASE_EPOCH - 1 },
      'stale-epoch',
    ],
  ])('refuses %s on the re-read of the row and audits it', async (_name, row, claims, because) => {
    const { counters, guard, record } = build({ row });
    const token = await mint(claims);

    // One body for every refusal: the reason lives in the audit row, never the response.
    await expect(guard.canActivate(contextWith(token).context)).rejects.toMatchObject({
      extensions: {},
      status: 403,
    });
    expect(record).toHaveBeenCalledWith(expect.anything(), {
      action: 'sandbox-callback.refused',
      actorId: null,
      metadata: { because, sandbox: SANDBOX },
      orgId: ORG,
      target: PROJECT,
    });
    // The counter moved first: the signature already proved a platform-minted caller, and a flood
    // from a lost sandbox is a flood on Redis, never on the database.
    expect(counters.get(callbackRateKey(SANDBOX))).toBe(1);
  });

  it('counts per daytonaId under pv:cb:<id> with a 60 s window and refuses above the limit without touching another sandbox', async () => {
    const { clock, counters, expiresAt, guard, table } = build();
    const mine = await mint(CLAIMS);
    const other = await mint({ ...CLAIMS, project: OTHER_PROJECT, sandbox: 'dtn-other' });
    expect(CALLBACK_RATE_WINDOW_SECONDS).toBe(60);

    for (let call = 0; call < CALLBACK_RATE_LIMIT; call += 1) {
      await expect(guard.canActivate(contextWith(mine).context)).resolves.toBe(true);
    }
    await expect(guard.canActivate(contextWith(mine).context)).rejects.toBeInstanceOf(
      RateLimitedError,
    );

    expect(counters.get(callbackRateKey(SANDBOX))).toBe(CALLBACK_RATE_LIMIT + 1);
    expect(expiresAt.get(callbackRateKey(SANDBOX))).toBe(CALLBACK_RATE_WINDOW_SECONDS);
    table.rows = [{ daytonaId: 'dtn-other', lostAt: null }];
    await expect(guard.canActivate(contextWith(other).context)).resolves.toBe(true);
    expect(counters.get(callbackRateKey('dtn-other'))).toBe(1);
    table.rows = [{ daytonaId: SANDBOX, lostAt: null }];

    // A fixed window: refused calls do not push its end out, and once it closes the sandbox is
    // admitted again.
    await expect(guard.canActivate(contextWith(mine).context)).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    expect(expiresAt.get(callbackRateKey(SANDBOX))).toBe(CALLBACK_RATE_WINDOW_SECONDS);
    clock.now = CALLBACK_RATE_WINDOW_SECONDS;
    await expect(guard.canActivate(contextWith(mine).context)).resolves.toBe(true);
    expect(counters.get(callbackRateKey(SANDBOX))).toBe(1);
  });

  it('fails closed when Redis is unavailable, before the row is read', async () => {
    const { guard, opened } = build({ broken: true });

    await expect(guard.canActivate(contextWith(await mint(CLAIMS)).context)).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    expect(opened).toEqual([]);
  });

  it('refuses above the limit without opening a tenant transaction', async () => {
    const { counters, guard, opened } = build();
    counters.set(callbackRateKey(SANDBOX), CALLBACK_RATE_LIMIT);

    await expect(guard.canActivate(contextWith(await mint(CLAIMS)).context)).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    expect(opened).toEqual([]);
  });
});
