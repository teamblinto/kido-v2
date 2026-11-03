import { HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { REQUIRED_PERMISSION } from '../../rbac/decorators/require-permission.decorator';
import { RESOURCE_ORG } from '../../rbac/resource-org.resolver';
import { ProjectAccessController } from './project-access.controller';

function metadataOf(handler: string, key: string | symbol): unknown {
  const target = Object.getOwnPropertyDescriptor(ProjectAccessController.prototype, handler)!
    .value as object;

  return Reflect.getMetadata(key, target);
}

/** Spec 031 T046 — the route table of contracts/sharing.md §§ 1–4. */
describe('ProjectAccessController', () => {
  it('resolves the org from the path', () => {
    expect(Reflect.getMetadata(RESOURCE_ORG, ProjectAccessController)).toBeDefined();
  });

  it('list, invite and withdraw are project:share.external on :projectId', () => {
    for (const handler of ['list', 'invite', 'withdraw'] as const) {
      expect(metadataOf(handler, REQUIRED_PERMISSION), handler).toEqual({
        param: 'projectId',
        permission: 'project:share.external',
      });
    }
  });

  it('invite answers 202, withdraw 204, accept 200', () => {
    expect(metadataOf('invite', '__httpCode__')).toBe(HttpStatus.ACCEPTED);
    expect(metadataOf('withdraw', '__httpCode__')).toBe(HttpStatus.NO_CONTENT);
    expect(metadataOf('accept', '__httpCode__')).toBe(HttpStatus.OK);
  });

  it('accept is session only: no permission', () => {
    expect(metadataOf('accept', REQUIRED_PERMISSION)).toBeUndefined();
  });
});
