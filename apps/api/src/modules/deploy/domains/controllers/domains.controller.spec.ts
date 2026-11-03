import { HttpStatus } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { RateLimitedError } from '../../../../common/errors/domain-error';
import type { TenantContext } from '../../../../database/tenant-context';
import type { AuthenticatedUser } from '../../../identity/services/session.service';
import { REQUIRED_PERMISSION } from '../../../rbac/decorators/require-permission.decorator';
import { RESOURCE_ORG } from '../../../rbac/resource-org.resolver';
import { domainConflict } from '../domain.errors';
import type { DomainService } from '../domain.service';
import { DomainsController } from './domains.controller';

const ORG = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const ID = '44444444-4444-4444-8444-444444444444';
const TX = { tag: 'tx' } as unknown as TenantContext['tx'];
const CALLER = { userId: USER } as AuthenticatedUser;
const REF = { orgId: ORG, projectId: PROJECT };

function build(service: Partial<DomainService>) {
  return new DomainsController({ tx: TX } as TenantContext, service as unknown as DomainService);
}

function metadataOf(handler: string, key: string | symbol): unknown {
  const target = Object.getOwnPropertyDescriptor(DomainsController.prototype, handler)!
    .value as object;

  return Reflect.getMetadata(key, target);
}

/** Spec 028 T044, T052, T069 — the route table of contracts/domains.md; the service is its own spec's. */
describe('DomainsController', () => {
  it('resolves the org from the path', () => {
    expect(Reflect.getMetadata(RESOURCE_ORG, DomainsController)).toBeDefined();
  });

  it('add is org:domains.manage and 201; list and read are project:read on :projectId', () => {
    expect(metadataOf('add', REQUIRED_PERMISSION)).toEqual({
      param: null,
      permission: 'org:domains.manage',
    });
    expect(metadataOf('add', '__httpCode__')).toBe(HttpStatus.CREATED);

    for (const handler of ['list', 'read'] as const) {
      expect(metadataOf(handler, REQUIRED_PERMISSION)).toEqual({
        param: 'projectId',
        permission: 'project:read',
      });
    }
  });

  it('add refuses a missing Idempotency-Key with validation-failed/idempotency_key_required', async () => {
    const add = vi.fn();
    const controller = build({ add });

    await expect(
      controller.add(CALLER, ORG, PROJECT, { hostname: 'app.acme.com' }, undefined),
    ).rejects.toMatchObject({
      extensions: {
        errors: [{ code: 'idempotency_key_required', pointer: '/headers/idempotency-key' }],
      },
      status: 422,
      type: 'validation-failed',
    });
    expect(add).not.toHaveBeenCalled();
  });

  it('add delegates with the caller and the body, and wraps the domain', async () => {
    const add = vi.fn().mockResolvedValue({ id: ID, state: 'pending' });
    const controller = build({ add });

    await expect(
      controller.add(CALLER, ORG, PROJECT, { hostname: 'app.acme.com' }, 'key-1'),
    ).resolves.toEqual({ domain: { id: ID, state: 'pending' } });
    expect(add).toHaveBeenCalledWith(TX, REF, USER, { hostname: 'app.acme.com' });
  });

  it('add passes a refusal through', async () => {
    const controller = build({
      add: vi.fn().mockRejectedValue(domainConflict('hostname-unavailable')),
    });

    await expect(
      controller.add(CALLER, ORG, PROJECT, { hostname: 'app.acme.com' }, 'key-1'),
    ).rejects.toMatchObject({ extensions: { reason: 'hostname-unavailable' }, type: 'conflict' });
  });

  it('list and read delegate on the tenant transaction', async () => {
    const page = { canManage: false, items: [] };
    const list = vi.fn().mockResolvedValue(page);
    const get = vi.fn().mockResolvedValue({ id: ID });
    const controller = build({ get, list });

    await expect(controller.list(CALLER, ORG, PROJECT)).resolves.toBe(page);
    expect(list).toHaveBeenCalledWith(TX, REF, USER);

    await expect(controller.read(ORG, PROJECT, ID)).resolves.toEqual({ domain: { id: ID } });
    expect(get).toHaveBeenCalledWith(TX, REF, ID);
  });

  it('remove is org:domains.manage and 202, and delegates with the caller (T052)', async () => {
    expect(metadataOf('remove', REQUIRED_PERMISSION)).toEqual({
      param: null,
      permission: 'org:domains.manage',
    });
    expect(metadataOf('remove', '__httpCode__')).toBe(HttpStatus.ACCEPTED);

    const answer = { deletableRecords: [], domain: { id: ID, state: 'removing' } };
    const remove = vi.fn().mockResolvedValue(answer);
    const controller = build({ remove });

    await expect(controller.remove(CALLER, ORG, PROJECT, ID)).resolves.toBe(answer);
    expect(remove).toHaveBeenCalledWith(TX, REF, USER, ID);
  });

  it('check is org:domains.manage and 202, and delegates on the tenant transaction (T069)', async () => {
    expect(metadataOf('check', REQUIRED_PERMISSION)).toEqual({
      param: null,
      permission: 'org:domains.manage',
    });
    expect(metadataOf('check', '__httpCode__')).toBe(HttpStatus.ACCEPTED);

    const checkNow = vi.fn().mockResolvedValue({ id: ID, state: 'pending' });
    const controller = build({ checkNow });

    await expect(controller.check(ORG, PROJECT, ID)).resolves.toEqual({
      domain: { id: ID, state: 'pending' },
    });
    expect(checkNow).toHaveBeenCalledWith(TX, REF, ID);
  });

  it('check passes the rate limit through', async () => {
    const controller = build({
      checkNow: vi.fn().mockRejectedValue(new RateLimitedError('Too soon.', 42)),
    });

    await expect(controller.check(ORG, PROJECT, ID)).rejects.toMatchObject({
      extensions: { retryAfter: 42 },
      status: 429,
      type: 'rate-limited',
    });
  });

  it('retry is org:domains.manage and 200, and delegates with the caller (T069)', async () => {
    expect(metadataOf('retry', REQUIRED_PERMISSION)).toEqual({
      param: null,
      permission: 'org:domains.manage',
    });
    expect(metadataOf('retry', '__httpCode__')).toBe(HttpStatus.OK);

    const retry = vi.fn().mockResolvedValue({ id: ID, state: 'pending' });
    const controller = build({ retry });

    await expect(controller.retry(CALLER, ORG, PROJECT, ID)).resolves.toEqual({
      domain: { id: ID, state: 'pending' },
    });
    expect(retry).toHaveBeenCalledWith(TX, REF, USER, ID);
  });

  it('retry passes a refusal through', async () => {
    const controller = build({
      retry: vi.fn().mockRejectedValue(domainConflict('not-retryable')),
    });

    await expect(controller.retry(CALLER, ORG, PROJECT, ID)).rejects.toMatchObject({
      extensions: { reason: 'not-retryable' },
      type: 'conflict',
    });
  });
});
