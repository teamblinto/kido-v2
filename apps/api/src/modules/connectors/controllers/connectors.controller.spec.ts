import { connectionListSchema, connectionSchema } from '@repo/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { TenantContext } from '../../../database/tenant-context';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import {
  OauthProviderNotConfiguredError,
  OauthStateError,
} from '../../identity/services/oauth.service';
import { REQUIRES_STEP_UP } from '../../identity/decorators/step-up.decorator';
import { REQUIRED_PERMISSION } from '../../rbac/decorators/require-permission.decorator';
import { ORG_ROLE_PERMISSIONS } from '../../rbac/permissions';
import type { ConnectionRecord } from '../connection.repository';
import { ConnectionService } from '../connection.service';
import { OperationService } from '../operation.service';
import { ConnectorsController } from './connectors.controller';

const ORG = '11111111-1111-4111-8111-111111111111';
const ID = '33333333-3333-4333-8333-333333333333';
const USER = '66666666-6666-4666-8666-666666666666';
const TOKEN = 'ghs_0123456789abcdef0123456789abcdef01234567';
const TX = { tag: 'tx' } as unknown as TenantContext['tx'];
const CALLER = { userId: USER } as AuthenticatedUser;

const record: ConnectionRecord = {
  accountId: 9001,
  accountLogin: 'acme',
  accountRef: null,
  accountType: 'organization',
  authType: 'app_installation',
  circuitOpenUntil: null,
  connectedBy: USER,
  connectedByName: 'owner@example.test',
  createdAt: new Date('2026-09-20T10:00:00.000Z'),
  credentialFingerprint: 'sha256:0c86cb5464bdd26117552b7435cd1df3',
  failedResources: [],
  failureCount: 0,
  grantedScopes: [],
  health: 'healthy',
  id: ID,
  installationId: 7001,
  lastVerifiedAt: new Date('2026-09-20T10:00:00.000Z'),
  orgId: ORG,
  provider: 'github',
  removalRequestedAt: null,
  secretId: '44444444-4444-4444-8444-444444444444',
  tokenExpiresAt: new Date('2026-09-20T11:00:00.000Z'),
  updatedAt: new Date('2026-09-20T10:00:00.000Z'),
};

/** The real `toContract`, the rest stubbed: the mapping is what SC-002 is about. */
function build(overrides: Partial<ConnectionService>) {
  const service = {
    toContract: (row: ConnectionRecord) =>
      ConnectionService.prototype.toContract.call(undefined, row),
    ...overrides,
  } as unknown as ConnectionService;

  const operations = {
    toContract: (row: never) => OperationService.prototype.toContract.call(undefined, row),
  } as unknown as OperationService;

  return new ConnectorsController({ tx: TX } as TenantContext, service, operations);
}

function permissionOf(handler: string): string {
  const target = Object.getOwnPropertyDescriptor(ConnectorsController.prototype, handler)!
    .value as object;

  return (Reflect.getMetadata(REQUIRED_PERMISSION, target) as { permission: string }).permission;
}

describe('ConnectorsController', () => {
  it('lists connections as contract rows: a member sees the connection and no token (SC-002)', async () => {
    const list = vi.fn().mockResolvedValue([record]);
    const body = await build({ list }).list(ORG);

    expect(list).toHaveBeenCalledWith(TX, ORG);
    expect(connectionListSchema.parse(body)).toEqual(body);
    expect(body.connections[0]).toMatchObject({
      account: { id: 9001, login: 'acme', type: 'organization' },
      canCreateRepositories: true,
      connectedBy: { id: USER, name: 'owner@example.test' },
      credentialFingerprint: 'sha256:0c86cb5464bdd26117552b7435cd1df3',
      id: ID,
    });

    const json = JSON.stringify(body);

    expect(json).not.toContain(TOKEN);
    expect(json).not.toContain('secretId');
    expect(permissionOf('list')).toBe('org:connectors.read');
    expect(ORG_ROLE_PERMISSIONS.member).toContain('org:connectors.read');
  });

  it('demands org:connectors.manage of install, complete, remove and verify — a member has none of it (permission-denied)', () => {
    for (const handler of ['install', 'complete', 'remove', 'verify'] as const) {
      expect(permissionOf(handler)).toBe('org:connectors.manage');
    }
    expect(ORG_ROLE_PERMISSIONS.member).not.toContain('org:connectors.manage');
  });

  it('install answers the service’s URL, or oauth-provider-not-configured untouched', async () => {
    const beginInstall = vi.fn().mockResolvedValue({ installUrl: 'https://github.com/apps/x' });

    await expect(build({ beginInstall }).install(CALLER, ORG)).resolves.toEqual({
      installUrl: 'https://github.com/apps/x',
    });
    expect(beginInstall).toHaveBeenCalledWith(ORG, USER);

    const refused = vi.fn().mockRejectedValue(new OauthProviderNotConfiguredError('github'));

    await expect(build({ beginInstall: refused }).install(CALLER, ORG)).rejects.toMatchObject({
      status: 501,
      type: 'oauth-provider-not-configured',
    });
  });

  it('complete answers the connected row as its contract shape', async () => {
    const completeInstall = vi.fn().mockResolvedValue({ id: ID });
    const byId = vi.fn().mockResolvedValue(record);
    const body = await build({ byId, completeInstall }).complete(CALLER, ORG, {
      installationId: 7001,
      state: 's',
    });

    expect(completeInstall).toHaveBeenCalledWith(TX, ORG, USER, {
      installationId: 7001,
      state: 's',
    });
    expect(connectionSchema.parse(body)).toEqual(body);
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it('complete with a reused state is oauth-state-invalid', async () => {
    const completeInstall = vi.fn().mockRejectedValue(new OauthStateError());

    await expect(
      build({ completeInstall }).complete(CALLER, ORG, { installationId: 7001, state: 'spent' }),
    ).rejects.toMatchObject({ status: 400, type: 'oauth-state-invalid' });
  });

  it('remove requests the removal as the caller and answers the queued connection_remove operation', async () => {
    const created = new Date('2026-09-23T10:00:00.000Z');
    const requestRemoval = vi.fn().mockResolvedValue({
      bindingId: null,
      createdAt: created,
      deploymentId: null,
      finishedAt: null,
      id: '77777777-7777-4777-8777-777777777777',
      kind: 'connection_remove',
      orgId: ORG,
      projectId: null,
      providerState: null,
      reason: null,
      requestedBy: USER,
      startedAt: null,
      state: 'queued',
    });

    await expect(build({ requestRemoval }).remove(CALLER, ORG, ID)).resolves.toMatchObject({
      kind: 'connection_remove',
      requestedBy: USER,
      state: 'queued',
    });
    expect(requestRemoval).toHaveBeenCalledWith(TX, ORG, USER, ID);
  });

  // Spec 030 R14 (ask-first 2): every connector removal, GitHub's included, needs a recent second
  // factor; the global StepUpGuard answers `403 step-up-required` without one.
  it('remove requires step-up; the reads and the connect routes do not', () => {
    const metadata = (handler: string) =>
      Reflect.getMetadata(
        REQUIRES_STEP_UP,
        Object.getOwnPropertyDescriptor(ConnectorsController.prototype, handler)!.value as object,
      ) as boolean | undefined;

    expect(metadata('remove')).toBe(true);
    for (const handler of ['list', 'install', 'complete', 'verify', 'repositories']) {
      expect(metadata(handler)).toBeUndefined();
    }
  });

  it('lists every provider in one list: a non-GitHub row answers the provider arm', async () => {
    const neon: ConnectionRecord = {
      ...record,
      accountId: null,
      accountLogin: 'Acme',
      accountRef: 'org-neon-1',
      accountType: null,
      authType: 'token',
      grantedScopes: ['projects:read'],
      id: '55555555-5555-4555-8555-555555555555',
      installationId: null,
      provider: 'neon',
      tokenExpiresAt: null,
    };
    const body = await build({ list: vi.fn().mockResolvedValue([record, neon]) }).list(ORG);

    expect(connectionListSchema.parse(body)).toEqual(body);
    expect(body.connections.map((c) => c.provider)).toEqual(['github', 'neon']);
    expect(body.connections[1]).toMatchObject({
      account: { name: 'Acme', ref: 'org-neon-1' },
      removalRequestedAt: null,
      scopes: ['projects:read'],
    });
  });

  it('verify runs the check as the caller and answers the fresh row as its contract shape', async () => {
    const verify = vi.fn().mockResolvedValue({ ...record, health: 'needs_reauth' });
    const body = await build({ verify }).verify(CALLER, ORG, ID);

    expect(verify).toHaveBeenCalledWith(TX, ORG, ID, USER);
    expect(connectionSchema.parse(body)).toMatchObject({ health: 'needs_reauth' });
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it('repositories checks the connection is the org’s, then answers the service’s page (org:connectors.read)', async () => {
    const byId = vi.fn().mockResolvedValue(record);
    const page = { nextCursor: '2', repositories: [] };
    const listRepositories = vi.fn().mockResolvedValue(page);

    await expect(
      build({ byId, listRepositories }).repositories(ORG, ID, { query: 'web' }),
    ).resolves.toBe(page);
    expect(byId).toHaveBeenCalledWith(TX, ORG, ID);
    expect(listRepositories).toHaveBeenCalledWith(TX, ORG, { query: 'web' });
    expect(permissionOf('repositories')).toBe('org:connectors.read');
  });
});
