import { HttpStatus } from '@nestjs/common';
import { syncOperationSchema, inspectImportResponseSchema } from '@repo/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { TenantContext } from '../../../database/tenant-context';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import { REQUIRED_PERMISSION } from '../../rbac/decorators/require-permission.decorator';
import { WORKSPACE_ROLE_PERMISSIONS } from '../../rbac/permissions';
import { ImportEmptyRepoError } from '../connectors.errors';
import type { ImportService } from '../import.service';
import { ImportController } from './import.controller';

const ORG = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '55555555-5555-4555-8555-555555555555';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const USER = '66666666-6666-4666-8666-666666666666';
const ID = '33333333-3333-4333-8333-333333333333';
const TX = { tag: 'tx' } as unknown as TenantContext['tx'];
const CALLER = { userId: USER } as AuthenticatedUser;

function build(overrides: Partial<ImportService>): ImportController {
  return new ImportController({ tx: TX } as TenantContext, overrides as ImportService);
}

function metadataOf(handler: string, key: string | symbol): unknown {
  const target = Object.getOwnPropertyDescriptor(ImportController.prototype, handler)!
    .value as object;

  return Reflect.getMetadata(key, target);
}

/**
 * Spec 026 contracts §§ 1–2: the two routes, the permission that admits them and the status each
 * answers. The permission is asserted against the workspace role's own set rather than spelled
 * twice — a route guarded by a permission no workspace role holds is a route nobody can reach.
 */
describe('ImportController', () => {
  it('both routes are the workspace’s project-create permission', () => {
    for (const handler of ['inspect', 'start'] as const) {
      // Qualified by `:workspaceId` (ADR 031): the guard reads the id the permission is scoped to
      // from the route, so an import cannot be aimed at a workspace the caller has no role in.
      expect(metadataOf(handler, REQUIRED_PERMISSION)).toEqual({
        param: 'workspaceId',
        permission: 'workspace:projects.create',
      });
    }

    expect(WORKSPACE_ROLE_PERMISSIONS.admin).toContain('workspace:projects.create');
    expect(WORKSPACE_ROLE_PERMISSIONS.viewer ?? []).not.toContain('workspace:projects.create');
  });

  it('inspect answers 200 and start answers 202 — a queued import is not a created project', () => {
    expect(metadataOf('inspect', '__httpCode__')).toBe(HttpStatus.OK);
    expect(metadataOf('start', '__httpCode__')).toBe(HttpStatus.ACCEPTED);
  });

  it('inspect passes the tenant transaction and the body, and answers a contract-valid proposal', async () => {
    const inspect = vi.fn().mockResolvedValue({
      branch: 'main',
      candidates: [{ evidence: ['vite.config.ts', 'dependency: react'], template: 'vite-react' }],
      empty: false,
      headSha: 'a'.repeat(40),
      outcome: 'proposed',
      repo: { id: 7, name: 'site', owner: 'acme' },
      sizeKib: 120,
    });

    const answer = await build({ inspect }).inspect(ORG, { repoId: 7 });

    expect(inspect).toHaveBeenCalledWith(TX, ORG, { repoId: 7 });
    expect(inspectImportResponseSchema.parse(answer).outcome).toBe('proposed');
  });

  it('start passes the caller, the workspace and the body, and answers a kind: import operation', async () => {
    const start = vi.fn().mockResolvedValue({
      commits: 0,
      createdAt: '2026-09-20T10:00:00.000Z',
      finishedAt: null,
      fromSha: null,
      id: ID,
      kind: 'import',
      projectId: PROJECT,
      reason: null,
      requestedBy: { id: USER, name: 'owner@example.test' },
      startedAt: null,
      state: 'queued',
      targetBranch: null,
      toSha: 'b'.repeat(40),
      trigger: 'manual',
    });
    const body = {
      branch: 'main',
      name: 'Imported',
      repoId: 7,
      template: 'vite-react' as const,
    };

    const answer = await build({ start }).start(CALLER, ORG, WORKSPACE, body);

    expect(start).toHaveBeenCalledWith(TX, ORG, WORKSPACE, USER, body);
    // Contracts § 2: spec 018's schema unchanged, at `kind: 'import'`, carrying the project the
    // client navigates to while the import runs.
    expect(syncOperationSchema.parse(answer)).toMatchObject({
      kind: 'import',
      projectId: PROJECT,
      state: 'queued',
    });
  });

  it('a refusal travels as the service threw it — the controller invents no status', async () => {
    const start = vi.fn().mockRejectedValue(new ImportEmptyRepoError('main'));

    await expect(
      build({ start }).start(CALLER, ORG, WORKSPACE, {
        branch: 'main',
        name: 'Imported',
        repoId: 7,
        template: 'vite-react',
      }),
    ).rejects.toMatchObject({
      extensions: { reason: 'empty-repo' },
      type: 'import-empty-repo',
    });
  });
});
