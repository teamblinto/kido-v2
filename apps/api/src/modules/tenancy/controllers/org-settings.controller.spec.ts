import { describe, expect, it } from 'vitest';

import { REQUIRED_PERMISSION } from '../../rbac/decorators/require-permission.decorator';
import { ORG_ROLE_PERMISSIONS } from '../../rbac/permissions';
import { RESOURCE_ORG } from '../../rbac/resource-org.resolver';
import { OrgSettingsController } from './org-settings.controller';

function metadataOf(handler: keyof OrgSettingsController, key: string | symbol): unknown {
  const target = Object.getOwnPropertyDescriptor(OrgSettingsController.prototype, handler)!
    .value as object;

  return Reflect.getMetadata(key, target);
}

/** Spec 032 T051 — contracts/byos.md § 2. */
describe('OrgSettingsController', () => {
  it('resolves the org from the path', () => {
    expect(Reflect.getMetadata(RESOURCE_ORG, OrgSettingsController)).toBeDefined();
  });

  it('GET is org:read, PUT is org:settings.update', () => {
    expect(metadataOf('readPersonalAccounts', REQUIRED_PERMISSION)).toEqual({
      param: null,
      permission: 'org:read',
    });
    expect(metadataOf('updatePersonalAccounts', REQUIRED_PERMISSION)).toEqual({
      param: null,
      permission: 'org:settings.update',
    });
  });

  it('a member may read but not PUT (the guard answers 403); owner and admin may PUT', () => {
    expect(ORG_ROLE_PERMISSIONS.member).toContain('org:read');
    expect(ORG_ROLE_PERMISSIONS.member).not.toContain('org:settings.update');
    expect(ORG_ROLE_PERMISSIONS.owner).toContain('org:settings.update');
    expect(ORG_ROLE_PERMISSIONS.admin).toContain('org:settings.update');
  });
});
