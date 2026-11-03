import { describe, expect, it, vi } from 'vitest';

import { REQUIRED_PERMISSION } from '../../rbac/decorators/require-permission.decorator';
import { ORG_ROLE_PERMISSIONS } from '../../rbac/permissions';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import type { RunService } from '../run.service';
import { UsageController } from './usage.controller';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

/** The mapping and the filter are `run.service.spec.ts`'s; isolation is `usage.e2e-spec.ts`'s. */
describe('UsageController', () => {
  it('GET /orgs/:orgId/usage/runs lists the session user’s own runs, for org:read', async () => {
    const answer = { nextCursor: null, runs: [] };
    const usage = vi.fn().mockResolvedValue(answer);
    const controller = new UsageController({ usage } as unknown as RunService);

    await expect(
      controller.list({ userId: USER } as AuthenticatedUser, ORG, { limit: 25 }),
    ).resolves.toBe(answer);
    expect(usage).toHaveBeenCalledWith(ORG, USER, { limit: 25 });

    const handler = Object.getOwnPropertyDescriptor(UsageController.prototype, 'list')!
      .value as object;

    expect(Reflect.getMetadata(REQUIRED_PERMISSION, handler)).toMatchObject({
      permission: 'org:read',
    });
    expect(ORG_ROLE_PERMISSIONS.member).toContain('org:read');
  });
});
