import { connectionSchema } from '@repo/contracts';
import { describe, expect, it, vi } from 'vitest';

import { DomainError } from '../../../common/errors/domain-error';
import type { TenantContext } from '../../../database/tenant-context';
import { REQUIRES_STEP_UP } from '../../identity/decorators/step-up.decorator';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import { OauthStateError } from '../../identity/services/oauth.service';
import { REQUIRED_PERMISSION } from '../../rbac/decorators/require-permission.decorator';
import { ORG_ROLE_PERMISSIONS } from '../../rbac/permissions';
import type { ConnectionRecord } from '../connection.repository';
import { ConnectionService } from '../connection.service';
import { ProviderConnectController } from './provider-connect.controller';

const ORG = '11111111-1111-4111-8111-111111111111';
const ID = '33333333-3333-4333-8333-333333333333';
const USER = '66666666-6666-4666-8666-666666666666';
const TOKEN = 'napi_k3m9x2q7w4p8r1t6v5n0b3l7c2y9z4d8f1g6h5j0';
const TX = { tag: 'tx' } as unknown as TenantContext['tx'];
const CALLER = { userId: USER } as AuthenticatedUser;

const record: ConnectionRecord = {
  accountId: null,
  accountLogin: 'Acme',
  accountRef: 'org-neon-1',
  accountType: null,
  authType: 'token',
  circuitOpenUntil: null,
  connectedBy: USER,
  connectedByName: 'owner@example.test',
  createdAt: new Date('2026-09-23T10:00:00.000Z'),
  credentialFingerprint: 'sha256:0c86cb5464bdd26117552b7435cd1df3',
  failedResources: [],
  failureCount: 0,
  grantedScopes: ['projects:read'],
  health: 'healthy',
  id: ID,
  installationId: null,
  lastVerifiedAt: new Date('2026-09-23T10:00:00.000Z'),
  orgId: ORG,
  provider: 'neon',
  removalRequestedAt: null,
  secretId: '44444444-4444-4444-8444-444444444444',
  tokenExpiresAt: null,
  updatedAt: new Date('2026-09-23T10:00:00.000Z'),
};

function build(overrides: Partial<ConnectionService>) {
  const service = {
    toContract: (row: ConnectionRecord) =>
      ConnectionService.prototype.toContract.call(undefined, row),
    ...overrides,
  } as unknown as ConnectionService;

  return new ProviderConnectController({ tx: TX } as TenantContext, service);
}

function metadataOf(key: string | symbol, handler: string): unknown {
  return Reflect.getMetadata(
    key,
    Object.getOwnPropertyDescriptor(ProviderConnectController.prototype, handler)!.value as object,
  );
}

/** Spec 030 T042, contracts/bindings.md § 1. */
describe('ProviderConnectController', () => {
  it('demands org:connectors.manage of every route — a member has none of it; no step-up', () => {
    for (const handler of ['pasteToken', 'supabaseInstall', 'supabaseComplete']) {
      expect(metadataOf(REQUIRED_PERMISSION, handler)).toMatchObject({
        permission: 'org:connectors.manage',
      });
      expect(metadataOf(REQUIRES_STEP_UP, handler)).toBeUndefined();
    }
    expect(ORG_ROLE_PERMISSIONS.member).not.toContain('org:connectors.manage');
  });

  it('pasteToken connects as the caller and answers the contract row without the token', async () => {
    const connectWithToken = vi.fn().mockResolvedValue(record);
    const body = await build({ connectWithToken }).pasteToken(CALLER, ORG, 'neon', {
      token: TOKEN,
    });

    expect(connectWithToken).toHaveBeenCalledWith(TX, ORG, USER, 'neon', TOKEN);
    expect(connectionSchema.parse(body)).toEqual(body);
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it('pasteToken refuses a provider that is not a pasted-token one, before any call', async () => {
    const connectWithToken = vi.fn();

    for (const provider of ['github', 'supabase', 'gitlab']) {
      await expect(
        build({ connectWithToken }).pasteToken(CALLER, ORG, provider, { token: TOKEN }),
      ).rejects.toMatchObject({ type: 'not-found' });
    }
    expect(connectWithToken).not.toHaveBeenCalled();
  });

  it('pasteToken passes a missing-scope refusal through untouched', async () => {
    const refusal = new DomainError('validation-failed', 'missing', {
      missing: ['dns:read'],
      reason: 'missing-scope',
    });
    const connectWithToken = vi.fn().mockRejectedValue(refusal);

    await expect(
      build({ connectWithToken }).pasteToken(CALLER, ORG, 'cloudflare', { token: TOKEN }),
    ).rejects.toBe(refusal);
  });

  it('supabaseInstall answers the authorize URL', async () => {
    const beginSupabaseInstall = vi.fn().mockResolvedValue({ url: 'https://api.supabase.com/x' });

    await expect(build({ beginSupabaseInstall }).supabaseInstall(CALLER, ORG)).resolves.toEqual({
      url: 'https://api.supabase.com/x',
    });
    expect(beginSupabaseInstall).toHaveBeenCalledWith(ORG, USER);
  });

  it('supabaseComplete answers the connected row; a replayed state is oauth-state-invalid', async () => {
    const completeSupabaseInstall = vi
      .fn()
      .mockResolvedValueOnce({ ...record, authType: 'oauth', provider: 'supabase' })
      .mockRejectedValueOnce(new OauthStateError());
    const controller = build({ completeSupabaseInstall });

    await expect(
      controller.supabaseComplete(CALLER, ORG, { code: 'c', state: 's' }),
    ).resolves.toMatchObject({ authType: 'oauth', provider: 'supabase' });
    expect(completeSupabaseInstall).toHaveBeenCalledWith(TX, ORG, USER, { code: 'c', state: 's' });
    await expect(
      controller.supabaseComplete(CALLER, ORG, { code: 'c', state: 's' }),
    ).rejects.toMatchObject({ status: 400, type: 'oauth-state-invalid' });
  });
});
