import { providerKeyListSchema, providerKeySchema } from '@repo/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { TenantContext } from '../../../database/tenant-context';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import { REQUIRED_PERMISSION } from '../../rbac/decorators/require-permission.decorator';
import { ORG_ROLE_PERMISSIONS } from '../../rbac/permissions';
import { ProviderKeyController } from './provider-key.controller';
import type { ProviderKeyRecord } from '../byok/provider-key.repository';
import type { ProviderKeyService } from '../byok/provider-key.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const ID = '33333333-3333-4333-8333-333333333333';
const USER = '66666666-6666-4666-8666-666666666666';
const KEY = `sk-ant-api03-${'a'.repeat(40)}wxyz`;
const TX = { tag: 'tx' } as unknown as TenantContext['tx'];
const CALLER = { userId: USER } as AuthenticatedUser;

const record: ProviderKeyRecord = {
  addedBy: USER,
  addedByName: 'owner@example.test',
  createdAt: new Date('2026-09-21T09:00:00.000Z'),
  fingerprint: 'sha256:0c86cb5464bdd26117552b7435cd1df3',
  health: 'healthy',
  id: ID,
  lastFour: 'wxyz',
  lastVerifiedAt: new Date('2026-09-21T09:00:00.000Z'),
  orgId: ORG,
  provider: 'anthropic',
  secretId: '44444444-4444-4444-8444-444444444444',
  updatedAt: new Date('2026-09-21T09:00:00.000Z'),
};

function build(overrides: Partial<ProviderKeyService>) {
  return new ProviderKeyController(
    { tx: TX } as TenantContext,
    overrides as unknown as ProviderKeyService,
  );
}

function permissionOf(handler: string): string {
  const target = Object.getOwnPropertyDescriptor(ProviderKeyController.prototype, handler)!
    .value as object;

  return (Reflect.getMetadata(REQUIRED_PERMISSION, target) as { permission: string }).permission;
}

describe('ProviderKeyController', () => {
  it('lists keys as contract rows for org:connectors.read: last four and fingerprint, no key, no secret id (SC-002)', async () => {
    const list = vi.fn().mockResolvedValue([record]);
    const body = await build({ list }).list(ORG);

    expect(list).toHaveBeenCalledWith(TX, ORG);
    expect(providerKeyListSchema.parse(body)).toEqual(body);
    expect(body.keys[0]).toMatchObject({
      addedBy: { id: USER, name: 'owner@example.test' },
      fingerprint: record.fingerprint,
      lastFour: 'wxyz',
      provider: 'anthropic',
    });

    const json = JSON.stringify(body);

    expect(json).not.toContain(KEY);
    expect(json).not.toContain('apiKey');
    expect(json).not.toContain('secretId');
    expect(permissionOf('list')).toBe('org:connectors.read');
    expect(ORG_ROLE_PERMISSIONS.member).toContain('org:connectors.read');
  });

  it('demands org:connectors.manage of put, remove and verify — a member has none of it', () => {
    for (const handler of ['put', 'remove', 'verify'] as const) {
      expect(permissionOf(handler)).toBe('org:connectors.manage');
    }
    expect(ORG_ROLE_PERMISSIONS.member).not.toContain('org:connectors.manage');
  });

  it('put stores as the caller and answers the contract row without the key', async () => {
    const put = vi.fn().mockResolvedValue(record);
    const body = await build({ put }).put(CALLER, ORG, 'anthropic', { apiKey: KEY });

    expect(put).toHaveBeenCalledWith(TX, ORG, USER, 'anthropic', KEY);
    expect(providerKeySchema.parse(body)).toEqual(body);
    expect(JSON.stringify(body)).not.toContain(KEY);
  });

  it('an unknown :provider is not-found on put, remove and verify, before the service is reached', async () => {
    const put = vi.fn();
    const remove = vi.fn();
    const verify = vi.fn();
    const controller = build({ put, remove, verify });

    await expect(controller.put(CALLER, ORG, 'github', { apiKey: KEY })).rejects.toMatchObject({
      type: 'not-found',
    });
    await expect(controller.remove(CALLER, ORG, 'GitHub')).rejects.toMatchObject({
      type: 'not-found',
    });
    await expect(controller.verify(CALLER, ORG, '')).rejects.toMatchObject({ type: 'not-found' });
    expect(put).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it('remove delegates as the caller and answers nothing (204)', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);

    await expect(build({ remove }).remove(CALLER, ORG, 'openai')).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledWith(TX, ORG, USER, 'openai');
  });

  it('verify runs the check as the caller and answers the fresh row', async () => {
    const verify = vi.fn().mockResolvedValue({ ...record, health: 'needs_reauth' });
    const body = await build({ verify }).verify(CALLER, ORG, 'anthropic');

    expect(verify).toHaveBeenCalledWith(TX, ORG, 'anthropic', USER);
    expect(providerKeySchema.parse(body)).toMatchObject({ health: 'needs_reauth' });
    expect(JSON.stringify(body)).not.toContain(KEY);
  });
});
