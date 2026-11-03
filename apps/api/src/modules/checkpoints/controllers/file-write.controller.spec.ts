import { writeFileResponseSchema } from '@repo/contracts';
import type { Checkpoint } from '@repo/db';
import { describe, expect, it, vi } from 'vitest';

import { ConflictError } from '../../../common/errors/domain-error';
import type { TenantContext } from '../../../database/tenant-context';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import { REQUIRED_PERMISSION } from '../../rbac/decorators/require-permission.decorator';
import { RESOURCE_ORG } from '../../rbac/resource-org.resolver';
import type { CheckpointService } from '../checkpoint.service';
import type { WriteFileRequestDto } from '../dto/file-write.dto';
import { FileWriteController, type StatusSettingResponse } from './file-write.controller';

const ORG = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const ID = '33333333-3333-4333-8333-333333333333';
const BASE = '44444444-4444-4444-8444-444444444444';
const TX = { tag: 'tx' } as unknown as TenantContext['tx'];
const CALLER = { userId: '66666666-6666-4666-8666-666666666666' } as AuthenticatedUser;

const row: Checkpoint = {
  actorId: CALLER.userId,
  createdAt: new Date('2026-09-17T10:00:00.000Z'),
  files: [{ bytes: 3, path: 'src/a.ts', status: 'M' }],
  gitSha: 'a'.repeat(40),
  id: ID,
  kind: 'edit',
  label: 'Edit src/a.ts',
  mirroredAt: null,
  orgId: ORG,
  parentId: BASE,
  projectId: PROJECT,
  revertsId: null,
  runId: null,
  syncOperationId: null,
  turn: null,
  updatedAt: new Date('2026-09-17T10:00:00.000Z'),
};

const body: WriteFileRequestDto = {
  baseCheckpointId: BASE,
  content: 'abc',
  path: 'src/a.ts',
};

function build(service: Partial<CheckpointService>): FileWriteController {
  return new FileWriteController({ tx: TX } as TenantContext, service as CheckpointService);
}

function recorder(): StatusSettingResponse & { code: number | undefined } {
  return {
    code: undefined,
    status(code: number) {
      this.code = code;
      return this;
    },
  };
}

function metadataOf(handler: keyof FileWriteController, key: string | symbol): unknown {
  const target = Object.getOwnPropertyDescriptor(FileWriteController.prototype, handler)!
    .value as object;

  return Reflect.getMetadata(key, target);
}

describe('FileWriteController', () => {
  it('derives the org from the route and demands project:files.write on the save route', () => {
    expect(Reflect.getMetadata(RESOURCE_ORG, FileWriteController)).toEqual({ param: 'orgId' });
    expect(metadataOf('save', REQUIRED_PERMISSION)).toEqual({
      param: 'projectId',
      permission: 'project:files.write',
    });
  });

  it('saves through the service as the caller on the request transaction, body unchanged', async () => {
    const save = vi.fn().mockResolvedValue({ checkpoint: row, saved: true });
    const response = recorder();
    const answer = await build({ save }).save(CALLER, ORG, PROJECT, body, 'key-1', response);

    expect(save).toHaveBeenCalledWith(
      { orgId: ORG, projectId: PROJECT },
      CALLER.userId,
      { baseCheckpointId: BASE, content: 'abc', path: 'src/a.ts' },
      TX,
    );
    expect(writeFileResponseSchema.parse(answer)).toEqual(answer);
    expect(answer).toMatchObject({ saved: true });
    expect(answer.checkpoint).toMatchObject({ createdAt: '2026-09-17T10:00:00.000Z', id: ID });
    expect(answer.checkpoint).not.toHaveProperty('orgId');
  });

  it('answers 201 on the response object when the service recorded a checkpoint', async () => {
    const save = vi.fn().mockResolvedValue({ checkpoint: row, saved: true });
    const response = recorder();

    await build({ save }).save(CALLER, ORG, PROJECT, body, 'key-1', response);

    expect(response.code).toBe(201);
  });

  it('answers 200 on the response object when the content was already there', async () => {
    const save = vi.fn().mockResolvedValue({ checkpoint: row, saved: false });
    const response = recorder();
    const answer = await build({ save }).save(CALLER, ORG, PROJECT, body, 'key-1', response);

    expect(response.code).toBe(200);
    expect(writeFileResponseSchema.parse(answer)).toEqual(answer);
    expect(answer).toMatchObject({ saved: false });
  });

  it('refuses a save without an Idempotency-Key before the service is asked', async () => {
    const save = vi.fn();
    const response = recorder();
    const promise = build({ save }).save(CALLER, ORG, PROJECT, body, undefined, response);

    await expect(promise).rejects.toMatchObject({
      extensions: { errors: [{ code: 'idempotency_key_required' }] },
      status: 422,
      type: 'validation-failed',
    });
    expect(save).not.toHaveBeenCalled();
    expect(response.code).toBeUndefined();
  });

  it('lets the service’s conflict through unchanged and sets no status', async () => {
    const save = vi.fn().mockRejectedValue(new ConflictError('The base has moved.'));
    const response = recorder();
    const promise = build({ save }).save(CALLER, ORG, PROJECT, body, 'key-1', response);

    await expect(promise).rejects.toMatchObject({
      detail: 'The base has moved.',
      status: 409,
      type: 'conflict',
    });
    expect(response.code).toBeUndefined();
  });
});
