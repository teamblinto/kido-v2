import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';

import { FakeClock } from '../../common/clock/fake-clock';
import type { DeviceService } from './device.service';
import { DEFAULT_LOCAL_AGENT_TIMINGS } from './local-agent.constants';
import { HSET_IF_EXISTS, HSETNX_IF_EXISTS } from './local-agent.store';
import { coarseNetwork, PairingService } from './pairing.service';

const USER = 'b0400000-0000-4000-8000-0000000000a1';
const DEVICE = 'b0400000-0000-4000-8000-0000000000d1';
const TOKEN = `bld_${'A'.repeat(43)}`;

/** The commands pairing uses, in memory, with TTLs ignored (the clock decides expiry here). */
function fakeRedis() {
  const strings = new Map<string, string>();
  const hashes = new Map<string, Record<string, string>>();
  const redis = {
    del: (...keys: string[]) =>
      Promise.resolve(keys.filter((key) => strings.delete(key) || hashes.delete(key)).length),
    // The two scripts, as Redis runs them: nothing is written onto a hash that is gone.
    eval: (script: string, _keys: number, key: string, field: string, value: string) => {
      const hash = hashes.get(key);
      if (hash === undefined) return Promise.resolve(-1);
      if (script === HSETNX_IF_EXISTS && field in hash) return Promise.resolve(0);
      if (script !== HSET_IF_EXISTS && script !== HSETNX_IF_EXISTS) throw new Error('script');
      hashes.set(key, { ...hash, [field]: value });
      return Promise.resolve(1);
    },
    get: (key: string) => Promise.resolve(strings.get(key) ?? null),
    hgetall: (key: string) => Promise.resolve({ ...(hashes.get(key) ?? {}) }),
    hset: (key: string, field: string, value: string) => {
      hashes.set(key, { ...(hashes.get(key) ?? {}), [field]: value });
      return Promise.resolve(1);
    },
    hsetnx: (key: string, field: string, value: string) => {
      const hash = hashes.get(key) ?? {};
      if (field in hash) return Promise.resolve(0);
      hashes.set(key, { ...hash, [field]: value });
      return Promise.resolve(1);
    },
    multi: () => {
      const chain = {
        exec: () => Promise.resolve([]),
        expire: () => chain,
        hset: (key: string, fields: Record<string, string>) => {
          hashes.set(key, { ...(hashes.get(key) ?? {}), ...fields });
          return chain;
        },
      };
      return chain;
    },
    set: (key: string, value: string, ..._options: unknown[]) => {
      if (strings.has(key)) return Promise.resolve(null);
      strings.set(key, value);
      return Promise.resolve('OK');
    },
  };

  return { hashes, redis: redis as unknown as Redis };
}

function setup() {
  const clock = new FakeClock('2026-11-02T00:00:00Z');
  const create = vi.fn(() => Promise.resolve({ deviceId: DEVICE, deviceToken: TOKEN }));
  const { hashes, redis } = fakeRedis();
  const service = new PairingService(
    redis,
    { create } as unknown as DeviceService,
    clock,
    DEFAULT_LOCAL_AGENT_TIMINGS,
    { get: () => 'https://app.example.test' } as never,
  );
  const request = { companionVersion: '0.1.0', name: 'Laptop', platform: 'linux' as const };

  return { clock, create, hashes, request, service };
}

const INTERVAL_MS = DEFAULT_LOCAL_AGENT_TIMINGS.pairingIntervalSeconds * 1_000;

describe('PairingService', () => {
  it('starts with a device code, a user code and the web route to approve it', async () => {
    const { request, service } = setup();
    const started = await service.start(request);

    expect(started.deviceCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(started.userCode).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
    expect(started.verificationUri).toBe(
      `https://app.example.test/settings/local-agents?code=${started.userCode}`,
    );
    expect(started.intervalSeconds).toBe(DEFAULT_LOCAL_AGENT_TIMINGS.pairingIntervalSeconds);
    await expect(service.preview(started.userCode.toLowerCase())).resolves.toMatchObject({
      name: 'Laptop',
      platform: 'linux',
    });
  });

  it('is pending until approved, then hands the token over exactly once', async () => {
    const { clock, create, request, service } = setup();
    const { deviceCode, userCode } = await service.start(request);

    await expect(service.poll(deviceCode)).resolves.toEqual({ status: 'pending' });
    await service.approve(USER, userCode);

    // Too soon after the last poll: still pending, and that poll does not count.
    await expect(service.poll(deviceCode)).resolves.toEqual({ status: 'pending' });
    clock.advance(INTERVAL_MS);
    await expect(service.poll(deviceCode)).resolves.toEqual({
      deviceId: DEVICE,
      deviceToken: TOKEN,
      status: 'approved',
    });
    expect(create).toHaveBeenCalledWith(USER, request);

    clock.advance(INTERVAL_MS);
    await expect(service.poll(deviceCode)).rejects.toMatchObject({
      type: 'local-agent-pairing-invalid',
    });
    await expect(service.preview(userCode)).rejects.toMatchObject({
      type: 'local-agent-pairing-invalid',
    });
  });

  it('answers denied after a denial and refuses a second decision', async () => {
    const { clock, create, request, service } = setup();
    const { deviceCode, userCode } = await service.start(request);

    await service.deny(USER, userCode);
    await expect(service.approve(USER, userCode)).rejects.toMatchObject({
      type: 'local-agent-pairing-invalid',
    });
    clock.advance(INTERVAL_MS);
    await expect(service.poll(deviceCode)).resolves.toEqual({ status: 'denied' });
    expect(create).not.toHaveBeenCalled();
  });

  it('expires: the poll says so, and the code can no longer be approved', async () => {
    const { clock, request, service } = setup();
    const { deviceCode, userCode } = await service.start(request);

    clock.advance(DEFAULT_LOCAL_AGENT_TIMINGS.pairingTtlSeconds * 1_000);

    await expect(service.poll(deviceCode)).resolves.toEqual({ status: 'expired' });
    await expect(service.approve(USER, userCode)).rejects.toMatchObject({
      type: 'local-agent-pairing-invalid',
    });
  });

  it('previews when and from which network the code was requested', async () => {
    const { request, service } = setup();
    const { userCode } = await service.start(request, '203.0.113.77');

    await expect(service.preview(userCode)).resolves.toEqual({
      companionVersion: '0.1.0',
      expiresAt: '2026-11-02T00:10:00.000Z',
      name: 'Laptop',
      platform: 'linux',
      requestedAt: '2026-11-02T00:00:00.000Z',
      requesterIp: '203.0.113.0/24',
    });

    const unknown = await service.start(request);
    await expect(service.preview(unknown.userCode)).resolves.toMatchObject({ requesterIp: null });
  });

  it('never re-creates a pairing that expired between its read and the write', async () => {
    const { clock, create, hashes, request, service } = setup();
    const { deviceCode, userCode } = await service.start(request);
    const [key] = [...hashes.keys()];
    const original = hashes.get.bind(hashes);
    let reads = 0;

    // Redis expires the hash right after the service read it: the write must find it gone.
    hashes.get = (name: string) => (name === key && (reads += 1) > 1 ? undefined : original(name));

    await expect(service.approve(USER, userCode)).rejects.toMatchObject({
      type: 'local-agent-pairing-invalid',
    });
    reads = 0;
    clock.advance(INTERVAL_MS);
    await expect(service.poll(deviceCode)).rejects.toMatchObject({
      type: 'local-agent-pairing-invalid',
    });

    hashes.get = original;
    expect(hashes.get(key!)).toMatchObject({ polledAt: '0' });
    expect(hashes.get(key!)).not.toHaveProperty('decision');
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses an unknown device code and a malformed or unknown user code', async () => {
    const { service } = setup();

    await expect(service.poll('x'.repeat(43))).rejects.toMatchObject({
      type: 'local-agent-pairing-invalid',
    });
    await expect(service.preview('nope')).rejects.toMatchObject({
      type: 'local-agent-pairing-invalid',
    });
    await expect(service.preview('BCDF-GHJK')).rejects.toMatchObject({
      type: 'local-agent-pairing-invalid',
    });
  });
});

describe('coarseNetwork', () => {
  it('keeps an IPv4 /24 and an IPv6 /48, the rest zeroed', () => {
    expect(coarseNetwork('203.0.113.77')).toBe('203.0.113.0/24');
    expect(coarseNetwork('::ffff:198.51.100.9')).toBe('198.51.100.0/24');
    expect(coarseNetwork('2001:db8:abcd:12::1')).toBe('2001:db8:abcd::/48');
    expect(coarseNetwork('2001:0db8::1')).toBe('2001:db8:0::/48');
    expect(coarseNetwork('fe80::1%eth0')).toBe('fe80:0:0::/48');
    expect(coarseNetwork('::1')).toBe('0:0:0::/48');
  });

  it('is null for anything that is not an address', () => {
    expect(coarseNetwork(undefined)).toBeNull();
    expect(coarseNetwork('')).toBeNull();
    expect(coarseNetwork('unknown')).toBeNull();
  });
});
