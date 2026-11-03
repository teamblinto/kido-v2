import { generateKeyPairSync } from 'node:crypto';

import type { Redis } from 'ioredis';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { describe, expect, it, vi } from 'vitest';

import type { PreviewJwks } from '../../config/environment';
import type { TenantTransactionRunner } from '../../database/tenant-transaction';
import type { AuditService } from '../audit/audit.service';
import type { PermissionResolutionService } from '../rbac/permission-resolution.service';
import { scoped } from '../rbac/permissions';
import { CODE_TTL_SECONDS, codeKey, GrantService } from './grant.service';
import { GRANT_TTL_SECONDS, revokedLabelKey } from './preview.constants';
import type { RouteBrokerService } from './route-broker.service';
import { createRouteSigner, verifyRoute } from './route-signer';

const LABEL = '8f14e45fceea167a5a36dedd4bea2543';
const ORG = '0b4f7b7e-1a37-4b8e-9c3d-0f3b8a4d2a11';
const PROJECT = '9c2a3c3e-5f6d-4a1b-8e2f-7d6c5b4a3f21';
const USER = '5d2f1c0a-7b3e-4c9d-8a1f-2e3b4c5d6e7f';
const DOMAIN = 'preview.example.test';
const HOST = `${LABEL}-5173.${DOMAIN}`;

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const jwks: PreviewJwks = {
  keys: [
    {
      ...(publicKey.export({ format: 'jwk' }) as { crv: 'Ed25519'; kty: 'OKP'; x: string }),
      alg: 'EdDSA',
      kid: 'k-test',
      use: 'sig',
    },
  ],
};
const signer = createRouteSigner({
  jwks,
  signingKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  signingKeyId: 'k-test',
});

/**
 * The session Redis as the service uses it: `SET … EX`, `GETDEL`, `EXISTS`. A map with TTLs
 * recorded, so single-use and expiry are observable without a real server.
 */
function fakeRedis() {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();
  const redis = {
    exists: vi.fn((key: string) => Promise.resolve(store.has(key) ? 1 : 0)),
    getdel: vi.fn((key: string) => {
      const value = store.get(key) ?? null;
      store.delete(key);
      return Promise.resolve(value);
    }),
    set: vi.fn((key: string, value: string, _ex: 'EX', ttl: number) => {
      store.set(key, value);
      ttls.set(key, ttl);
      return Promise.resolve('OK');
    }),
  };
  return { redis: redis as unknown as Redis, store, ttls };
}

function build(
  world: {
    member?: boolean;
    located?: boolean;
    /** What the resolved permission set holds; defaults to `project:read` on the project. */
    held?: string[];
    visibility?: 'org' | 'private' | 'public';
  } = {},
) {
  const { redis, store, ttls } = fakeRedis();
  const record = vi.fn(() => Promise.resolve());
  const opened: string[] = [];
  const membershipRows = world.member === false ? [] : [{ id: 'm-1' }];
  const resolved = vi.fn(() =>
    Promise.resolve(new Set(world.held ?? [scoped('project:read', PROJECT)])),
  );
  const permissions = { for: resolved } as unknown as PermissionResolutionService;
  const transactions = {
    runInTenantTransaction: async (orgId: string, fn: (tx: unknown) => Promise<unknown>) => {
      opened.push(orgId);
      return fn({
        select: () => ({ from: () => ({ where: () => ({ limit: () => membershipRows }) }) }),
      });
    },
  } as unknown as TenantTransactionRunner;
  const locate = vi.fn((label: string) =>
    Promise.resolve(
      world.located === false || label !== LABEL
        ? undefined
        : {
            project: {
              id: PROJECT,
              orgId: ORG,
              previewLabel: LABEL,
              previewVisibility: world.visibility ?? 'private',
            },
            sandbox: undefined,
          },
    ),
  );
  const service = new GrantService(
    redis,
    transactions,
    { locate } as unknown as RouteBrokerService,
    { record } as unknown as AuditService,
    permissions,
    signer,
    DOMAIN,
  );
  return { locate, opened, record, resolved, service, store, ttls };
}

describe('GrantService', () => {
  describe('issueCode', () => {
    it('stores the code under its digest, never the code itself, for 60 seconds', async () => {
      const { service, store, ttls } = build();

      const code = await service.issueCode({ label: LABEL, returnHost: HOST, userId: USER });

      expect(code).toEqual(expect.any(String));
      const [key] = [...store.keys()];
      // `<id>.<nonce>`: the id's digest is the key; the nonce lives only in the record.
      const [id, nonce] = code!.split('.');
      expect(key).toBe(codeKey(id!));
      expect(key).not.toContain(id);
      expect(ttls.get(key!)).toBe(CODE_TTL_SECONDS);
      expect(CODE_TTL_SECONDS).toBe(60);
      expect(JSON.parse(store.get(key!)!)).toMatchObject({
        label: LABEL,
        nonce,
        org: ORG,
        returnHost: HOST,
        userId: USER,
      });
    });

    it('takes an authority with a port, and binds the record to the bare hostname the gateway redeems with', async () => {
      const { service, store } = build();

      const code = await service.issueCode({
        label: LABEL,
        returnHost: `${HOST}:3200`,
        userId: USER,
      });

      expect(JSON.parse([...store.values()][0]!)).toMatchObject({ returnHost: HOST });
      await expect(service.redeem(code!, HOST)).resolves.toEqual(expect.any(String));
    });

    it('refuses a non-member, an unknown label and a return host off the preview domain identically', async () => {
      const { record, service: nonMember, store } = build({ member: false });
      await expect(
        nonMember.issueCode({ label: LABEL, returnHost: HOST, userId: USER }),
      ).resolves.toBeUndefined();
      expect(store.size).toBe(0);
      expect(record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'preview-grant.refused', actorId: USER, orgId: ORG }),
      );

      const unknown = build({ located: false });
      await expect(
        unknown.service.issueCode({ label: LABEL, returnHost: HOST, userId: USER }),
      ).resolves.toBeUndefined();
      expect(unknown.opened).toEqual([]);

      const { locate, service } = build();
      for (const returnHost of [
        `${LABEL}-5173.evil.example`,
        `${LABEL}-5173.${DOMAIN}.evil.example`,
        `${'b'.repeat(32)}-5173.${DOMAIN}`, // another label's host
        `${LABEL}.${DOMAIN}`, // no port
        `${LABEL}-80.${DOMAIN}`, // port below 1024
      ]) {
        await expect(service.issueCode({ label: LABEL, returnHost, userId: USER })).resolves.toBe(
          undefined,
        );
      }
      // The host grammar is checked before any read, so a bad host is not a probe of the label.
      expect(locate).not.toHaveBeenCalled();
    });

    it('admits an org member without project access on an org preview, and refuses them on a private one', async () => {
      const other = scoped('project:read', '11111111-2222-4333-8444-555555555555');

      const org = build({ held: [other], visibility: 'org' });
      await expect(
        org.service.issueCode({ label: LABEL, returnHost: HOST, userId: USER }),
      ).resolves.toEqual(expect.any(String));
      expect(org.resolved).not.toHaveBeenCalled();

      const closed = build({ held: [other], visibility: 'private' });
      await expect(
        closed.service.issueCode({ label: LABEL, returnHost: HOST, userId: USER }),
      ).resolves.toBeUndefined();
      expect(closed.resolved).toHaveBeenCalledWith(ORG, USER);
      expect(closed.store.size).toBe(0);
      expect(closed.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'preview-grant.refused',
          metadata: { because: 'no-project-access' },
        }),
      );

      const reader = build({ visibility: 'private' });
      await expect(
        reader.service.issueCode({ label: LABEL, returnHost: HOST, userId: USER }),
      ).resolves.toEqual(expect.any(String));
    });
  });

  describe('redeem', () => {
    it('mints a grant for the user with the preview host as audience, and only once', async () => {
      const { record, service } = build();
      const code = (await service.issueCode({ label: LABEL, returnHost: HOST, userId: USER }))!;

      const grant = await service.redeem(code, HOST);

      expect(grant).toEqual(expect.any(String));
      expect(decodeProtectedHeader(grant!)).toEqual({ alg: 'EdDSA', kid: 'k-test' });
      const claims = decodeJwt(grant!);
      expect(claims).toMatchObject({ aud: HOST, sub: USER });
      expect(claims.exp! - claims.iat!).toBe(GRANT_TTL_SECONDS);
      expect(GRANT_TTL_SECONDS).toBe(600);
      // A grant is not a route: the route verifier refuses it on shape, not on signature.
      await expect(verifyRoute(grant!, jwks)).rejects.toMatchObject({ code: 'ERR_ROUTE_SHAPE' });
      expect(record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'preview-grant.issued',
          actorId: USER,
          orgId: ORG,
          target: PROJECT,
        }),
      );

      // Single-use: GETDEL took it, the second redemption finds nothing.
      await expect(service.redeem(code, HOST)).resolves.toBeUndefined();
    });

    it('refuses a code presented from another host, and spends it', async () => {
      const { record, service } = build();
      const code = (await service.issueCode({ label: LABEL, returnHost: HOST, userId: USER }))!;

      await expect(service.redeem(code, `${LABEL}-3000.${DOMAIN}`)).resolves.toBeUndefined();
      await expect(service.redeem(code, HOST)).resolves.toBeUndefined();
      expect(record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'preview-grant.refused', orgId: ORG }),
      );
    });

    it('refuses a code whose nonce does not match the record it names', async () => {
      const { service } = build();
      const code = (await service.issueCode({ label: LABEL, returnHost: HOST, userId: USER }))!;
      const [id, nonce] = code.split('.');
      const tampered = `${id!}.${nonce!.slice(0, -1)}${nonce!.endsWith('0') ? '1' : '0'}`;

      await expect(service.redeem(tampered, HOST)).resolves.toBeUndefined();
      // The mismatch spent the record, exactly as a wrong host does.
      await expect(service.redeem(code, HOST)).resolves.toBeUndefined();
    });

    it('refuses an unknown, malformed or expired code, or a corrupt record, without a grant', async () => {
      const { record, service, store } = build();
      const code = (await service.issueCode({ label: LABEL, returnHost: HOST, userId: USER }))!;
      store.set(codeKey(code.split('.')[0]!), '{not json');
      await expect(service.redeem(code, HOST)).resolves.toBeUndefined();

      await expect(service.redeem('never-issued', HOST)).resolves.toBeUndefined();
      await expect(service.redeem('', HOST)).resolves.toBeUndefined();
      await expect(service.redeem('a.b.c', HOST)).resolves.toBeUndefined();
      expect(record).not.toHaveBeenCalled();
    });

    it('consults the revoked-label marker at mint and refuses a rotated-away label', async () => {
      const { service, store } = build();
      const code = (await service.issueCode({ label: LABEL, returnHost: HOST, userId: USER }))!;
      store.set(revokedLabelKey(LABEL), '1');

      await expect(service.redeem(code, HOST)).resolves.toBeUndefined();
    });
  });
});
