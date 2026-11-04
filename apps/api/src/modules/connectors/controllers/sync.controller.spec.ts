import { syncCommitResponseSchema, syncOperationPageSchema } from '@repo/contracts';
import { HttpStatus } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { TenantContext } from '../../../database/tenant-context';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import { REQUIRED_PERMISSION } from '../../rbac/decorators/require-permission.decorator';
import { PROJECT_ROLE_PERMISSIONS } from '../../rbac/permissions';
import { syncConflict } from '../connectors.errors';
import type { SyncRecord } from '../sync.repository';
import { SyncService } from '../sync.service';
import { SyncController } from './sync.controller';

const ORG = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const USER = '66666666-6666-4666-8666-666666666666';
const ID = '33333333-3333-4333-8333-333333333333';
const TX = { tag: 'tx' } as unknown as TenantContext['tx'];
const CALLER = { userId: USER } as AuthenticatedUser;
const REF = { orgId: ORG, projectId: PROJECT };

const record: SyncRecord = {
  commits: 0,
  createdAt: new Date('2026-09-20T10:00:00.000Z'),
  finishedAt: null,
  fromSha: null,
  id: ID,
  kind: 'push',
  linkId: '44444444-4444-4444-8444-444444444444',
  orgId: ORG,
  projectId: PROJECT,
  reason: null,
  requestedBy: USER,
  requestedByName: 'owner@example.test',
  startedAt: null,
  state: 'queued',
  targetBranch: null,
  toSha: null,
  trigger: 'manual',
  updatedAt: new Date('2026-09-20T10:00:00.000Z'),
};

/** The real `toContract`, the rest stubbed. */
function build(overrides: Partial<SyncService>) {
  const service = {
    toContract: (row: SyncRecord) => SyncService.prototype.toContract.call(undefined, row),
    ...overrides,
  } as unknown as SyncService;

  return new SyncController({ tx: TX } as TenantContext, service);
}

function metadataOf(handler: string, key: string | symbol): unknown {
  const target = Object.getOwnPropertyDescriptor(SyncController.prototype, handler)!
    .value as object;

  return Reflect.getMetadata(key, target);
}

describe('SyncController', () => {
  it('push and pull are project:files.write and 202; the reads are project:read', () => {
    for (const handler of ['push', 'pull'] as const) {
      expect(metadataOf(handler, REQUIRED_PERMISSION)).toMatchObject({
        permission: 'project:files.write',
      });
      expect(metadataOf(handler, '__httpCode__')).toBe(HttpStatus.ACCEPTED);
    }
    for (const handler of ['list', 'read'] as const) {
      expect(metadataOf(handler, REQUIRED_PERMISSION)).toMatchObject({
        permission: 'project:read',
      });
    }
    expect(PROJECT_ROLE_PERMISSIONS.viewer).not.toContain('project:files.write');
  });

  it('commit is project:files.write and 200, delegating with the caller and the body', async () => {
    expect(metadataOf('commit', REQUIRED_PERMISSION)).toMatchObject({
      permission: 'project:files.write',
    });
    expect(metadataOf('commit', '__httpCode__')).toBe(HttpStatus.OK);

    const answer = { checkpointId: null, operation: null };
    const commit = vi.fn().mockResolvedValue(answer);
    const controller = build({ commit });

    await expect(controller.commit(CALLER, ORG, PROJECT, { message: 'Ship' })).resolves.toEqual(
      answer,
    );
    expect(commit).toHaveBeenCalledWith(TX, REF, USER, { message: 'Ship' });
    expect(syncCommitResponseSchema.parse(answer)).toEqual(answer);
  });

  it('a refusal of the commit passes through', async () => {
    const refusal = syncConflict('not-linked', 'nope');
    const controller = build({ commit: vi.fn().mockRejectedValue(refusal) });

    await expect(controller.commit(CALLER, ORG, PROJECT, {})).rejects.toBe(refusal);
  });

  it('push and pull delegate with the kind and the caller, and pass a § 4 refusal through', async () => {
    const request = vi.fn().mockResolvedValue({ id: ID });
    const controller = build({ request });

    await expect(controller.push(CALLER, ORG, PROJECT)).resolves.toEqual({ id: ID });
    expect(request).toHaveBeenCalledWith(TX, REF, USER, 'push');

    await controller.pull(CALLER, ORG, PROJECT);
    expect(request).toHaveBeenLastCalledWith(TX, REF, USER, 'pull');

    const refused = vi.fn().mockRejectedValue(syncConflict('nothing-to-push', 'No checkpoint.'));

    await expect(build({ request: refused }).push(CALLER, ORG, PROJECT)).rejects.toMatchObject({
      extensions: { reason: 'nothing-to-push' },
      status: 409,
      type: 'conflict',
    });
  });

  it('list answers the page as contract rows, the cursor only when there is one', async () => {
    const list = vi.fn().mockResolvedValue({ items: [record], nextCursor: null });
    const body = await build({ list }).list(ORG, PROJECT, { limit: 20 });

    expect(list).toHaveBeenCalledWith(TX, REF, { limit: 20 });
    expect(syncOperationPageSchema.parse(body)).toEqual(body);
    expect(body).toEqual({
      operations: [
        expect.objectContaining({
          id: ID,
          requestedBy: { id: USER, name: 'owner@example.test' },
          state: 'queued',
        }),
      ],
    });

    const paged = vi.fn().mockResolvedValue({ items: [record], nextCursor: 'next' });

    await expect(build({ list: paged }).list(ORG, PROJECT, { limit: 1 })).resolves.toMatchObject({
      nextCursor: 'next',
    });
  });

  it('read delegates by id under the project ref', async () => {
    const byId = vi.fn().mockResolvedValue({ id: ID });

    await expect(build({ byId }).read(ORG, PROJECT, ID)).resolves.toEqual({ id: ID });
    expect(byId).toHaveBeenCalledWith(TX, REF, ID);
  });
});
