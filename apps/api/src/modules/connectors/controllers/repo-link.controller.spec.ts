import { describe, expect, it, vi } from 'vitest';

import { NotFoundError } from '../../../common/errors/domain-error';
import type { TenantContext } from '../../../database/tenant-context';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import { REQUIRED_PERMISSION } from '../../rbac/decorators/require-permission.decorator';
import { PROJECT_ROLE_PERMISSIONS } from '../../rbac/permissions';
import type { RepoLinkService } from '../repo-link.service';
import { RepoLinkController } from './repo-link.controller';

const ORG = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const USER = '66666666-6666-4666-8666-666666666666';
const TX = { tag: 'tx' } as unknown as TenantContext['tx'];
const CALLER = { userId: USER } as AuthenticatedUser;
const REF = { orgId: ORG, projectId: PROJECT };

function build(overrides: Partial<RepoLinkService>) {
  return new RepoLinkController({ tx: TX } as TenantContext, overrides as RepoLinkService);
}

function permissionOf(handler: string): string {
  const target = Object.getOwnPropertyDescriptor(RepoLinkController.prototype, handler)!
    .value as object;

  return (Reflect.getMetadata(REQUIRED_PERMISSION, target) as { permission: string }).permission;
}

describe('RepoLinkController', () => {
  it('reads for project:read — a viewer may; link and unlink need project:files.write, which a viewer lacks (permission-denied)', () => {
    expect(permissionOf('read')).toBe('project:read');
    expect(PROJECT_ROLE_PERMISSIONS.viewer).toContain('project:read');

    expect(permissionOf('branches')).toBe('project:read');

    for (const handler of [
      'authorize',
      'completeCreate',
      'createBranch',
      'link',
      'unlink',
      'update',
    ] as const) {
      expect(permissionOf(handler)).toBe('project:files.write');
    }
    expect(PROJECT_ROLE_PERMISSIONS.viewer).not.toContain('project:files.write');
    expect(PROJECT_ROLE_PERMISSIONS.editor).toContain('project:files.write');
  });

  it('read and link delegate with the project ref and the caller; the body passes through as its one arm', async () => {
    const read = vi.fn().mockResolvedValue(null);
    const link = vi.fn().mockResolvedValue({ id: 'link' });
    const controller = build({ link, read });

    await expect(controller.read(ORG, PROJECT)).resolves.toBeNull();
    expect(read).toHaveBeenCalledWith(TX, REF);

    await expect(
      controller.link(CALLER, ORG, PROJECT, { existing: { repoId: 7 } }),
    ).resolves.toEqual({ id: 'link' });
    expect(link).toHaveBeenCalledWith(TX, REF, USER, { existing: { repoId: 7 } });
  });

  it('the spec 044 routes delegate with the project ref, the caller and the body', async () => {
    const update = vi.fn().mockResolvedValue({ id: 'link' });
    const branches = vi.fn().mockResolvedValue({ branches: [] });
    const createBranch = vi.fn().mockResolvedValue({ id: 'link' });
    const authorize = vi.fn().mockResolvedValue({ authorizeUrl: 'https://github.example/x' });
    const completeCreate = vi.fn().mockResolvedValue({ id: 'link' });
    const controller = build({ authorize, branches, completeCreate, createBranch, update });

    await controller.update(CALLER, ORG, PROJECT, { autoSync: false });
    expect(update).toHaveBeenCalledWith(TX, REF, USER, { autoSync: false });

    await expect(controller.branches(ORG, PROJECT)).resolves.toEqual({ branches: [] });
    expect(branches).toHaveBeenCalledWith(TX, REF);

    await controller.createBranch(CALLER, ORG, PROJECT, { name: 'dev' });
    expect(createBranch).toHaveBeenCalledWith(TX, REF, USER, { name: 'dev' });

    await controller.authorize(CALLER, ORG, PROJECT, { name: 'blog', private: true });
    expect(authorize).toHaveBeenCalledWith(TX, REF, USER, { name: 'blog', private: true });

    await controller.completeCreate(CALLER, ORG, PROJECT, { code: 'c', state: 's' });
    expect(completeCreate).toHaveBeenCalledWith(TX, REF, USER, { code: 'c', state: 's' });
  });

  it('no such project is the service’s not-found, untouched', async () => {
    const unlink = vi.fn().mockRejectedValue(new NotFoundError('No such project.'));

    await expect(build({ unlink }).unlink(CALLER, ORG, PROJECT)).rejects.toMatchObject({
      status: 404,
      type: 'not-found',
    });
    expect(unlink).toHaveBeenCalledWith(TX, REF, USER);
  });
});
