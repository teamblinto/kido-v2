import { describe, expect, it, vi } from 'vitest';

import type { TenantContext } from '../../../database/tenant-context';
import { REQUIRED_PERMISSION } from '../../rbac/decorators/require-permission.decorator';
import { ORG_ROLE_PERMISSIONS } from '../../rbac/permissions';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import type { CatalogueService } from '../byok/catalogue.service';
import { ModelsController } from './models.controller';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const TX = { tag: 'tx' } as unknown as TenantContext['tx'];

/** The composition cases (no keys, BYOK, OpenAI appended, needs_reauth, default fall-through) are `catalogue.service.spec.ts`'s. */
describe('ModelsController', () => {
  it('GET /orgs/:orgId/models answers the organisation catalogue on the tenant transaction, for org:read', async () => {
    const answer = { default: 'claude-sonnet-5', models: [] };
    const forOrg = vi.fn().mockResolvedValue(answer);
    const controller = new ModelsController(
      { tx: TX } as TenantContext,
      { forOrg } as unknown as CatalogueService,
    );

    await expect(controller.list({ userId: USER } as AuthenticatedUser, ORG)).resolves.toBe(answer);
    expect(forOrg).toHaveBeenCalledWith(TX, ORG, USER);

    const handler = Object.getOwnPropertyDescriptor(ModelsController.prototype, 'list')!
      .value as object;

    expect(Reflect.getMetadata(REQUIRED_PERMISSION, handler)).toMatchObject({
      permission: 'org:read',
    });
    expect(ORG_ROLE_PERMISSIONS.member).toContain('org:read');
  });
});
