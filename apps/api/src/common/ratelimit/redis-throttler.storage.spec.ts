import { ConfigModule } from '@nestjs/config';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { validateEnvironment } from '../../config/environment';
import { CLOCK } from '../clock/clock.port';
import { FakeClock } from '../clock/fake-clock';
import { SESSION_REDIS } from '../redis/redis.constants';
import { RedisModule } from '../redis/redis.module';
import { type ThrottlePolicy, failureCeiling, retentionSeconds } from './progressive-delay';
import { type ThrottleBucket, RedisThrottleStorage, throttleKey } from './redis-throttler.storage';

const reachable = inject('redisReachable');

const T0 = '2026-03-01T12:00:00.000Z';

/** Deliberately tiny, so the assertions are about the arithmetic rather than about waiting. */
const POLICY: ThrottlePolicy = {
  burst: 2,
  decaySeconds: 60,
  firstDelaySeconds: 4,
  maxDelaySeconds: 32,
};

const seconds = (count: number): number => count * 1_000;

describe('RedisThrottleStorage', () => {
  /**
   * Against the real instance, for the reason `org-cache.spec.ts` gives: what is worth asserting
   * here is which commands run and what Redis is left holding — a fake would let the wrong ones
   * pass, and the key's TTL is the structural half of "never a permanent lock".
   */
  describe.skipIf(!reachable)('against the session Redis role', () => {
    let moduleRef: TestingModule;
    let storage: RedisThrottleStorage;
    let clock: FakeClock;
    let probe: Redis;
    const keys: string[] = [];

    /** A bucket nothing else in the suite touches. */
    function bucket(policy: ThrottlePolicy = POLICY): ThrottleBucket {
      const key = throttleKey('login-account', randomUUID());

      keys.push(key);

      return { key, policy };
    }

    beforeAll(async () => {
      clock = new FakeClock(T0);
      moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            ignoreEnvFile: true,
            isGlobal: true,
            validate: validateEnvironment,
          }),
          RedisModule,
        ],
        providers: [{ provide: CLOCK, useValue: clock }, RedisThrottleStorage],
      }).compile();

      storage = moduleRef.get(RedisThrottleStorage);
      probe = moduleRef.get<Redis>(SESSION_REDIS);
    });

    beforeEach(() => {
      clock.set(T0);
    });

    afterAll(async () => {
      if (keys.length > 0) {
        await probe.del(...keys);
      }

      await moduleRef.close();
    });

    it('allows an identifier it has never seen', async () => {
      await expect(storage.check([bucket()])).resolves.toEqual({
        allowed: true,
        failures: 0,
        retryAfterSeconds: 0,
      });
    });

    it('allows failures inside the burst', async () => {
      const one = bucket();

      await storage.penalise([one]);
      await storage.penalise([one]);

      await expect(storage.check([one])).resolves.toMatchObject({
        allowed: true,
        failures: 2,
        retryAfterSeconds: 0,
      });
    });

    it('refuses the attempt after the failure that leaves the burst', async () => {
      const one = bucket();

      for (let attempt = 0; attempt <= POLICY.burst; attempt += 1) {
        await storage.penalise([one]);
      }

      await expect(storage.check([one])).resolves.toEqual({
        allowed: false,
        failures: POLICY.burst + 1,
        retryAfterSeconds: POLICY.firstDelaySeconds,
      });
    });

    /**
     * Criterion 16. The refusal is a delay: the same identifier, the same record, and the only
     * thing that changed is that time passed.
     */
    it('allows the same identifier again once the delay has run out', async () => {
      const one = bucket();

      for (let attempt = 0; attempt <= POLICY.burst; attempt += 1) {
        await storage.penalise([one]);
      }

      await expect(storage.check([one])).resolves.toMatchObject({ allowed: false });

      clock.advance(seconds(POLICY.firstDelaySeconds));

      await expect(storage.check([one])).resolves.toMatchObject({
        allowed: true,
        retryAfterSeconds: 0,
      });
    });

    it('forgets the failures entirely once the recovery bound has passed', async () => {
      const one = bucket();

      for (let attempt = 0; attempt < 20; attempt += 1) {
        await storage.penalise([one]);
      }

      clock.advance(seconds(failureCeiling(POLICY) * POLICY.decaySeconds));

      await expect(storage.check([one])).resolves.toEqual({
        allowed: true,
        failures: 0,
        retryAfterSeconds: 0,
      });
    });

    /**
     * The other half of the same guarantee, and the one that holds even if every line of the decay
     * arithmetic were wrong: the record itself expires. A key with no TTL is a lock that survives
     * a deploy, a restart and everybody who remembers why it is there.
     */
    it('leaves a record that expires on its own', async () => {
      const one = bucket();

      await storage.penalise([one]);

      const ttl = await probe.pttl(one.key);

      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(
        seconds(retentionSeconds({ failures: 1, lastFailureAt: 0 }, POLICY)),
      );
    });

    it('lengthens that expiry as the record grows, and still bounds it', async () => {
      const one = bucket();

      for (let attempt = 0; attempt < 20; attempt += 1) {
        await storage.penalise([one]);
      }

      const ttl = await probe.pttl(one.key);

      expect(ttl).toBeGreaterThan(seconds(POLICY.decaySeconds));
      expect(ttl).toBeLessThanOrEqual(
        seconds(retentionSeconds({ failures: failureCeiling(POLICY), lastFailureAt: 0 }, POLICY)),
      );
    });

    /**
     * Parallel attempts are the case a read-modify-write gets wrong, and the way it gets it wrong
     * is to count ten simultaneous failures as one — which is precisely the shape of an attack.
     */
    it('counts simultaneous failures individually', async () => {
      const one = bucket({ ...POLICY, burst: 50, maxDelaySeconds: 1_024 });

      await Promise.all(Array.from({ length: 10 }, async () => storage.penalise([one])));

      await expect(storage.check([one])).resolves.toMatchObject({ failures: 10 });
    });

    describe('across the buckets one attempt is weighed against', () => {
      it('answers with the strictest of them', async () => {
        const account = bucket();
        const address = bucket();

        for (let attempt = 0; attempt <= POLICY.burst; attempt += 1) {
          await storage.penalise([address]);
        }

        await expect(storage.check([account, address])).resolves.toMatchObject({
          allowed: false,
          retryAfterSeconds: POLICY.firstDelaySeconds,
        });
      });

      it('charges a failure to every bucket the attempt belongs to', async () => {
        const account = bucket();
        const address = bucket();

        await storage.penalise([account, address]);

        await expect(storage.check([account])).resolves.toMatchObject({ failures: 1 });
        await expect(storage.check([address])).resolves.toMatchObject({ failures: 1 });
      });
    });

    /** A sign-in that succeeds is the end of the story: the mistyped attempts before it are noise. */
    it('drops the record when the caller finally succeeds', async () => {
      const one = bucket();

      for (let attempt = 0; attempt <= POLICY.burst; attempt += 1) {
        await storage.penalise([one]);
      }

      await storage.forget([one]);

      await expect(storage.check([one])).resolves.toEqual({
        allowed: true,
        failures: 0,
        retryAfterSeconds: 0,
      });
      await expect(probe.exists(one.key)).resolves.toBe(0);
    });

    /**
     * A record that Redis cannot be made to hold — a truncated write, a key some other tool put
     * there — must fail open to "no history" rather than throw. A throttle that 500s on a corrupt
     * value has turned a rate limit into an outage of the sign-in endpoint.
     */
    it('treats an unreadable record as no record at all', async () => {
      const one = bucket();

      await probe.hset(one.key, { failures: 'not-a-number', lastFailureAt: 'nor-this' });

      await expect(storage.check([one])).resolves.toEqual({
        allowed: true,
        failures: 0,
        retryAfterSeconds: 0,
      });
    });
  });

  describe('the key an identifier lands on', () => {
    it('is namespaced by scope, so two scopes cannot collide', () => {
      expect(throttleKey('login-account', 'abc')).not.toBe(throttleKey('login-ip', 'abc'));
    });

    it('is prefixed so a session key can never be mistaken for a throttle record', () => {
      expect(throttleKey('login-ip', '203.0.113.7')).toMatch(/^t:login-ip:/);
    });
  });
});
