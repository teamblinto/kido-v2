import 'reflect-metadata';

import { describe, expect, it, vi } from 'vitest';

import { NotFoundError } from '../../../common/errors/domain-error';
import { ValidationFailedError } from '../../../common/validation/validation-failed.error';
import type { TenantContext } from '../../../database/tenant-context';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import { REQUIRED_PERMISSION } from '../../rbac/decorators/require-permission.decorator';
import { PROJECT_ROLE_PERMISSIONS, WORKSPACE_ROLE_PERMISSIONS } from '../../rbac/permissions';
import type { BindingService } from '../binding.service';
import type { ConnectorListings } from '../connector-listings';
import type { DatabaseMigrationService } from '../database-migrations';
import type { OperationService } from '../operation.service';
import { BindingsController } from './bindings.controller';
import { ConnectorListingsController } from './connector-listings.controller';

const TX = { marker: 'tx' };
const ORG = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const CALLER = { userId: '33333333-3333-4333-8333-333333333333' } as AuthenticatedUser;
const NEON = { databaseName: 'app', parentBranchId: 'br', projectId: 'np', roleName: 'app' };

function permissionOf(controller: object, handler: string): string {
  const target = Object.getOwnPropertyDescriptor(controller, handler)!.value as object;

  return (Reflect.getMetadata(REQUIRED_PERMISSION, target) as { permission: string }).permission;
}

function build() {
  const bindings = {
    bind: vi.fn(() => Promise.resolve({ id: 'b' })),
    list: vi.fn(() => Promise.resolve([])),
    requestNeonReset: vi.fn(() => Promise.resolve({ id: 'op' })),
    requestNetlifyPublish: vi.fn(() => Promise.resolve({ id: 'op' })),
    unbind: vi.fn(() => Promise.resolve({ id: 'op' })),
  };
  const operations = { list: vi.fn(() => Promise.resolve({ items: [] })) };
  const migrations = {
    apply: vi.fn(() => Promise.resolve({ applied: ['1'], failed: null, skipped: [] })),
    status: vi.fn(() => Promise.resolve({ applied: [], directory: 'db/migrations' })),
  };
  const controller = new BindingsController(
    { tx: TX } as unknown as TenantContext,
    bindings as unknown as BindingService,
    operations as unknown as OperationService,
    migrations as unknown as DatabaseMigrationService,
  );

  return { bindings, controller, migrations, operations };
}

/** Spec 030 T074, contracts/bindings.md §§ 1–2. */
describe('BindingsController', () => {
  it('reads for project:read, binds and unbinds for org:connectors.manage, resets for project:files.write', () => {
    const proto = BindingsController.prototype;

    expect(permissionOf(proto, 'list')).toBe('project:read');
    expect(permissionOf(proto, 'listOperations')).toBe('project:read');
    expect(permissionOf(proto, 'bind')).toBe('org:connectors.manage');
    expect(permissionOf(proto, 'unbind')).toBe('org:connectors.manage');
    expect(permissionOf(proto, 'resetNeon')).toBe('project:files.write');
    expect(permissionOf(proto, 'publishNetlify')).toBe('project:deploy');
  });

  it('an editor can reset the database but not bind (the permission is org-level)', () => {
    expect(PROJECT_ROLE_PERMISSIONS.editor).toContain('project:files.write');
    expect(PROJECT_ROLE_PERMISSIONS.editor).not.toContain('org:connectors.manage' as never);
    expect(WORKSPACE_ROLE_PERMISSIONS.editor).not.toContain('org:connectors.manage' as never);
  });

  it('PUT parses the provider’s strict body and hands it to the service', async () => {
    const { bindings, controller } = build();

    await controller.bind(CALLER, ORG, PROJECT, 'neon', NEON);

    expect(bindings.bind).toHaveBeenCalledWith(
      TX,
      { orgId: ORG, projectId: PROJECT },
      CALLER.userId,
      'neon',
      NEON,
    );
  });

  it('PUT with a stray key is validation-failed before the service runs', async () => {
    const { bindings, controller } = build();

    await expect(
      controller.bind(CALLER, ORG, PROJECT, 'supabase', { projectRef: 'x', extra: 1 }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    expect(bindings.bind).not.toHaveBeenCalled();
  });

  it('a provider this route does not bind is 404', async () => {
    const { controller } = build();

    await expect(controller.bind(CALLER, ORG, PROJECT, 'github', {})).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(() => controller.unbind(CALLER, ORG, PROJECT, 'toString')).toThrow(NotFoundError);
  });

  it('PUT netlify takes a site id or a new site’s name, never both', async () => {
    const { bindings, controller } = build();

    await controller.bind(CALLER, ORG, PROJECT, 'netlify', { siteId: 'site-1' });
    await controller.bind(CALLER, ORG, PROJECT, 'netlify', { createSite: { name: 'my-site' } });

    expect(bindings.bind).toHaveBeenNthCalledWith(
      2,
      TX,
      { orgId: ORG, projectId: PROJECT },
      CALLER.userId,
      'netlify',
      { createSite: { name: 'my-site' } },
    );
    await expect(
      controller.bind(CALLER, ORG, PROJECT, 'netlify', {
        createSite: { name: 'Bad Name' },
      }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(
      controller.bind(CALLER, ORG, PROJECT, 'netlify', {
        createSite: { name: 'a' },
        siteId: 'x',
      }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    expect(bindings.bind).toHaveBeenCalledTimes(2);
  });

  it('POST netlify/publish parses { deploymentId } and answers the operation', async () => {
    const { bindings, controller } = build();
    const deploymentId = '44444444-4444-4444-8444-444444444444';

    await expect(
      controller.publishNetlify(CALLER, ORG, PROJECT, { deploymentId }),
    ).resolves.toEqual({ id: 'op' });
    expect(bindings.requestNetlifyPublish).toHaveBeenCalledWith(
      TX,
      { orgId: ORG, projectId: PROJECT },
      CALLER.userId,
      deploymentId,
    );
    await expect(
      controller.publishNetlify(CALLER, ORG, PROJECT, { deploymentId: 'nope' }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('DELETE answers the release operation', async () => {
    const { bindings, controller } = build();

    await expect(controller.unbind(CALLER, ORG, PROJECT, 'neon')).resolves.toEqual({ id: 'op' });
    expect(bindings.unbind).toHaveBeenCalledWith(
      TX,
      { orgId: ORG, projectId: PROJECT },
      CALLER.userId,
      'neon',
    );
  });

  it('migrations: status for project:read, apply for org:connectors.manage', () => {
    const proto = BindingsController.prototype;

    expect(permissionOf(proto, 'migrationStatus')).toBe('project:read');
    expect(permissionOf(proto, 'applyMigrations')).toBe('org:connectors.manage');
  });

  it('migrations: only Neon and Supabase, a strict body, then the service', async () => {
    const { controller, migrations } = build();
    const body = { migrations: [{ name: 'todos', sql: 'create table t ()', version: '1' }] };

    await expect(
      controller.applyMigrations(CALLER, ORG, PROJECT, 'supabase', body),
    ).resolves.toEqual({ applied: ['1'], failed: null, skipped: [] });
    expect(migrations.apply).toHaveBeenCalledWith(
      TX,
      { orgId: ORG, projectId: PROJECT },
      CALLER.userId,
      'supabase',
      body.migrations,
    );
    await expect(
      controller.applyMigrations(CALLER, ORG, PROJECT, 'neon', {
        migrations: [{ name: 'x', sql: 'select 1', version: "1'; drop" }],
      }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    expect(() => controller.migrationStatus(ORG, PROJECT, 'netlify')).toThrow(NotFoundError);
    await controller.migrationStatus(ORG, PROJECT, 'neon');
    expect(migrations.status).toHaveBeenCalledWith(TX, { orgId: ORG, projectId: PROJECT }, 'neon');
  });

  it('GET /operations checks the project, then pages the operations', async () => {
    const { bindings, controller, operations } = build();

    await controller.listOperations(ORG, PROJECT, { limit: 20 });

    expect(bindings.list).toHaveBeenCalled();
    expect(operations.list).toHaveBeenCalledWith(TX, ORG, PROJECT, { limit: 20 });
  });
});

describe('ConnectorListingsController', () => {
  it('lists for org:connectors.read through the named connection', async () => {
    const proto = ConnectorListingsController.prototype;

    expect(permissionOf(proto, 'neonProjects')).toBe('org:connectors.read');
    expect(permissionOf(proto, 'supabaseProjects')).toBe('org:connectors.read');
    expect(permissionOf(proto, 'netlifySites')).toBe('org:connectors.read');

    const listings = {
      netlifySites: vi.fn(() => Promise.resolve({ items: [] })),
      neonProjects: vi.fn(() => Promise.resolve({ items: [] })),
      supabaseProjects: vi.fn(() => Promise.resolve({ items: [] })),
    };
    const controller = new ConnectorListingsController(
      { tx: TX } as unknown as TenantContext,
      listings as unknown as ConnectorListings,
    );

    await controller.neonProjects(ORG, 'conn', { q: 'shop' });
    await controller.supabaseProjects(ORG, 'conn');
    await controller.netlifySites(ORG, 'conn', { cursor: undefined, q: 'acme' });

    expect(listings.neonProjects).toHaveBeenCalledWith(TX, ORG, 'conn', 'shop');
    expect(listings.supabaseProjects).toHaveBeenCalledWith(TX, ORG, 'conn');
    expect(listings.netlifySites).toHaveBeenCalledWith(TX, ORG, 'conn', 'acme', undefined);
  });
});
