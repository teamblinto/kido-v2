import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { LocalAgentDeviceRow } from '@repo/db';

import { NotFoundError } from '../../common/errors/domain-error';
import type { Environment } from '../../config/environment';
import { DeviceService } from './device.service';

/** Where `DeviceTokenGuard` leaves the authenticated device on the request. */
const DEVICE = Symbol('forge.local-agent.device');

type DeviceRequest = Record<PropertyKey, unknown> & {
  readonly headers?: Record<string, string | string[] | undefined>;
};

/** `LOCAL_AGENT_ENABLED=false`: every bridge route is an unknown route (spec 040 § 2). */
@Injectable()
export class LocalAgentEnabledGuard implements CanActivate {
  private readonly enabled: boolean;

  constructor(@Inject(ConfigService) config: ConfigService<Environment, true>) {
    this.enabled = config.get('LOCAL_AGENT_ENABLED', { infer: true });
  }

  canActivate(): boolean {
    if (!this.enabled) throw new NotFoundError('Cannot find this route.');

    return true;
  }
}

/**
 * The companion's credential (spec 040 § 5): `Authorization: Bearer bld_…`, no cookie. The routes
 * are `@Public()` to the session guard and exempt from CSRF by exact path, so this is their only
 * gate. An unknown, malformed or revoked token is `401 local-agent-revoked`.
 */
@Injectable()
export class DeviceTokenGuard implements CanActivate {
  constructor(@Inject(DeviceService) private readonly devices: DeviceService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<DeviceRequest>();
    const header = request.headers?.authorization;
    const token =
      typeof header === 'string' && header.startsWith('Bearer ')
        ? header.slice(7).trim()
        : undefined;

    request[DEVICE] = await this.devices.authenticate(token);

    return true;
  }
}

/** The device `DeviceTokenGuard` authenticated. */
export const CurrentDevice = createParamDecorator(
  (_data: unknown, context: ExecutionContext): LocalAgentDeviceRow =>
    context.switchToHttp().getRequest<DeviceRequest>()[DEVICE] as LocalAgentDeviceRow,
);

/**
 * The uplink's throttle per device id, beside the app-wide one per address (spec 040 § 5): many
 * devices behind one NAT share an address, and one device can hop addresses. After
 * `DeviceTokenGuard`, so the device is known; the route's `@Throttle` sets the limit.
 */
@Injectable()
export class DeviceThrottlerGuard extends ThrottlerGuard {
  protected override getTracker(request: Record<string, unknown>): Promise<string> {
    const device = (request as DeviceRequest)[DEVICE] as LocalAgentDeviceRow | undefined;

    return device === undefined
      ? super.getTracker(request)
      : Promise.resolve(`local-agent-device:${device.id}`);
  }
}
