import { describe, expect, it, vi } from 'vitest';

import type { TenantContext } from '../../../database/tenant-context';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import { REQUIRED_PERMISSION } from '../../rbac/decorators/require-permission.decorator';
import { deployConflict } from '../deploy.errors';
import type { SiteService } from '../site.service';
import { SiteController } from './site.controller';

const ORG = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const ID = '44444444-4444-4444-8444-444444444444';
const TX = { tag: 'tx' } as unknown as TenantContext['tx'];
const CALLER = { userId: USER } as AuthenticatedUser;
const REF = { orgId: ORG, projectId: PROJECT };
const SITE = {
  currentDeploymentId: ID,
  deployable: true,
  offline: false,
  url: 'https://shop-a1b2c3d4.forge-sites.example',
};

function build(service: Partial<SiteService>) {
  return new SiteController({ tx: TX } as TenantContext, service as unknown as SiteService);
}

function metadataOf(handler: string, key: string | symbol): unknown {
  const target = Object.getOwnPropertyDescriptor(SiteController.prototype, handler)!
    .value as object;

  return Reflect.getMetadata(key, target);
}

/** T063, T091 — the site routes of contracts/deployments.md; the service is `site.service.spec.ts`'s. */
describe('SiteController', () => {
  it('read is project:read; update is project:deploy', () => {
    expect(metadataOf('read', REQUIRED_PERMISSION)).toMatchObject({ permission: 'project:read' });
    expect(metadataOf('update', REQUIRED_PERMISSION)).toMatchObject({
      permission: 'project:deploy',
    });
  });

  it('read delegates on the tenant transaction and wraps the site', async () => {
    const read = vi.fn().mockResolvedValue(SITE);

    expect(await build({ read }).read(ORG, PROJECT)).toEqual({ site: SITE });
    expect(read).toHaveBeenCalledWith(TX, REF);
  });

  it('update routes release with the caller and the deployment id', async () => {
    const release = vi.fn().mockResolvedValue(SITE);
    const offline = vi.fn();

    expect(
      await build({ offline, release }).update(CALLER, ORG, PROJECT, {
        action: 'release',
        deploymentId: ID,
      }),
    ).toEqual({ site: SITE });
    expect(release).toHaveBeenCalledWith(TX, REF, USER, ID);
    expect(offline).not.toHaveBeenCalled();
  });

  it('update routes offline with the caller', async () => {
    const answer = { ...SITE, offline: true };
    const release = vi.fn();
    const offline = vi.fn().mockResolvedValue(answer);

    expect(
      await build({ offline, release }).update(CALLER, ORG, PROJECT, { action: 'offline' }),
    ).toEqual({ site: answer });
    expect(offline).toHaveBeenCalledWith(TX, REF, USER);
    expect(release).not.toHaveBeenCalled();
  });

  it('update passes a refusal through', async () => {
    const refusal = deployConflict('never-deployed');
    const offline = vi.fn().mockRejectedValue(refusal);

    await expect(
      build({ offline }).update(CALLER, ORG, PROJECT, { action: 'offline' }),
    ).rejects.toBe(refusal);
  });
});
