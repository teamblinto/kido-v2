import { HttpStatus } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import {
  fileContentResponseSchema,
  fileListResponseSchema,
  wakeResponseSchema,
} from '@repo/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { TenantContext } from '../../../database/tenant-context';
import { REQUIRED_PERMISSION } from '../../rbac/decorators/require-permission.decorator';
import { RESOURCE_ORG } from '../../rbac/resource-org.resolver';
import type { FilesService } from '../files.service';
import { SandboxGuardError } from '../sandbox.errors';
import { SandboxModule } from '../sandbox.module';
import { FilesController } from './files.controller';
import { TemplatesController } from './templates.controller';

const ORG = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const REF = { orgId: ORG, projectId: PROJECT };
const TX = { tag: 'tx' } as unknown as TenantContext['tx'];

function build(service: Partial<FilesService>): FilesController {
  return new FilesController({ tx: TX } as TenantContext, service as FilesService);
}

function metadataOf(handler: keyof FilesController, key: string | symbol): unknown {
  const target = Object.getOwnPropertyDescriptor(FilesController.prototype, handler)!
    .value as object;

  return Reflect.getMetadata(key, target);
}

describe('FilesController', () => {
  it('derives the org from the route and demands project:read on all three routes', () => {
    expect(Reflect.getMetadata(RESOURCE_ORG, FilesController)).toEqual({ param: 'orgId' });

    for (const handler of ['list', 'content', 'wake'] as const) {
      expect(metadataOf(handler, REQUIRED_PERMISSION)).toEqual({
        param: 'projectId',
        permission: 'project:read',
      });
    }
    expect(metadataOf('wake', '__httpCode__')).toBe(HttpStatus.OK);
  });

  it('lists the queried directory through the service', async () => {
    const list = vi.fn().mockResolvedValue({
      entries: [{ kind: 'file', name: 'a.txt', size: 3 }],
      path: 'src',
    });
    const body = await build({ list }).list(ORG, PROJECT, { path: 'src' });

    expect(list).toHaveBeenCalledWith(REF, 'src');
    expect(fileListResponseSchema.parse(body)).toEqual(body);
  });

  it('reads a file, unrenderable answers included', async () => {
    const read = vi.fn().mockResolvedValue({
      bytes: 9_000_000,
      path: 'big.bin',
      reason: 'too-large',
      renderable: false,
    });
    const body = await build({ read }).content(ORG, PROJECT, { path: 'big.bin' });

    expect(read).toHaveBeenCalledWith(TX, REF, 'big.bin');
    expect(fileContentResponseSchema.parse(body)).toEqual(body);
  });

  it("reads on the request transaction, so the base it answers with is the tenant's own head", async () => {
    const read = vi.fn().mockResolvedValue({
      baseCheckpointId: '33333333-3333-4333-8333-333333333333',
      bytes: 3,
      content: 'abc',
      path: 'src/a.ts',
      renderable: true,
    });
    const body = await build({ read }).content(ORG, PROJECT, { path: 'src/a.ts' });

    expect(read).toHaveBeenCalledWith(TX, REF, 'src/a.ts');
    expect(fileContentResponseSchema.parse(body)).toEqual(body);
  });

  it('wakes on the request transaction', async () => {
    const wake = vi.fn().mockResolvedValue({ because: 'resuming', ready: false });
    const body = await build({ wake }).wake(ORG, PROJECT);

    expect(wake).toHaveBeenCalledWith(TX, REF);
    expect(wakeResponseSchema.parse(body)).toEqual(body);
  });

  it('adds no error handling of its own — a guard error reaches the filter as thrown', async () => {
    const error = new SandboxGuardError('path-escape', 'Path escapes the workspace.');
    const list = vi.fn().mockRejectedValue(error);

    await expect(build({ list }).list(ORG, PROJECT, { path: '../etc' })).rejects.toBe(error);
  });
});

/** T009 guards T-005's invariant: the new controller joins the chain without adding a guard. */
describe('SandboxModule with the files controller', () => {
  const providers = Reflect.getMetadata('providers', SandboxModule) as unknown[];
  const tokens = providers.map((provider) =>
    typeof provider === 'object' && provider !== null && 'provide' in provider
      ? provider.provide
      : provider,
  );

  it('registers both controllers and still no guard or interceptor of its own', () => {
    expect(Reflect.getMetadata('controllers', SandboxModule)).toEqual([
      TemplatesController,
      FilesController,
    ]);
    expect(tokens).not.toContain(APP_GUARD);
    expect(tokens).not.toContain(APP_INTERCEPTOR);
  });
});
