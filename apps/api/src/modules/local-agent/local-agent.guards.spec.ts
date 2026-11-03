import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import type { DeviceService } from './device.service';
import { DeviceThrottlerGuard, DeviceTokenGuard } from './local-agent.guards';

const DEVICE = 'b0400000-0000-4000-8000-0000000000d1';

/** `getTracker` is protected: the one seam this suite reads. */
interface Tracked {
  getTracker(request: Record<string, unknown>): Promise<string>;
}

/** Spec 040 § 5: the uplink is throttled per device id as well as per address. */
describe('DeviceThrottlerGuard', () => {
  it('tracks the device the token guard authenticated, whatever address it comes from', async () => {
    const request: Record<PropertyKey, unknown> = {
      headers: { authorization: `Bearer bld_${'A'.repeat(43)}` },
      ip: '203.0.113.7',
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    await new DeviceTokenGuard({
      authenticate: () => Promise.resolve({ id: DEVICE }),
    } as unknown as DeviceService).canActivate(context);
    const guard = new DeviceThrottlerGuard({ throttlers: [] }, {} as never, {} as never);

    await expect((guard as unknown as Tracked).getTracker(request)).resolves.toBe(
      `local-agent-device:${DEVICE}`,
    );
    await expect(
      (guard as unknown as Tracked).getTracker({ ...request, ip: '198.51.100.1' }),
    ).resolves.toBe(`local-agent-device:${DEVICE}`);
  });

  it('falls back to the address when no device is on the request', async () => {
    const guard = new DeviceThrottlerGuard({ throttlers: [] }, {} as never, {} as never);

    await expect((guard as unknown as Tracked).getTracker({ ip: '203.0.113.7' })).resolves.toBe(
      '203.0.113.7',
    );
  });
});
