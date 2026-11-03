import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { CLOCK, type ClockPort } from '../clock/clock.port';
import { SESSION_REDIS } from '../redis/redis.constants';

/**
 * §14: the key plus a hash of the body is stored "for 24h". The window is anchored on the instant
 * the request was *received*, not on the instant it completed — see {@link IdempotencyStore.complete}.
 */
export const RECORD_TTL_MS = 24 * 60 * 60 * 1_000;

/**
 * How long one in-flight request may hold a key before the slot heals itself.
 *
 * Far shorter than the record, and deliberately so. A process killed between acquiring the slot and
 * writing the response never runs its release, so the only thing that frees the key is this TTL —
 * and freeing it a day later would mean one crash costs a client that key until tomorrow, while it
 * is told, truthfully but uselessly, that its request is still in flight.
 */
export const LEASE_TTL_MS = 60_000;

/** The same alphabet `idempotencyKeySchema` publishes: RFC 3986 unreserved, and notably no `:`. */
const SEGMENT = /^[A-Za-z0-9._~-]+$/;

/** What a completed request left behind, and the whole of what a replay reproduces. */
export interface IdempotencyRecord {
  readonly body: unknown;
  /**
   * The status on the response object when the handler resolved.
   *
   * For an ordinary handler this is the platform default and Nest overwrites it, identically, on
   * both the original request and the replay. For a handler holding `@Res({ passthrough: true })`
   * it is the status that handler chose, which Nest leaves alone — and which would otherwise be
   * lost on the replay.
   */
  readonly status: number;
}

/** Proof that this caller, and not one that took the slot over, still owns the in-flight record. */
export interface IdempotencyLease {
  /** Epoch milliseconds at which the 24 h record window closes. */
  readonly expiresAt: number;
  readonly fingerprint: string;
  /** The Redis key. */
  readonly key: string;
  /**
   * The exact string written when the slot was acquired. It carries a nonce, so byte-equality with
   * what is in Redis now is the ownership test — the fencing token, kept whole rather than parsed.
   */
  readonly pending: string;
}

export interface IdempotencySlot {
  readonly fingerprint: string;
  readonly key: string;
  /** The principal the key belongs to. Two principals never share a slot. */
  readonly namespace: string;
}

export type IdempotencyOutcome =
  | { readonly lease: IdempotencyLease; readonly outcome: 'acquired' }
  | { readonly outcome: 'in-flight' }
  | { readonly outcome: 'mismatch' }
  | { readonly outcome: 'replay'; readonly record: IdempotencyRecord };

/**
 * The Redis key holding one idempotency record.
 *
 * The namespace comes first and the client's key second, which is what makes a replay slot private
 * to one principal: without it, a caller who learned another caller's key — and could reproduce the
 * request that goes with it — would be handed that caller's response. `:` is the delimiter and is
 * excluded from both segments, so `i:a:b:c` cannot be read two ways and a crafted key cannot
 * address a slot that is not its own.
 */
export function idempotencyRecordKey(namespace: string, key: string): string {
  if (!SEGMENT.test(namespace)) {
    throw new TypeError(
      `invalid idempotency namespace: ${JSON.stringify(namespace)} must match ${SEGMENT.source}`,
    );
  }

  if (!SEGMENT.test(key)) {
    throw new TypeError(
      `invalid idempotency key: ${JSON.stringify(key)} must match ${SEGMENT.source}`,
    );
  }

  return `i:${namespace}:${key}`;
}

const storedRecordSchema = z.discriminatedUnion('state', [
  z.object({
    expiresAt: z.number(),
    fingerprint: z.string(),
    state: z.literal('pending'),
    token: z.string(),
  }),
  z.object({
    body: z.unknown(),
    expiresAt: z.number(),
    fingerprint: z.string(),
    state: z.literal('done'),
    status: z.number(),
  }),
]);

/**
 * Write the completed response over the slot this caller still holds, or do nothing.
 *
 * Conditional, because the lease can expire under a request that is slower than it: another caller
 * then legitimately owns the key, and an unconditional write would record this caller's response
 * against the other one's request.
 */
const COMPLETE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
  return 1
end
return 0
`;

/** The same ownership test, for the failure path: free the slot only if it is still ours. */
const RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/**
 * The 24 h replay record §14 requires, on the `noeviction` Redis role.
 *
 * The session instance rather than the cache one, and that is not a preference. §09 puts the cache
 * under `allkeys-lru`, where an entry is discarded whenever memory is tight — and a discarded
 * idempotency record is not a cache miss that Postgres can rebuild, it is a second execution of a
 * request the client was promised would happen once. Memory pressure would turn double-charges on.
 *
 * The record is one Redis string in two states, never two keys. A key that exists is either held by
 * a request in flight or holds that request's response, and `SET … NX GET` moves between the two in
 * a single round trip — so a second caller arriving mid-flight cannot observe a gap in which the
 * slot looks free.
 */
@Injectable()
export class IdempotencyStore {
  constructor(
    @Inject(SESSION_REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  /**
   * Claim the slot for this request, or say what the caller holding it is doing.
   *
   * `SET key value NX GET PX` is one command that both reserves and reports: it writes only when the
   * key is absent and returns whatever was there instead. Doing it as `GET` then `SET NX` would
   * leave a window between the two in which a concurrent request sees nothing and both proceed —
   * which is the exact failure this task exists to prevent.
   */
  async begin(slot: IdempotencySlot): Promise<IdempotencyOutcome> {
    const key = idempotencyRecordKey(slot.namespace, slot.key);
    const expiresAt = this.clock.now().getTime() + RECORD_TTL_MS;
    const pending = JSON.stringify({
      expiresAt,
      fingerprint: slot.fingerprint,
      state: 'pending',
      // Distinguishes two leases on the same key with the same fingerprint, so a caller whose lease
      // has expired cannot pass the ownership test against its successor's record.
      token: randomUUID(),
    });
    const previous = await this.redis.set(key, pending, 'PX', LEASE_TTL_MS, 'NX', 'GET');

    if (previous === null) {
      return {
        lease: { expiresAt, fingerprint: slot.fingerprint, key, pending },
        outcome: 'acquired',
      };
    }

    return classify(previous, slot.fingerprint);
  }

  /**
   * Record the response, keeping the deadline the request was received with.
   *
   * The remaining TTL is computed from {@link IdempotencyLease.expiresAt} rather than reset to 24 h,
   * so the promise is "replayable for 24 h from when you asked" and not "for 24 h plus however long
   * the handler took" — which for a slow handler is a window nobody specified.
   */
  async complete(lease: IdempotencyLease, record: IdempotencyRecord): Promise<void> {
    const done = JSON.stringify({
      body: record.body,
      expiresAt: lease.expiresAt,
      fingerprint: lease.fingerprint,
      state: 'done',
      status: record.status,
    });
    // Floored at 1 ms because Redis rejects a non-positive `PX`, and a record whose window has
    // already closed is one that should expire immediately rather than one that fails to write.
    const remaining = Math.max(1, lease.expiresAt - this.clock.now().getTime());

    await this.redis.eval(COMPLETE, 1, lease.key, lease.pending, done, String(remaining));
  }

  /**
   * Give the slot back after a request that failed.
   *
   * A failed request did not happen, so its key has to be usable again: keeping it would mean one
   * transient 500 costs the client that key for a day, and the retry every HTTP client makes on a
   * 5xx would be refused for a request that never took effect.
   */
  async release(lease: IdempotencyLease): Promise<void> {
    await this.redis.eval(RELEASE, 1, lease.key, lease.pending);
  }
}

/**
 * The fingerprint is compared before the state, so "same key, different request" is a mismatch even
 * while the first one is still running — the client's bug is the same bug either way, and waiting
 * for a response it can never be given would only delay the 409.
 */
function classify(raw: string, fingerprint: string): IdempotencyOutcome {
  const parsed = storedRecordSchema.safeParse(parseJson(raw));

  // A record this version cannot read is not one it may overwrite: some other writer owns the key.
  if (!parsed.success || parsed.data.fingerprint !== fingerprint) {
    return { outcome: 'mismatch' };
  }

  if (parsed.data.state === 'pending') {
    return { outcome: 'in-flight' };
  }

  return { outcome: 'replay', record: { body: parsed.data.body, status: parsed.data.status } };
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
