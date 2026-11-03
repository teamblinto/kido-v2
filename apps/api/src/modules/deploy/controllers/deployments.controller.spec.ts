import { HttpStatus } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { TenantContext } from '../../../database/tenant-context';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import { REQUIRED_PERMISSION } from '../../rbac/decorators/require-permission.decorator';
import { deployConflict } from '../deploy.errors';
import type { DeploymentService } from '../deployment.service';
import { DeploymentsController } from './deployments.controller';

const ORG = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const ID = '44444444-4444-4444-8444-444444444444';
const TX = { tag: 'tx' } as unknown as TenantContext['tx'];
const CALLER = { userId: USER } as AuthenticatedUser;
const REF = { orgId: ORG, projectId: PROJECT };

function build(service: Partial<DeploymentService>) {
  return new DeploymentsController(
    { tx: TX } as TenantContext,
    service as unknown as DeploymentService,
  );
}

function metadataOf(handler: string, key: string | symbol): unknown {
  const target = Object.getOwnPropertyDescriptor(DeploymentsController.prototype, handler)!
    .value as object;

  return Reflect.getMetadata(key, target);
}

/** T050 — the route table of contracts/deployments.md; the service is `deployment.service.spec.ts`'s. */
describe('DeploymentsController', () => {
  it('create is project:deploy and 202; list, read and log are project:read', () => {
    expect(metadataOf('create', REQUIRED_PERMISSION)).toMatchObject({
      permission: 'project:deploy',
    });
    expect(metadataOf('create', '__httpCode__')).toBe(HttpStatus.ACCEPTED);

    for (const handler of ['list', 'read', 'log'] as const) {
      expect(metadataOf(handler, REQUIRED_PERMISSION)).toMatchObject({
        permission: 'project:read',
      });
    }
  });

  it('create refuses a missing Idempotency-Key with validation-failed/idempotency_key_required', async () => {
    const request = vi.fn();
    const controller = build({ request });

    await expect(controller.create(CALLER, ORG, PROJECT, {}, undefined)).rejects.toMatchObject({
      extensions: {
        errors: [{ code: 'idempotency_key_required', pointer: '/headers/idempotency-key' }],
      },
      status: 422,
      type: 'validation-failed',
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('create delegates with the caller and the body, and wraps the row', async () => {
    const request = vi.fn().mockResolvedValue({ id: ID, state: 'queued' });
    const controller = build({ request });

    await expect(
      controller.create(CALLER, ORG, PROJECT, { checkpointId: ID }, 'key-1'),
    ).resolves.toEqual({ deployment: { id: ID, state: 'queued' } });
    expect(request).toHaveBeenCalledWith(TX, REF, USER, { checkpointId: ID });
  });

  it('create passes a refusal through', async () => {
    const controller = build({
      request: vi.fn().mockRejectedValue(deployConflict('deploy-active', { deploymentId: ID })),
    });

    await expect(controller.create(CALLER, ORG, PROJECT, {}, 'key-1')).rejects.toMatchObject({
      extensions: { deploymentId: ID, reason: 'deploy-active' },
      type: 'conflict',
    });
  });

  it('list, read and log delegate on the tenant transaction', async () => {
    const page = { items: [], nextCursor: null };
    const list = vi.fn().mockResolvedValue(page);
    const get = vi.fn().mockResolvedValue({ id: ID });
    const log = vi.fn().mockResolvedValue({ log: '', truncated: false });
    const controller = build({ get, list, log });

    await expect(controller.list(ORG, PROJECT, { limit: 20 })).resolves.toBe(page);
    expect(list).toHaveBeenCalledWith(TX, REF, { limit: 20 });

    await expect(controller.read(ORG, PROJECT, ID)).resolves.toEqual({ deployment: { id: ID } });
    expect(get).toHaveBeenCalledWith(TX, REF, ID);

    await expect(controller.log(ORG, PROJECT, ID)).resolves.toEqual({ log: '', truncated: false });
    expect(log).toHaveBeenCalledWith(TX, REF, ID);
  });
});
