import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { openClient } from '../../../../test/support/integration-redis';
import { FakeClock } from '../../../common/clock/fake-clock';
import { PRESENCE_TTL_SECONDS, presenceKey } from './presence.constants';
import { PresenceService } from './presence.service';

const reachable = inject('redisReachable');
const START = '2026-09-23T10:00:00.000Z';

const ADA = { email: 'ada@example.com', userId: randomUUID() };
const BOB = { email: 'bob@example.com', userId: randomUUID() };

describe('PresenceService', () => {
  /** Against the real session instance: every claim here is about field TTLs and hash contents. */
  describe.skipIf(!reachable)('against the session Redis role', () => {
    let redis: Redis;
    let clock: FakeClock;
    let presence: PresenceService;
    const orgId = randomUUID();
    const projectId = randomUUID();
    const key = presenceKey(orgId, projectId);

    beforeAll(async () => {
      redis = openClient(process.env.REDIS_SESSION_URL!);
      await redis.connect();
      clock = new FakeClock(START);
      presence = new PresenceService(redis, clock);
    });

    afterEach(async () => {
      await redis.del(key);
      clock.set(START);
    });

    afterAll(() => {
      redis.disconnect();
    });

    it("writes the caller's field with a 30 s field expiry", async () => {
      await presence.heartbeat(orgId, projectId, ADA, { view: 'preview' });

      const [ttl] = (await redis.call('HTTL', key, 'FIELDS', '1', ADA.userId)) as number[];

      expect(ttl).toBeGreaterThan(PRESENCE_TTL_SECONDS - 2);
      expect(ttl).toBeLessThanOrEqual(PRESENCE_TTL_SECONDS);
    });

    it('answers everyone but the caller', async () => {
      await presence.heartbeat(orgId, projectId, BOB, { view: 'history' });
      const answer = await presence.heartbeat(orgId, projectId, ADA, { view: 'preview' });

      expect(answer).toEqual({
        available: true,
        people: [{ ...BOB, location: { view: 'history' }, seenAt: START }],
      });
    });

    it('drops entries older than the TTL even if the field survived', async () => {
      await presence.heartbeat(orgId, projectId, BOB, { view: 'history' });
      clock.advance((PRESENCE_TTL_SECONDS + 1) * 1000);

      const answer = await presence.heartbeat(orgId, projectId, ADA, { view: 'preview' });

      expect(answer.people).toEqual([]);
    });

    it('one person in several tabs is one entry, at the latest location', async () => {
      await presence.heartbeat(orgId, projectId, BOB, { view: 'history' });
      await presence.heartbeat(orgId, projectId, BOB, { path: 'src/a.ts', view: 'code' });

      const answer = await presence.heartbeat(orgId, projectId, ADA, { view: 'preview' });

      expect(answer.people).toHaveLength(1);
      expect(answer.people[0]?.location).toEqual({ path: 'src/a.ts', view: 'code' });
    });

    it("leave deletes the caller's field", async () => {
      await presence.heartbeat(orgId, projectId, ADA, { view: 'preview' });
      await presence.leave(orgId, projectId, ADA.userId);

      expect(await redis.hexists(key, ADA.userId)).toBe(0);
    });

    it("forget deletes another person's field", async () => {
      await presence.heartbeat(orgId, projectId, BOB, { view: 'preview' });
      await presence.forget(orgId, projectId, BOB.userId);

      expect(await redis.hexists(key, BOB.userId)).toBe(0);
    });
  });

  describe('when Redis fails', () => {
    function throwing(): Redis {
      const fail = (): never => {
        throw new Error('ECONNREFUSED');
      };
      const chain = { exec: () => Promise.reject(new Error('ECONNREFUSED')) } as Record<
        string,
        unknown
      >;
      for (const name of ['hset', 'hexpire', 'hgetall']) chain[name] = () => chain;

      return {
        hdel: () => Promise.reject(new Error('ECONNREFUSED')),
        hgetall: fail,
        multi: () => chain,
      } as unknown as Redis;
    }

    it('a Redis error answers available false and an empty list, never throws', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const presence = new PresenceService(throwing(), new FakeClock(START));

      await expect(
        presence.heartbeat(randomUUID(), randomUUID(), ADA, { view: 'preview' }),
      ).resolves.toEqual({ available: false, people: [] });
      await expect(presence.leave(randomUUID(), randomUUID(), ADA.userId)).resolves.toBeUndefined();
      await expect(
        presence.forget(randomUUID(), randomUUID(), ADA.userId),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
    });
  });
});
