import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';

import { CLOCK, type ClockPort } from '../clock/clock.port';
import { SESSION_REDIS } from '../redis/redis.constants';
import {
  type ThrottleDecision,
  type ThrottlePolicy,
  type ThrottleState,
  evaluate,
  failureCeiling,
} from './progressive-delay';

/**
 * The buckets that exist. Closed, like `problem-types.ts` and `audit-actions.ts`, because a scope
 * is a Redis key prefix: a typo'd string is a bucket nobody reads and a limit that never fires.
 */
export type ThrottleScope =
  | 'login-account'
  | 'login-ip'
  | 'password-reset-account'
  | 'password-reset-ip'
  | 'verification-resend-account'
  | 'verification-resend-ip';

/** One bucket an attempt is weighed against: where the record lives, and the rules it lives by. */
export interface ThrottleBucket {
  readonly key: string;
  readonly policy: ThrottlePolicy;
}

/**
 * The Redis key one identifier's record lives at.
 *
 * `t:` keeps throttle records visibly apart from `s:` sessions and `u:` session indexes in the same
 * instance (§09 puts rate-limit counters here, alongside sessions and deliberately not in the
 * evictable cache — an `allkeys-lru` instance would drop the record of an attack under memory
 * pressure, which is the moment it is most worth having).
 *
 * The identifier is whatever the caller hands over, and callers hand over a digest for anything
 * that names a person: `LoginService` hashes the address, so a dump of this instance is not a list
 * of the addresses somebody has been guessing passwords for.
 */
export function throttleKey(scope: ThrottleScope, identifier: string): string {
  return `t:${scope}:${identifier}`;
}

/**
 * Records a failure atomically, and lengthens the record's own expiry to match.
 *
 * In Lua because the alternative is a read, some arithmetic in Node, and a write — which counts ten
 * simultaneous failures as one, and ten simultaneous failures is the shape of the attack this
 * bucket exists to notice.
 *
 * Only the *storage* arithmetic is here: decay one failure per interval, add one, clamp at the
 * ceiling. The part worth reasoning about — how long a count is made to wait, and why that is
 * bounded — stays in `progressive-delay.ts`, where a test drives it through five hundred failures
 * without a Redis. `now` arrives as an argument rather than from `redis.call('TIME')` so the script
 * is deterministic, and so a fake clock reaches it (spec 001: no `new Date()` in a service).
 */
const PENALISE = `
local stored = redis.call('HMGET', KEYS[1], 'failures', 'lastFailureAt')
local now = tonumber(ARGV[1])
local decayMs = tonumber(ARGV[2])
local ceiling = tonumber(ARGV[3])
local failures = tonumber(stored[1]) or 0
local lastFailureAt = tonumber(stored[2]) or now
local elapsed = now - lastFailureAt

if elapsed < 0 then elapsed = 0 end

failures = failures - math.floor(elapsed / decayMs)

if failures < 0 then failures = 0 end

failures = failures + 1

if failures > ceiling then failures = ceiling end

redis.call('HSET', KEYS[1], 'failures', failures, 'lastFailureAt', now)
redis.call('PEXPIRE', KEYS[1], (failures + 1) * decayMs)

return failures
`;

/**
 * Where the per-account and per-IP token buckets live: the session Redis role, so that a limit is
 * the fleet's and not one process's.
 *
 * An in-memory counter is the same code with a hole in it — three API nodes behind the edge means
 * three separate budgets, and the attacker gets all three. §14 puts the limit at the API layer for
 * fairness and gives auth endpoints a much tighter bucket than reads; this is that bucket's store.
 */
@Injectable()
export class RedisThrottleStorage {
  constructor(
    @Inject(SESSION_REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  /**
   * The decision an attempt gets, across every bucket it belongs to.
   *
   * The strictest bucket wins: an address behind a shared NAT that has exhausted its own budget
   * does not get to spend the account's, and an account under a distributed guessing attack is not
   * rescued by each individual address looking innocent.
   */
  async check(buckets: readonly ThrottleBucket[]): Promise<ThrottleDecision> {
    const now = this.clock.now().getTime();
    const decisions = await Promise.all(
      buckets.map(async (bucket) => evaluate(await this.read(bucket.key), now, bucket.policy)),
    );

    return decisions.reduce(strictest, { allowed: true, failures: 0, retryAfterSeconds: 0 });
  }

  /** Charge one failure to every bucket the attempt belonged to. */
  async penalise(buckets: readonly ThrottleBucket[]): Promise<void> {
    const now = this.clock.now().getTime();

    await Promise.all(
      buckets.map(async (bucket) =>
        this.redis.eval(
          PENALISE,
          1,
          bucket.key,
          now,
          bucket.policy.decaySeconds * 1_000,
          failureCeiling(bucket.policy),
        ),
      ),
    );
  }

  /** Drop the records outright: the caller proved who they are, so the near misses were noise. */
  async forget(buckets: readonly ThrottleBucket[]): Promise<void> {
    if (buckets.length === 0) {
      return;
    }

    await this.redis.del(...buckets.map((bucket) => bucket.key));
  }

  /**
   * A record Redis cannot be made to hold is no record at all.
   *
   * Failing open here rather than throwing: the alternative turns one unreadable key into a 500 on
   * every sign-in attempt by that account, which is an outage of the endpoint caused by the code
   * that was supposed to protect it. `HGETALL` on a missing key is an empty object, so absence and
   * corruption arrive the same way and are answered the same way.
   */
  private async read(key: string): Promise<ThrottleState | null> {
    const stored = await this.redis.hgetall(key);
    const failures = Number(stored.failures);
    const lastFailureAt = Number(stored.lastFailureAt);

    if (!Number.isFinite(failures) || !Number.isFinite(lastFailureAt) || failures <= 0) {
      return null;
    }

    return { failures, lastFailureAt };
  }
}

/**
 * Fold two decisions into the one the caller is answered with. `failures` follows the bucket that
 * decided the outcome, so a log line about a refusal names the count that caused it.
 */
function strictest(left: ThrottleDecision, right: ThrottleDecision): ThrottleDecision {
  if (left.retryAfterSeconds >= right.retryAfterSeconds && !left.allowed) {
    return left;
  }

  if (!right.allowed) {
    return right;
  }

  return left.failures >= right.failures ? left : right;
}
