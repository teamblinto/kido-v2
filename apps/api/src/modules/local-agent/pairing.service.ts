import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type LocalAgentPlatform,
  localAgentUserCodeSchema,
  type PairingPreview,
  type PairingTokenResponse,
  type StartPairingRequest,
  type StartPairingResponse,
} from '@repo/contracts';
import type { Redis } from 'ioredis';
import { isIPv4, isIPv6 } from 'node:net';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import { DomainError } from '../../common/errors/domain-error';
import { SESSION_REDIS } from '../../common/redis/redis.constants';
import type { Environment } from '../../config/environment';
import { DeviceService } from './device.service';
import { keys, LOCAL_AGENT_TIMINGS, type LocalAgentTimings } from './local-agent.constants';
import { HSET_IF_EXISTS, HSETNX_IF_EXISTS } from './local-agent.store';
import { mintDeviceCode, mintUserCode, sha256 } from './secrets';

/** Kept past `expiresAt` for a minute, so a late poll hears `expired` rather than "unknown". */
const EXPIRED_GRACE_SECONDS = 60;

interface Pairing {
  readonly companionVersion: string;
  /** `approved:<userId>` or `denied:<userId>`; absent while pending. Set once (`HSETNX`). */
  readonly decision?: string;
  readonly expiresAt: number;
  readonly name: string;
  readonly platform: LocalAgentPlatform;
  readonly polledAt: number;
  readonly requestedAt: number;
  /** Already coarse (`coarseNetwork`); empty when the address was unknown. */
  readonly requesterIp: string;
  readonly userCode: string;
}

/**
 * The requester's network, not its address: an IPv4 /24 or an IPv6 /48 with the rest zeroed —
 * enough for a person to tell "my home" from "somewhere else" (spec 040 § 5, pairing phishing),
 * without keeping or showing a full address. `null` for anything that is not an IP.
 */
export function coarseNetwork(ip: string | undefined): string | null {
  const address = ip?.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '').split('%')[0] ?? '';

  if (isIPv4(address)) return `${address.split('.').slice(0, 3).join('.')}.0/24`;
  if (!isIPv6(address)) return null;

  const [head = '', tail] = address.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];

  return `${groups
    .slice(0, 3)
    .map((group) => Number.parseInt(group, 16).toString(16))
    .join(':')}::/48`;
}

function invalid(): DomainError {
  return new DomainError(
    'local-agent-pairing-invalid',
    'That pairing code is unknown, expired or already used. Run baios-companion pair again.',
  );
}

/**
 * Pairing (spec 040 § 3 decision 3), modelled on RFC 8628's device authorization grant. The
 * companion holds the `deviceCode` (stored only as its digest); the person approves the short
 * `userCode` in BAIOS under session and step-up; the companion's poll receives the device token
 * exactly once — the device row is created by the poll that wins the pairing's `DEL`, so no token
 * ever rests in Redis. On the session instance: `noeviction`, so a pending pairing is not evicted.
 */
@Injectable()
export class PairingService {
  private readonly logger = new Logger(PairingService.name);
  private readonly appUrl: string;

  constructor(
    @Inject(SESSION_REDIS) private readonly redis: Redis,
    @Inject(DeviceService) private readonly devices: DeviceService,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(LOCAL_AGENT_TIMINGS) private readonly timings: LocalAgentTimings,
    @Inject(ConfigService) config: ConfigService<Environment, true>,
  ) {
    this.appUrl = config.get('APP_URL', { infer: true });
  }

  /** `ip` is the requester's, kept only as `coarseNetwork` of it for the preview. */
  async start(request: StartPairingRequest, ip?: string): Promise<StartPairingResponse> {
    const deviceCode = mintDeviceCode();
    const hash = sha256(deviceCode);
    const ttl = this.timings.pairingTtlSeconds + EXPIRED_GRACE_SECONDS;
    const requestedAt = this.clock.now().getTime();
    const expiresAt = requestedAt + this.timings.pairingTtlSeconds * 1_000;
    let userCode: string | undefined;

    // 20^8 codes: a collision is rare, and NX makes one a retry rather than a hijack.
    for (let attempt = 0; attempt < 5 && userCode === undefined; attempt += 1) {
      const candidate = mintUserCode();
      if ((await this.redis.set(keys.pairingCode(candidate), hash, 'EX', ttl, 'NX')) === 'OK') {
        userCode = candidate;
      }
    }

    if (userCode === undefined) throw new Error('Could not allocate a pairing code.');

    await this.redis
      .multi()
      .hset(keys.pairing(hash), {
        companionVersion: request.companionVersion,
        expiresAt: String(expiresAt),
        name: request.name,
        platform: request.platform,
        polledAt: '0',
        requestedAt: String(requestedAt),
        requesterIp: coarseNetwork(ip) ?? '',
        userCode,
      })
      .expire(keys.pairing(hash), ttl)
      .exec();

    const verificationUri = new URL('/settings/local-agents', this.appUrl);
    verificationUri.searchParams.set('code', userCode);

    return {
      deviceCode,
      expiresAt: new Date(expiresAt).toISOString(),
      intervalSeconds: this.timings.pairingIntervalSeconds,
      userCode,
      verificationUri: verificationUri.toString(),
    };
  }

  /**
   * The companion's poll. A poll inside the interval is answered `pending` and does not count —
   * RFC 8628's `slow_down` without a second status the contract does not have.
   */
  async poll(deviceCode: string): Promise<PairingTokenResponse> {
    const key = keys.pairing(sha256(deviceCode));
    const pairing = await this.read(key);

    if (pairing === undefined) throw invalid();

    const now = this.clock.now().getTime();

    if (now >= pairing.expiresAt) return { status: 'expired' };
    if (now - pairing.polledAt < this.timings.pairingIntervalSeconds * 1_000) {
      return { status: 'pending' };
    }

    // Only onto the pairing that is still there: an HSET after its expiry would re-create it
    // without a TTL. Gone in between is the same as gone before.
    if ((await this.redis.eval(HSET_IF_EXISTS, 1, key, 'polledAt', String(now))) === -1) {
      throw invalid();
    }

    if (pairing.decision === undefined) return { status: 'pending' };
    if (pairing.decision.startsWith('denied:')) return { status: 'denied' };

    // Single use: only the poll whose DEL removed the pairing mints the device.
    if ((await this.redis.del(key)) !== 1) throw invalid();
    await this.redis.del(keys.pairingCode(pairing.userCode));

    const { deviceId, deviceToken } = await this.devices.create(
      pairing.decision.slice('approved:'.length),
      {
        companionVersion: pairing.companionVersion,
        name: pairing.name,
        platform: pairing.platform,
      },
    );

    return { deviceId, deviceToken, status: 'approved' };
  }

  async preview(userCode: string): Promise<PairingPreview> {
    const { pairing } = await this.pending(userCode);

    return {
      companionVersion: pairing.companionVersion,
      expiresAt: new Date(pairing.expiresAt).toISOString(),
      name: pairing.name,
      platform: pairing.platform,
      requestedAt: new Date(pairing.requestedAt).toISOString(),
      requesterIp: pairing.requesterIp === '' ? null : pairing.requesterIp,
    };
  }

  approve(userId: string, userCode: string): Promise<void> {
    return this.decide(userId, userCode, 'approved');
  }

  deny(userId: string, userCode: string): Promise<void> {
    return this.decide(userId, userCode, 'denied');
  }

  private async decide(
    userId: string,
    userCode: string,
    decision: 'approved' | 'denied',
  ): Promise<void> {
    const { key } = await this.pending(userCode);

    // First decision wins; a second, a race with the other button, or a pairing that expired in
    // between (never re-created without its TTL) is a spent code.
    if (
      (await this.redis.eval(HSETNX_IF_EXISTS, 1, key, 'decision', `${decision}:${userId}`)) !== 1
    ) {
      throw invalid();
    }

    this.logger.log(`local agent pairing ${decision}: user=${userId}`);
  }

  /** The pairing a person may still decide: known, undecided and in time. */
  private async pending(userCode: string): Promise<{ key: string; pairing: Pairing }> {
    const code = localAgentUserCodeSchema.safeParse(userCode);
    if (!code.success) throw invalid();

    const hash = await this.redis.get(keys.pairingCode(code.data));
    if (hash === null) throw invalid();

    const key = keys.pairing(hash);
    const pairing = await this.read(key);

    if (
      pairing === undefined ||
      pairing.decision !== undefined ||
      this.clock.now().getTime() >= pairing.expiresAt
    ) {
      throw invalid();
    }

    return { key, pairing };
  }

  private async read(key: string): Promise<Pairing | undefined> {
    const stored = await this.redis.hgetall(key);

    if (stored.userCode === undefined) return undefined;

    return {
      companionVersion: stored.companionVersion ?? '',
      ...(stored.decision === undefined ? {} : { decision: stored.decision }),
      expiresAt: Number(stored.expiresAt),
      name: stored.name ?? '',
      platform: stored.platform as LocalAgentPlatform,
      polledAt: Number(stored.polledAt ?? 0),
      requestedAt: Number(stored.requestedAt ?? 0),
      requesterIp: stored.requesterIp ?? '',
      userCode: stored.userCode,
    };
  }
}
