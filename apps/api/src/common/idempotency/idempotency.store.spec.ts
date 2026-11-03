import { ConfigModule } from '@nestjs/config';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { CLOCK } from '../clock/clock.port';
import { FakeClock } from '../clock/fake-clock';
import { SESSION_REDIS } from '../redis/redis.constants';
import { RedisModule } from '../redis/redis.module';
import { validateEnvironment } from '../../config/environment';
import { IdempotencyStore, idempotencyRecordKey } from './idempotency.store';

const reachable = inject('redisReachable');

const START = '2026-08-16T09:00:00.000Z';
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

/** A fresh key per test, so one test's leftover record can never decide another's outcome. */
function newKey(): string {
  return randomUUID();
}

describe('idempotencyRecordKey', () => {
  it('namespaces the client-supplied key, so two principals cannot share a replay slot', () => {
    const key = 'b3d0f0c2-0000-4000-8000-000000000000';

    expect(idempotencyRecordKey('anon', key)).toBe(`i:anon:${key}`);
    expect(idempotencyRecordKey('anon', key)).not.toBe(
      idempotencyRecordKey('11111111-1111-4111-8111-111111111111', key),
    );
  });

  /**
   * `:` is the delimiter, so a namespace or key carrying one would make `i:a:b:c` ambiguous and let
   * a caller address another principal's slot. The store refuses rather than trusting its caller,
   * because the key reaches it from a request header.
   */
  it('refuses a namespace or key that could forge a slot belonging to someone else', () => {
    expect(() => idempotencyRecordKey('anon:x', 'k')).toThrow(TypeError);
    expect(() => idempotencyRecordKey('anon', 'a:b')).toThrow(TypeError);
    expect(() => idempotencyRecordKey('', 'k')).toThrow(TypeError);
    expect(() => idempotencyRecordKey('anon', '')).toThrow(TypeError);
  });
});

describe('IdempotencyStore', () => {
  /**
   * Nothing here is worth asserting against a fake. Every property the store promises — that a
   * second caller cannot acquire a slot the first holds, that a lease survives only as long as its
   * TTL, that completion is conditional on still owning it — is a property of the Redis commands
   * it issues, and a stub would let the wrong ones pass.
   */
  describe.skipIf(!reachable)('against the session Redis role', () => {
    let moduleRef: TestingModule;
    let store: IdempotencyStore;
    let redis: Redis;
    let clock: FakeClock;
    const written: string[] = [];

    /** Records every key the test touches, so `afterAll` does not have to guess the namespace. */
    function slot(overrides: { fingerprint?: string; key?: string; namespace?: string } = {}): {
      fingerprint: string;
      key: string;
      namespace: string;
    } {
      const resolved = {
        fingerprint: overrides.fingerprint ?? 'a'.repeat(64),
        key: overrides.key ?? newKey(),
        namespace: overrides.namespace ?? 'anon',
      };

      written.push(idempotencyRecordKey(resolved.namespace, resolved.key));

      return resolved;
    }

    beforeAll(async () => {
      clock = new FakeClock(START);
      moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            ignoreEnvFile: true,
            isGlobal: true,
            validate: validateEnvironment,
          }),
          RedisModule,
        ],
        providers: [IdempotencyStore, { provide: CLOCK, useValue: clock }],
      }).compile();

      store = moduleRef.get(IdempotencyStore);
      redis = moduleRef.get<Redis>(SESSION_REDIS);
    });

    afterAll(async () => {
      if (written.length > 0) {
        await redis.del(...written);
      }

      await moduleRef.close();
    });

    it('acquires the slot for a key nobody has used', async () => {
      const outcome = await store.begin(slot());

      expect(outcome.outcome).toBe('acquired');
    });

    /**
     * The lease is deliberately far shorter than the 24 h record. A process killed between
     * acquiring and completing leaves the slot held, and holding it for the full window would mean
     * a single crash makes one key unusable for a day — the client would retry, be told the request
     * is still in flight, and be right to disbelieve it.
     */
    it('holds an in-flight slot for a bounded lease, not for the whole 24 h window', async () => {
      const target = slot();
      const outcome = await store.begin(target);
      const remaining = await redis.pttl(idempotencyRecordKey(target.namespace, target.key));

      expect(outcome.outcome).toBe('acquired');
      expect(remaining).toBeGreaterThan(30_000);
      expect(remaining).toBeLessThanOrEqual(60_000);
    });

    it('reports a second caller on an in-flight key as in-flight, and does not let it acquire', async () => {
      const target = slot();

      await store.begin(target);

      const second = await store.begin(target);

      expect(second.outcome).toBe('in-flight');
    });

    /**
     * The case the whole design exists for: the same key with a different body is a client bug, and
     * serving the first response would hide it behind a success the client never asked for.
     */
    it('reports a mismatch when the same key arrives with a different fingerprint', async () => {
      const target = slot();

      await store.begin(target);

      const second = await store.begin({ ...target, fingerprint: 'b'.repeat(64) });

      expect(second.outcome).toBe('mismatch');
    });

    it('replays the recorded response once the first caller completes', async () => {
      const target = slot();
      const begun = await store.begin(target);

      expect(begun.outcome).toBe('acquired');

      if (begun.outcome !== 'acquired') {
        return;
      }

      await store.complete(begun.lease, { body: { id: 'inv_1', seats: 3 }, status: 201 });

      const replay = await store.begin(target);

      expect(replay).toStrictEqual({
        outcome: 'replay',
        record: { body: { id: 'inv_1', seats: 3 }, status: 201 },
      });
    });

    it('still reports a mismatch against a completed record, not the recorded response', async () => {
      const target = slot();
      const begun = await store.begin(target);

      if (begun.outcome !== 'acquired') {
        throw new Error('expected to acquire the slot');
      }

      await store.complete(begun.lease, { body: { id: 'inv_1' }, status: 201 });

      const second = await store.begin({ ...target, fingerprint: 'c'.repeat(64) });

      expect(second.outcome).toBe('mismatch');
    });

    /**
     * §14: the record is kept "for 24h" from the request, so a client that retries 23 h later still
     * replays. Anchoring the window at completion instead would extend it by however long the
     * handler ran, which is a different — and unbounded — promise.
     */
    it('anchors the 24 h window on first receipt, not on completion', async () => {
      const target = slot();
      const begun = await store.begin(target);

      if (begun.outcome !== 'acquired') {
        throw new Error('expected to acquire the slot');
      }

      clock.advance(HOUR_MS);
      await store.complete(begun.lease, { body: null, status: 204 });

      const remaining = await redis.pttl(idempotencyRecordKey(target.namespace, target.key));

      expect(remaining).toBeGreaterThan(DAY_MS - HOUR_MS - 5_000);
      expect(remaining).toBeLessThanOrEqual(DAY_MS - HOUR_MS);
    });

    /**
     * A request that failed did not happen, so its key has to be usable again — otherwise a
     * transient 500 costs the client its key for a day and the retry it was told to make is refused.
     */
    it('frees the slot on release, so a failed request can be retried on the same key', async () => {
      const target = slot();
      const begun = await store.begin(target);

      if (begun.outcome !== 'acquired') {
        throw new Error('expected to acquire the slot');
      }

      await store.release(begun.lease);

      const second = await store.begin(target);

      expect(second.outcome).toBe('acquired');
    });

    /**
     * The lease expires; a second request acquires; the first — slower than its own lease — finally
     * returns. Without the ownership check it would overwrite a slot it no longer holds, and the
     * second caller's response would be recorded under the first caller's result.
     */
    it('refuses to complete a lease another caller has taken over', async () => {
      const target = slot();
      const first = await store.begin(target);

      if (first.outcome !== 'acquired') {
        throw new Error('expected to acquire the slot');
      }

      await store.release(first.lease);

      const second = await store.begin(target);

      await store.complete(first.lease, { body: { from: 'the stale lease' }, status: 200 });

      expect(second.outcome).toBe('acquired');
      await expect(store.begin(target)).resolves.toStrictEqual({ outcome: 'in-flight' });
    });

    it('refuses to release a slot another caller has taken over', async () => {
      const target = slot();
      const first = await store.begin(target);

      if (first.outcome !== 'acquired') {
        throw new Error('expected to acquire the slot');
      }

      await store.release(first.lease);
      await store.begin(target);
      await store.release(first.lease);

      await expect(store.begin(target)).resolves.toStrictEqual({ outcome: 'in-flight' });
    });

    it('keeps two namespaces apart, so the same key from two principals never collides', async () => {
      const key = newKey();
      const mine = slot({ key, namespace: 'anon' });
      const theirs = slot({ key, namespace: '22222222-2222-4222-8222-222222222222' });
      const begun = await store.begin(mine);

      if (begun.outcome !== 'acquired') {
        throw new Error('expected to acquire the slot');
      }

      await store.complete(begun.lease, { body: { secret: 'mine' }, status: 201 });

      const other = await store.begin(theirs);

      expect(other.outcome).toBe('acquired');
    });
  });
});
