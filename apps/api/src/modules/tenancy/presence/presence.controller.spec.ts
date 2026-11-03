import { presenceHeartbeatRequestSchema } from '@repo/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { TenantContext } from '../../../database/tenant-context';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import { REQUIRED_PERMISSION } from '../../rbac/decorators/require-permission.decorator';
import { RESOURCE_ORG } from '../../rbac/resource-org.resolver';
import { PresenceHeartbeatDto } from '../dto/presence-heartbeat.dto';
import { PresenceController } from './presence.controller';
import type { PresenceService } from './presence.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const CALLER = { userId: '66666666-6666-4666-8666-666666666666' } as AuthenticatedUser;

function metadataOf(handler: keyof PresenceController, key: symbol): unknown {
  const target = Object.getOwnPropertyDescriptor(PresenceController.prototype, handler)!
    .value as object;

  return Reflect.getMetadata(key, target);
}

function tenantAnswering(email: string): TenantContext {
  const chain = {
    from: () => chain,
    limit: () => Promise.resolve([{ email }]),
    select: () => chain,
    where: () => chain,
  };

  return { tx: chain } as unknown as TenantContext;
}

describe('PresenceController', () => {
  it('demands project:read on the project in the path for PUT and DELETE', () => {
    expect(Reflect.getMetadata(RESOURCE_ORG, PresenceController)).toEqual({ param: 'orgId' });
    for (const handler of ['heartbeat', 'leave'] as const) {
      expect(metadataOf(handler, REQUIRED_PERMISSION)).toEqual({
        param: 'projectId',
        permission: 'project:read',
      });
    }
  });

  it('parses the location with presenceHeartbeatRequestSchema', () => {
    expect(PresenceHeartbeatDto.zodSchema).toBe(presenceHeartbeatRequestSchema);
  });

  it('heartbeats as the caller, with the email from the principal’s account', async () => {
    const heartbeat = vi.fn().mockResolvedValue({ available: true, people: [] });
    const controller = new PresenceController(tenantAnswering('ada@example.com'), {
      heartbeat,
    } as unknown as PresenceService);

    await controller.heartbeat(CALLER, ORG, PROJECT, { location: { view: 'preview' } });

    expect(heartbeat).toHaveBeenCalledWith(
      ORG,
      PROJECT,
      { email: 'ada@example.com', userId: CALLER.userId },
      { view: 'preview' },
    );
  });

  it('leaves as the caller', async () => {
    const leave = vi.fn().mockResolvedValue(undefined);
    const controller = new PresenceController(tenantAnswering('x@example.com'), {
      leave,
    } as unknown as PresenceService);

    await controller.leave(CALLER, ORG, PROJECT);

    expect(leave).toHaveBeenCalledWith(ORG, PROJECT, CALLER.userId);
  });
});
