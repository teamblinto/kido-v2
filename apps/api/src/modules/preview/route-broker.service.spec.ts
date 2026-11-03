import { generateKeyPairSync } from 'node:crypto';

import type { PreviewVisibility } from '@repo/contracts';
import type { Sandbox } from '@repo/db';
import { decodeJwt } from 'jose';
import { describe, expect, it, vi } from 'vitest';

import type { PreviewJwks } from '../../config/environment';
import type { ForgeDatabase } from '../../database/database.types';
import type { TenantTransactionRunner } from '../../database/tenant-transaction';
import type { DaytonaAdapter } from '../sandbox/daytona.adapter';
import type { SandboxLifecycle } from '../sandbox/sandbox-lifecycle';
import type { TemplateCatalogue } from '../sandbox/template-catalogue';
import { RouteBrokerService } from './route-broker.service';
import { createRouteSigner, ROUTE_TTL_SECONDS } from './route-signer';

const LABEL = '8f14e45fceea167a5a36dedd4bea2543';
const ORG = '0b4f7b7e-1a37-4b8e-9c3d-0f3b8a4d2a11';
const PROJECT = '9c2a3c3e-5f6d-4a1b-8e2f-7d6c5b4a3f21';

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

const project = {
  deletedAt: null,
  id: PROJECT,
  orgId: ORG,
  previewLabel: LABEL,
  previewVisibility: 'private' as PreviewVisibility,
  template: 'vite-react' as string | null,
};

const sandbox = (row: Partial<Sandbox> = {}): Partial<Sandbox> => ({
  daytonaId: 'dtn-sandbox-1',
  lostAt: null,
  orgId: ORG,
  projectId: PROJECT,
  state: 'active',
  transition: null,
  workspaceRoot: '/home/daytona',
  ...row,
});

/**
 * The reads are stubbed at the shape the service issues them — the label probe on the bypass
 * handle, `projects` and `sandboxes` through the relational API under a tenant transaction — so every case
 * is about the ladder, the binding and the signature rather than the wire.
 */
function broker(world: {
  projects?: Record<string, typeof project | undefined>;
  sandboxes?: Partial<Sandbox> | undefined;
  devPort?: string | undefined;
}) {
  const byOrg = world.projects ?? { [ORG]: project };
  const opened: string[] = [];
  const probes: string[] = [];
  // The one bypass read: `select org_id from projects where preview_label = ? and deleted_at is null limit 1`.
  const bypass = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => {
            probes.push('projects_preview_label_key');
            const owner = Object.entries(byOrg).find(([, row]) => row !== undefined)?.[0];
            return Promise.resolve(owner === undefined ? [] : [{ orgId: owner }]);
          },
        }),
      }),
    }),
  } as unknown as ForgeDatabase;
  const transactions = {
    runInTenantTransaction: async (orgId: string, fn: (tx: unknown) => Promise<unknown>) => {
      opened.push(orgId);
      return fn({
        query: {
          projects: { findFirst: () => Promise.resolve(byOrg[orgId]) },
          sandboxes: { findFirst: () => Promise.resolve(world.sandboxes) },
        },
      });
    },
  } as unknown as TenantTransactionRunner;
  const catalogue = {
    get: (id: string) => ({ id, manifest: { devPort: world.devPort } }),
  } as unknown as TemplateCatalogue;
  const previewOrigin = vi.fn((daytonaId: string, port: number) =>
    Promise.resolve({
      upstream: `https://${String(port)}-token.proxy.example`,
      upstreamToken: `tok-${daytonaId}-${String(port)}`,
    }),
  );
  const daytona = { previewOrigin } as unknown as DaytonaAdapter;
  // The lifecycle's guard, not a mock of the wire: one resume op is appended while the row's
  // `transition is null`, and every call after that answers `resuming` without appending.
  const row = world.sandboxes;
  const resumes: string[] = [];
  const ensureReady = vi.fn(
    (_tx: unknown, _ref: unknown, ctx: { leaseEpoch: number; operationId: string }) => {
      if (row?.transition === null) {
        (row as { transition: Sandbox['transition'] }).transition = 'resuming';
        resumes.push(ctx.operationId);
      }
      return Promise.resolve({ because: 'resuming' as const, ready: false as const });
    },
  );
  const lifecycle = { ensureReady } as unknown as SandboxLifecycle;

  return {
    ensureReady,
    opened,
    previewOrigin,
    probes,
    resumes,
    service: new RouteBrokerService(bypass, transactions, catalogue, daytona, signer, lifecycle),
  };
}

describe('RouteBrokerService', () => {
  it('resolves a label to a signed route that verifies and carries the record the gateway expects', async () => {
    const { service, previewOrigin, opened, probes } = broker({
      devPort: '5173',
      sandboxes: sandbox(),
    });

    const answer = await service.resolve(LABEL);

    expect(answer.kind).toBe('route');
    const jws = answer.kind === 'route' ? answer.route : '';
    await expect(signer.verify(jws)).resolves.toMatchObject({
      label: LABEL,
      org: ORG,
      ports: [5173],
      project: PROJECT,
      sandbox: 'dtn-sandbox-1',
      state: 'active',
      upstream: 'https://5173-token.proxy.example',
      upstreamToken: 'tok-dtn-sandbox-1-5173',
      visibility: 'private',
    });
    const claims = decodeJwt(jws);
    expect(claims.exp).toBe((claims.iat ?? 0) + ROUTE_TTL_SECONDS);
    // The upstream token is asked for the route's own life, on the row's provider identity.
    expect(previewOrigin).toHaveBeenCalledWith('dtn-sandbox-1', 5173, ROUTE_TTL_SECONDS);
    // One bypass probe of the label index, then exactly one tenant transaction, the owner's.
    expect(probes).toEqual(['projects_preview_label_key']);
    expect(opened).toEqual([ORG]);
  });

  it('carries the visibility through unchanged and the idle state as idle', async () => {
    const { service } = broker({
      devPort: '5173',
      projects: { [ORG]: { ...project, previewVisibility: 'public' } },
      sandboxes: sandbox({ state: 'idle' }),
    });

    const answer = await service.resolve(LABEL);
    await expect(signer.verify(answer.kind === 'route' ? answer.route : '')).resolves.toMatchObject(
      { state: 'idle', visibility: 'public' },
    );
  });

  it('binds the route to the sandbox row the project has now, not a replaced one', async () => {
    const { service, previewOrigin } = broker({
      devPort: '3000',
      sandboxes: sandbox({ daytonaId: 'dtn-sandbox-2' }),
    });

    const answer = await service.resolve(LABEL);
    await expect(signer.verify(answer.kind === 'route' ? answer.route : '')).resolves.toMatchObject(
      { ports: [3000], sandbox: 'dtn-sandbox-2' },
    );
    expect(previewOrigin).toHaveBeenCalledWith('dtn-sandbox-2', 3000, ROUTE_TTL_SECONDS);
  });

  it('wakes a hibernated sandbox through ensureReady with the epoch-0 preview operation and answers resuming', async () => {
    const { service, ensureReady, previewOrigin, opened } = broker({
      devPort: '5173',
      projects: { [ORG]: { ...project, previewVisibility: 'public' } },
      sandboxes: sandbox({ state: 'hibernated' }),
    });

    await expect(service.resolve(LABEL)).resolves.toEqual({
      because: 'resuming',
      kind: 'refused',
    });
    expect(ensureReady).toHaveBeenCalledTimes(1);
    expect(ensureReady).toHaveBeenCalledWith(
      expect.anything(),
      { orgId: ORG, projectId: PROJECT },
      { leaseEpoch: 0, operationId: `preview/${LABEL}` },
    );
    // The wake runs under the owner's tenant transaction; no upstream is dialled for it.
    expect(opened).toEqual([ORG, ORG]);
    expect(previewOrigin).not.toHaveBeenCalled();
  });

  describe('gates the wake of a cold non-public preview on a grant', () => {
    const host = `${LABEL}-5173.preview.example`;
    const cold = () => broker({ devPort: '5173', sandboxes: sandbox({ state: 'hibernated' }) });

    it('refuses unauthorised and wakes nothing without a grant, with one for another host, or a forged one', async () => {
      const otherLabel = LABEL.replace('8f', '00');
      for (const caller of [
        {},
        { host },
        {
          grant: await signer.signGrant({ aud: `${otherLabel}-5173.preview.example`, sub: 'u1' }),
          host,
        },
        {
          grant: await signer.signGrant({ aud: host, sub: 'u1' }),
          host: `${otherLabel}-5173.preview.example`,
        },
        { grant: 'not.a.jws', host },
      ]) {
        const { service, ensureReady } = cold();
        await expect(service.resolve(LABEL, caller)).resolves.toEqual({
          because: 'unauthorised',
          kind: 'refused',
        });
        expect(ensureReady).not.toHaveBeenCalled();
      }
    });

    it('wakes once for a grant that verifies for the label’s own host', async () => {
      const { service, ensureReady } = cold();
      const grant = await signer.signGrant({ aud: host, sub: 'u1' });

      await expect(service.resolve(LABEL, { grant, host })).resolves.toEqual({
        because: 'resuming',
        kind: 'refused',
      });
      expect(ensureReady).toHaveBeenCalledTimes(1);
    });

    it('wakes a public preview without any grant', async () => {
      const { service, ensureReady } = broker({
        devPort: '5173',
        projects: { [ORG]: { ...project, previewVisibility: 'public' } },
        sandboxes: sandbox({ state: 'hibernated' }),
      });

      await expect(service.resolve(LABEL)).resolves.toEqual({
        because: 'resuming',
        kind: 'refused',
      });
      expect(ensureReady).toHaveBeenCalledTimes(1);
    });

    it('keeps answering resuming for a row already mid-resume, grant or not', async () => {
      const { service, ensureReady } = broker({
        devPort: '5173',
        sandboxes: sandbox({ state: 'hibernated', transition: 'resuming' }),
      });

      await expect(service.resolve(LABEL)).resolves.toEqual({
        because: 'resuming',
        kind: 'refused',
      });
      expect(ensureReady).not.toHaveBeenCalled();
    });
  });

  it('answers resuming for a row already mid-resume without calling ensureReady again', async () => {
    const { service, ensureReady } = broker({
      devPort: '5173',
      sandboxes: sandbox({ state: 'hibernated', transition: 'resuming' }),
    });

    await expect(service.resolve(LABEL)).resolves.toEqual({
      because: 'resuming',
      kind: 'refused',
    });
    expect(ensureReady).not.toHaveBeenCalled();
  });

  it('enqueues one resume under concurrent resolves: the transition guard, not the broker, dedupes', async () => {
    const { service, ensureReady, resumes } = broker({
      devPort: '5173',
      projects: { [ORG]: { ...project, previewVisibility: 'public' } },
      sandboxes: sandbox({ state: 'hibernated' }),
    });

    const answers = await Promise.all([service.resolve(LABEL), service.resolve(LABEL)]);

    // Both callers see the waking page; only one `preview/<label>` resume op was appended (the
    // fake's shared row stands in for the first call's committed flip, so the second read the row
    // mid-resume), and `SandboxOpsConsumer.jobId` (`${sandboxId}.resume`) collapses any
    // duplicate the outbox relays.
    expect(answers.map((answer) => answer.kind === 'refused' && answer.because)).toEqual([
      'resuming',
      'resuming',
    ]);
    expect(ensureReady).toHaveBeenCalledTimes(1);
    expect(resumes).toEqual([`preview/${LABEL}`]);
  });

  it.each([
    ['archived', sandbox({ state: 'archived' })],
    ['pooled', sandbox({ state: 'pooled' })],
    ['mid-transition', sandbox({ transition: 'hibernating' })],
    ['lost while marked resuming', sandbox({ lostAt: new Date(), transition: 'resuming' })],
    ['lost', sandbox({ lostAt: new Date() })],
    ['not yet started', sandbox({ workspaceRoot: null })],
  ])('refuses a %s sandbox as unroutable, never wakes it and dials nothing', async (_name, row) => {
    const { service, ensureReady, previewOrigin } = broker({ devPort: '5173', sandboxes: row });

    // The state is named internally only; the listener answers `404 {}` for every refusal.
    await expect(service.resolve(LABEL)).resolves.toEqual({
      because: 'unroutable',
      kind: 'refused',
    });
    expect(ensureReady).not.toHaveBeenCalled();
    expect(previewOrigin).not.toHaveBeenCalled();
  });

  it('refuses a project that never ran as never-run, internally', async () => {
    const { service } = broker({ devPort: '5173', sandboxes: undefined });

    await expect(service.resolve(LABEL)).resolves.toEqual({
      because: 'never-run',
      kind: 'refused',
    });
  });

  it('refuses a label no live org holds, and a label of the wrong shape without a read', async () => {
    const { service, opened, probes } = broker({
      devPort: '5173',
      projects: {},
      sandboxes: sandbox(),
    });

    await expect(service.resolve(LABEL)).resolves.toEqual({
      because: 'unknown-label',
      kind: 'refused',
    });
    // The probe missed, so no tenant transaction was opened at all.
    expect(probes).toEqual(['projects_preview_label_key']);
    expect(opened).toEqual([]);

    await expect(service.resolve('NOT-A-LABEL')).resolves.toEqual({
      because: 'unknown-label',
      kind: 'refused',
    });
    expect(probes).toHaveLength(1);
  });

  it.each([
    ['declares no devPort', 'vite-react', undefined],
    ['is unset on the project', null, '5173'],
  ])('refuses as no-port when the template %s', async (_name, template, devPort) => {
    const { service, previewOrigin } = broker({
      devPort,
      projects: { [ORG]: { ...project, template } },
      sandboxes: sandbox(),
    });

    await expect(service.resolve(LABEL)).resolves.toEqual({ because: 'no-port', kind: 'refused' });
    expect(previewOrigin).not.toHaveBeenCalled();
  });
});
