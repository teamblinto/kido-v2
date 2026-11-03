import { checkpointListResponseSchema, checkpointSchema } from '@repo/contracts';
import type { Checkpoint } from '@repo/db';
import { describe, expect, it, vi } from 'vitest';

import { ConflictError, NotFoundError } from '../../../common/errors/domain-error';
import type { TenantContext } from '../../../database/tenant-context';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import type { CheckpointService } from '../checkpoint.service';
import { CheckpointsController } from './checkpoints.controller';

const ORG = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const ID = '33333333-3333-4333-8333-333333333333';
const TX = { tag: 'tx' } as unknown as TenantContext['tx'];
const CALLER = { userId: '66666666-6666-4666-8666-666666666666' } as AuthenticatedUser;

const row: Checkpoint = {
  actorId: null,
  createdAt: new Date('2026-09-17T10:00:00.000Z'),
  files: [{ bytes: 3, path: 'a.txt', status: 'A' }],
  gitSha: 'a'.repeat(40),
  id: ID,
  kind: 'turn',
  label: 'Turn 1',
  mirroredAt: null,
  orgId: ORG,
  parentId: '44444444-4444-4444-8444-444444444444',
  projectId: PROJECT,
  revertsId: null,
  runId: '55555555-5555-4555-8555-555555555555',
  syncOperationId: null,
  turn: 1,
  updatedAt: new Date('2026-09-17T10:00:00.000Z'),
};

function build(service: Partial<CheckpointService>) {
  const controller = new CheckpointsController(
    { tx: TX } as TenantContext,
    service as CheckpointService,
  );
  return controller;
}

describe('CheckpointsController', () => {
  it('lists through the service on the request transaction and answers contract rows', async () => {
    const list = vi.fn().mockResolvedValue({ items: [row], nextCursor: 'next' });
    const body = await build({ list }).list(ORG, PROJECT, { limit: 10 });

    expect(list).toHaveBeenCalledWith(TX, { orgId: ORG, projectId: PROJECT }, { limit: 10 });
    expect(checkpointListResponseSchema.parse(body)).toEqual(body);
    expect(body.items[0]).toMatchObject({ createdAt: '2026-09-17T10:00:00.000Z', id: ID });
    expect(body.items[0]).not.toHaveProperty('orgId');
  });

  it('reads one checkpoint as its contract shape', async () => {
    const byId = vi.fn().mockResolvedValue(row);
    const body = await build({ byId }).read(ORG, PROJECT, ID);

    expect(byId).toHaveBeenCalledWith(TX, { orgId: ORG, projectId: PROJECT }, ID);
    expect(checkpointSchema.parse(body)).toEqual(body);
  });

  it('lets the service’s not-found through unchanged', async () => {
    const byId = vi.fn().mockRejectedValue(new NotFoundError('No such checkpoint.'));
    const promise = build({ byId }).read(ORG, PROJECT, ID);

    await expect(promise).rejects.toMatchObject({
      detail: 'No such checkpoint.',
      status: 404,
      type: 'not-found',
    });
  });

  it('delegates the diff as the service computes it', async () => {
    const answer = { checkpointId: ID, files: [], parentId: null };
    const diff = vi.fn().mockResolvedValue(answer);

    await expect(build({ diff }).diff(ORG, PROJECT, ID)).resolves.toBe(answer);
    expect(diff).toHaveBeenCalledWith(TX, { orgId: ORG, projectId: PROJECT }, ID);
  });

  describe('revert', () => {
    const reverted: Checkpoint = {
      ...row,
      actorId: CALLER.userId,
      id: '77777777-7777-4777-8777-777777777777',
      kind: 'revert',
      label: 'Revert to Turn 1',
      parentId: ID,
      revertsId: ID,
      runId: null,
      turn: null,
    };

    it('reverts as the caller on the request transaction and answers the new row', async () => {
      const revert = vi.fn().mockResolvedValue(reverted);
      const body = await build({ revert }).revert(CALLER, ORG, PROJECT, ID, 'key-1');

      expect(revert).toHaveBeenCalledWith(
        { orgId: ORG, projectId: PROJECT },
        CALLER.userId,
        ID,
        TX,
      );
      expect(checkpointSchema.parse(body)).toEqual(body);
      expect(body).toMatchObject({ actorId: CALLER.userId, kind: 'revert', revertsId: ID });
    });

    it('refuses a revert without an Idempotency-Key before the service is asked', async () => {
      const revert = vi.fn();
      const promise = build({ revert }).revert(CALLER, ORG, PROJECT, ID, undefined);

      await expect(promise).rejects.toMatchObject({
        extensions: { errors: [{ code: 'idempotency_key_required' }] },
        status: 422,
        type: 'validation-failed',
      });
      expect(revert).not.toHaveBeenCalled();
    });

    it('lets the service’s conflict through unchanged', async () => {
      const revert = vi.fn().mockRejectedValue(new ConflictError('A run is active.'));
      const promise = build({ revert }).revert(CALLER, ORG, PROJECT, ID, 'key-1');

      await expect(promise).rejects.toMatchObject({
        detail: 'A run is active.',
        status: 409,
        type: 'conflict',
      });
    });
  });
});
