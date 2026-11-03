import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { CLOCK, type ClockPort } from '../../../common/clock/clock.port';
import { SESSION_REDIS } from '../../../common/redis/redis.constants';
import type { Environment } from '../../../config/environment';
import { UNKNOWN_DEVICE_FIELD, type DeviceFingerprint } from '../device-fingerprint';

/** Session ids are `uuid` everywhere in the schema, so anything else is a bug, not a user. */
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 32 bytes, as §11 requires: far past any guessing budget, and short enough to be a cookie value. */
const TOKEN_BYTES = 32;

/**
 * A session identifier that came out of {@link SessionService}. Branded so that a string somebody
 * assembled cannot be written as one — the reverse direction, a token leaking into a DTO, is what
 * "the response body contains no token" is asserted for in `session.e2e-spec.ts`.
 */
export type SessionToken = string & { readonly __brand: 'SessionToken' };

/**
 * The principal the guard resolves, and the session it arrived on.
 *
 * `sessionId` is the *hash*, never the token: it identifies the session in the per-user index and
 * in a log line without being something that could be pasted back into a cookie.
 */
export interface AuthenticatedUser {
  readonly createdAt: string;
  readonly lastSeenAt: string;
  /**
   * True while the account's second factor is still owed (T21, criterion 4). The password was
   * accepted and nothing else has been; `SessionGuard` refuses a request carrying one of these, so
   * the only thing this session can do is answer the challenge.
   */
  readonly pendingMfa: boolean;
  readonly sessionId: string;
  /**
   * When this session last proved a second factor, or `null` for never — what `StepUpGuard` reads
   * (criterion 12). Per session rather than per account: a step-up on a laptop must not authorise
   * a sensitive change somebody is attempting from a phone.
   */
  readonly steppedUpAt: string | null;
  readonly userId: string;
}

/**
 * One session as its owner sees it in `GET /auth/sessions` (T18, criterion 6).
 *
 * Structurally the `SessionSummary` `@repo/contracts` publishes, and deliberately declared here
 * rather than imported from it: the service describes what it holds, and the controller is where
 * that becomes a wire format. What both agree on is the absence — no token, and no `sessionId`.
 */
export interface SessionSummary {
  readonly createdAt: string;
  readonly fingerprint: string;
  /** The uuid minted with the session. Never the hash — see {@link StoredSession.id}. */
  readonly id: string;
  readonly ip: string;
  readonly lastSeenAt: string;
  readonly userAgent: string;
}

/** What a caller may vary about a session it is starting. */
export interface SessionOptions {
  /** Start it half-authenticated, owing the second factor. */
  readonly pendingMfa?: boolean;
  /** Override the lifetime — the short window a challenge gets, rather than the full fortnight. */
  readonly ttlSeconds?: number;
}

/** What a caller needs to write the cookie, and nothing else. */
export interface IssuedSession {
  readonly token: SessionToken;
  readonly ttlSeconds: number;
}

/**
 * Where the guard parks the principal, and where `@CurrentUser()` reads it from.
 *
 * A symbol rather than the conventional `request.user` on purpose. Nothing here goes through
 * Passport (ADR 002), so no library is expecting that property; and a symbol-keyed value is
 * invisible to `JSON.stringify`, to pino's request serialiser and to anything else that walks the
 * request's own enumerable keys — so the principal cannot ride out in a log line or an error body.
 */
export const AUTHENTICATED_USER = Symbol('forge.identity.user');

/**
 * The Redis key holding one session. The argument is always a digest this module computed, which
 * is the whole point: the token itself is never a key, so a dump of the session instance yields
 * nothing that can be replayed.
 */
export function sessionKey(tokenHash: string): string {
  return `s:${tokenHash}`;
}

/**
 * The set of a user's live session hashes — the index T18 lists devices from and revokes through.
 * Without it, "sign out my other devices" would need a `SCAN` of the whole session keyspace, which
 * is the operation §09 rules out for exactly this instance.
 */
export function sessionIndexKey(userId: string): string {
  if (!USER_ID.test(userId)) {
    throw new TypeError(
      `invalid session index key: user id ${JSON.stringify(userId)} is not a uuid`,
    );
  }

  return `u:${userId}:s`;
}

/** The hash fields one session is stored as. Flat strings, because that is what Redis hashes hold. */
interface StoredSession {
  createdAt: string;
  /** The device fields §11 records for the session list. Absent on a session nobody described. */
  fingerprint?: string;
  /**
   * The name this session answers to in `GET /auth/sessions`, and the one a `DELETE` addresses it
   * by (T18).
   *
   * A uuid of its own rather than the hash the session is stored under, and the two are kept apart
   * on purpose. The hash *is* the Redis key: a client holding one is a client some later handler is
   * tempted to look a session up by directly, without the "and is this the caller's?" that makes
   * revoking another user's session a `404` instead of an oracle. This value means nothing outside
   * its owner's own index, which is exactly the authority a client needs to point at a row.
   *
   * It survives {@link rotate}, because `RENAME` moves the whole hash — so the identifier the
   * cookie carries changes on every sign-in and privilege change while the *device* keeps the name
   * the user was shown. A list whose rows renumbered themselves under the user would make "sign
   * this one out" point at something that had already moved.
   */
  id: string;
  ip?: string;
  lastSeenAt: string;
  /**
   * Present, and `'1'`, only while a second factor is owed. Absence rather than `'0'` is what makes
   * promotion an `HDEL` — a field that has to be rewritten to `'0'` is a field a partial write can
   * leave saying `'1'`, and that failure mode is a user locked out of their own session.
   */
  pendingMfa?: string;
  /** ISO 8601, written by {@link SessionService.recordStepUp}. Absent until the first step-up. */
  steppedUpAt?: string;
  userAgent?: string;
  userId: string;
}

/**
 * Server-side sessions in the `noeviction` Redis role §09 keeps apart from the cache — the whole of
 * ADR 001's "not JWTs" in one class.
 *
 * Three properties are structural rather than conventional:
 *
 * The cookie carries 32 opaque random bytes and **only the SHA-256 of those bytes is ever a Redis
 * key**. There is nothing in the store to steal: a hash cannot be pasted into a cookie, and the
 * lookup is a single `HGETALL` on a key the server derives, so hashing costs nothing on the request
 * path. SHA-256 rather than Argon2 because the input is 256 bits of `randomBytes`, not a password —
 * there is no dictionary to slow an attacker down against.
 *
 * The TTL **slides**: every authenticated request pushes the window back to the full
 * `SESSION_TTL_SECONDS`, so a session dies from disuse rather than from having started fourteen
 * days ago. This is also why the role matters. An `allkeys-lru` instance would evict a live session
 * under memory pressure, which is a user signed out for no reason they can see (§09).
 *
 * And the identifier **rotates** without the session ending — {@link rotate} — which is what
 * criterion 5 asks for on login and on privilege change, and what makes a token captured before a
 * privilege change useless after it.
 */
@Injectable()
export class SessionService {
  private readonly ttlSeconds: number;

  constructor(
    @Inject(SESSION_REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: ClockPort,
    config: ConfigService<Environment, true>,
  ) {
    this.ttlSeconds = config.get('SESSION_TTL_SECONDS', { infer: true });
  }

  /**
   * Start a session for a user who has just proved who they are.
   *
   * The device is optional because not every caller has a request to read one from, and a session
   * with an unknown device is better than a caller inventing one. `LoginService` always passes it:
   * §11 records a fingerprint at exactly this moment, and it is the only moment the request that
   * established the session is still in hand.
   */
  async create(
    userId: string,
    device?: DeviceFingerprint,
    options: SessionOptions = {},
  ): Promise<IssuedSession> {
    const index = sessionIndexKey(userId);
    const token = issueToken();
    const hash = hashToken(token);
    const now = this.clock.now().toISOString();
    // A pending session gets the caller's short window; everything else gets the configured
    // fortnight. `??` rather than a branch, so there is no path on which a half-authenticated
    // session quietly inherits the full one.
    const ttlSeconds = options.ttlSeconds ?? this.ttlSeconds;
    const record: StoredSession = {
      createdAt: now,
      // Minted here and nowhere else: a session acquires the name it will be listed under at the
      // moment it starts, so there is no session the device list cannot address.
      id: randomUUID(),
      lastSeenAt: now,
      userId,
      ...(device === undefined
        ? {}
        : { fingerprint: device.fingerprint, ip: device.ip, userAgent: device.userAgent }),
      ...(options.pendingMfa === true ? { pendingMfa: '1' } : {}),
    };

    await this.redis
      .multi()
      .hset(sessionKey(hash), record)
      .expire(sessionKey(hash), ttlSeconds)
      .sadd(index, hash)
      // The index is refreshed by every session the user has, so it expires with the last of them
      // rather than outliving them all as a list of devices that no longer exist.
      //
      // The *longer* of the two, so a pending session's five minutes cannot shorten the index that
      // the account's real sessions are listed and revoked through.
      .expire(index, Math.max(ttlSeconds, this.ttlSeconds))
      .exec();

    return { token, ttlSeconds };
  }

  /**
   * Resolve the token a request arrived with, and slide the window — the guard's one entry point.
   *
   * Renewal is part of resolving rather than a second call a caller could forget: a session that is
   * used daily and still expires on the fourteenth day is the bug, and it is invisible until the
   * fourteenth day.
   */
  async authenticate(token: string): Promise<AuthenticatedUser | null> {
    const hash = hashToken(token);
    const stored = await this.read(hash);

    if (stored === null) {
      return null;
    }

    const lastSeenAt = this.clock.now().toISOString();
    const pendingMfa = stored.pendingMfa === '1';
    const renewal = this.redis.multi().hset(sessionKey(hash), { lastSeenAt });

    // A pending session's window does not slide. Sliding it would let a caller hold a
    // half-authenticated cookie open indefinitely by poking the challenge route once a minute,
    // which is the opposite of "short-lived" — so the challenge gets the window it was given and
    // no more, and only a full session earns the renewal criterion 5 describes.
    if (!pendingMfa) {
      renewal
        .expire(sessionKey(hash), this.ttlSeconds)
        .expire(sessionIndexKey(stored.userId), this.ttlSeconds);
    }

    await renewal.exec();

    return {
      createdAt: stored.createdAt,
      lastSeenAt,
      pendingMfa,
      sessionId: hash,
      steppedUpAt: stored.steppedUpAt ?? null,
      userId: stored.userId,
    };
  }

  /**
   * Promote a session that has just presented its second factor (T21, criteria 4 and 5).
   *
   * The identifier rotates. §11 calls completing a challenge a privilege change, and the value the
   * client held while it could do nothing must not be the value it holds once it can do everything:
   * a cookie an attacker fixed on a shared machine before the challenge would otherwise still be a
   * live session after it. That is the whole reason this is not a flag flipped in place.
   *
   * The step-up stamp is written *before* the rotation rather than after, so it travels with the
   * hash `RENAME` moves — the factor just presented is exactly the proof `StepUpGuard` asks for, and
   * a caller who enrolled MFA should not have to present a second code to remove it a moment later.
   *
   * Answers `null` for a token that is not a pending session, which covers the two cases worth
   * refusing together: a challenge already answered — so this cannot mint a second session from the
   * same token — and a full session whose holder called the challenge route for a free rotation.
   */
  async completeMfa(token: string): Promise<IssuedSession | null> {
    const hash = hashToken(token);
    const stored = await this.read(hash);

    if (stored?.pendingMfa !== '1') {
      return null;
    }

    await this.redis
      .multi()
      .hset(sessionKey(hash), { steppedUpAt: this.clock.now().toISOString() })
      .hdel(sessionKey(hash), 'pendingMfa')
      .exec();

    return this.rotate(token);
  }

  /**
   * Record that this session has just re-proved a second factor (criterion 12).
   *
   * Keyed by the session *hash*, not the token, because the only caller is a guarded request
   * handler and the hash is what `SessionGuard` already resolved — the raw token never reaches a
   * service, which is the same reason {@link revokeAll} excepts by hash.
   *
   * The TTL is deliberately not touched. A step-up is a proof about an existing session, not a new
   * authentication, and extending the fortnight every time somebody typed a code would make the
   * session outlive the device it was established on.
   */
  async recordStepUp(sessionId: string): Promise<void> {
    await this.redis.hset(sessionKey(sessionId), {
      steppedUpAt: this.clock.now().toISOString(),
    });
  }

  /**
   * Give a live session a new identifier, keeping everything else about it.
   *
   * Called on authentication and on privilege change (§11, criterion 5). Both are moments where a
   * value the client already holds must stop being an answer: session fixation on the first, and a
   * token that was captured while the holder had fewer rights on the second.
   *
   * `RENAME` rather than a write-then-delete because it is atomic and preserves the hash exactly —
   * and because it *fails* on a key that has gone, which is the behaviour worth having. Writing the
   * new key first would resurrect a session that was revoked a moment ago.
   */
  async rotate(token: string): Promise<IssuedSession | null> {
    const hash = hashToken(token);
    const stored = await this.read(hash);

    if (stored === null) {
      return null;
    }

    const rotated = issueToken();
    const rotatedHash = hashToken(rotated);

    try {
      await this.redis.rename(sessionKey(hash), sessionKey(rotatedHash));
    } catch {
      // Revoked or expired between the read above and this line. The caller gets the same answer
      // it would have got a moment earlier, and nothing was created.
      return null;
    }

    const index = sessionIndexKey(stored.userId);

    await this.redis
      .multi()
      .expire(sessionKey(rotatedHash), this.ttlSeconds)
      .srem(index, hash)
      .sadd(index, rotatedHash)
      .expire(index, this.ttlSeconds)
      .exec();

    return { token: rotated, ttlSeconds: this.ttlSeconds };
  }

  /**
   * End one session now: `POST /auth/logout`, and what T18 revokes another device with.
   *
   * The key is deleted rather than expired, and the index entry goes with it — an index still
   * naming a dead session is a device T18 would list and could not revoke. Answering `false`
   * rather than throwing for a token that is not a session is what makes logging out twice, or
   * logging out with a cookie that expired while the page was open, a request that succeeded: the
   * session is gone either way, and that is all the caller asked for.
   */
  async revoke(token: string): Promise<boolean> {
    const hash = hashToken(token);
    const stored = await this.read(hash);

    if (stored === null) {
      return false;
    }

    await this.redis
      .multi()
      .del(sessionKey(hash))
      .srem(sessionIndexKey(stored.userId), hash)
      .exec();

    return true;
  }

  /**
   * The devices a user is signed in on (T18, criterion 6).
   *
   * Read from the per-user index and from nowhere else, which is what makes "only the caller's own
   * sessions" a property of the lookup rather than a filter applied to a wider one: the key is
   * derived from the user asked about, so there is no path on which another account's session could
   * be in the answer to be filtered out.
   *
   * Half-authenticated sessions are left out. One of those is a sign-in part way through a
   * challenge, not a device — it can do nothing but answer that challenge, it expires in minutes,
   * and listing it would offer the user a row whose only honest action is to wait.
   *
   * The order is the service's, because `SMEMBERS` has none: an unordered list would reshuffle
   * itself between two reads of the same screen. Newest sign-in first, tie-broken by id so the
   * order is total rather than merely mostly-stable.
   */
  async list(userId: string): Promise<SessionSummary[]> {
    const live = await this.readIndex(userId);

    return live
      .filter(({ stored }) => stored.pendingMfa !== '1')
      .map(({ stored }) => toSummary(stored))
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id),
      );
  }

  /**
   * End one of the caller's own sessions by the name the list gave it (T18, criterion 6).
   *
   * Takes the user as well as the id, and that pairing is the whole design. The search is confined
   * to this user's index, so a session belonging to somebody else is not *refused* — it is not
   * found, and is indistinguishable from an id that was never issued. There is deliberately no
   * branch here that knows an id exists but belongs elsewhere, because such a branch is what a
   * caller would time or count to turn this endpoint into a cross-user existence oracle. The
   * controller answers `false` with a `404` for the same reason.
   *
   * The key is deleted rather than expired, which is criterion 6's "within one request": the next
   * request that device makes finds nothing to authenticate against, rather than a session that
   * dies at the end of its TTL.
   */
  async revokeById(userId: string, id: string): Promise<boolean> {
    const found = (await this.readIndex(userId)).find(({ stored }) => stored.id === id);

    if (found === undefined) {
      return false;
    }

    await this.redis
      .multi()
      .del(sessionKey(found.hash))
      .srem(sessionIndexKey(userId), found.hash)
      .exec();

    return true;
  }

  /**
   * Every live session in a user's index, with the entries that no longer name one removed.
   *
   * The pruning is not housekeeping for its own sake. A session key expires on its own and its
   * index entry does not, so without this the list would show a device that {@link revokeById}
   * could not find — a row a user would click, and click again. Doing it on the read means the
   * repair happens exactly when somebody is looking.
   */
  private async readIndex(userId: string): Promise<{ hash: string; stored: StoredSession }[]> {
    const index = sessionIndexKey(userId);
    const hashes = await this.redis.smembers(index);

    if (hashes.length === 0) {
      return [];
    }

    const read = await Promise.all(hashes.map(async (hash) => this.read(hash)));
    const live: { hash: string; stored: StoredSession }[] = [];
    const stale: string[] = [];

    hashes.forEach((hash, at) => {
      const stored = read[at];

      if (stored === null || stored === undefined) {
        stale.push(hash);
      } else {
        live.push({ hash, stored });
      }
    });

    if (stale.length > 0) {
      await this.redis.srem(index, ...stale);
    }

    return live;
  }

  /**
   * End every session a user has — §11's "revoked wholesale on password reset or member removal",
   * and T19's criterion 7.
   *
   * `except` names a session by its **hash**, not by its token, because the only caller that keeps
   * one is a request handler and the hash is what `SessionGuard` already resolved for it. Password
   * change passes the caller's own session and stays signed in; password reset passes nothing, and
   * the session making the request dies with the rest — a reset that spared the requester's session
   * would spare the attacker's in exactly the case the revocation exists for.
   *
   * The index is the whole mechanism. `SCAN`ning the keyspace for a user's sessions is the operation
   * §09 rules out for this instance, and walking a list the caller supplied would miss the session
   * it does not know about, which is the one that matters.
   *
   * @returns how many sessions were ended, not counting the excepted one.
   */
  async revokeAll(userId: string, options: { except?: string } = {}): Promise<number> {
    const index = sessionIndexKey(userId);
    const hashes = await this.redis.smembers(index);
    const doomed = hashes.filter((hash) => hash !== options.except);

    if (doomed.length === 0) {
      return 0;
    }

    const transaction = this.redis.multi().del(...doomed.map((hash) => sessionKey(hash)));

    if (doomed.length === hashes.length) {
      // Nothing survives, so the index is deleted rather than emptied member by member: an empty
      // set is not a key Redis keeps, and `DEL` is one round trip instead of one per session.
      transaction.del(index);
    } else {
      transaction.srem(index, ...doomed);
    }

    await transaction.exec();

    return doomed.length;
  }

  /** `HGETALL` on a missing key is an empty object, not an error, so absence is a shape check. */
  private async read(hash: string): Promise<StoredSession | null> {
    const stored = await this.redis.hgetall(sessionKey(hash));

    if (
      typeof stored.userId !== 'string' ||
      typeof stored.createdAt !== 'string' ||
      typeof stored.id !== 'string' ||
      typeof stored.lastSeenAt !== 'string'
    ) {
      return null;
    }

    return {
      createdAt: stored.createdAt,
      id: stored.id,
      lastSeenAt: stored.lastSeenAt,
      userId: stored.userId,
      // Optional, so they are copied only when the hash actually carries them. `HGETALL` answers a
      // missing field with nothing at all, which is what makes absence the honest representation of
      // "never stepped up", of "owes no factor", and of a session nobody described a device for.
      ...(typeof stored.fingerprint === 'string' ? { fingerprint: stored.fingerprint } : {}),
      ...(typeof stored.ip === 'string' ? { ip: stored.ip } : {}),
      ...(typeof stored.pendingMfa === 'string' ? { pendingMfa: stored.pendingMfa } : {}),
      ...(typeof stored.steppedUpAt === 'string' ? { steppedUpAt: stored.steppedUpAt } : {}),
      ...(typeof stored.userAgent === 'string' ? { userAgent: stored.userAgent } : {}),
    };
  }
}

/** base64url so the value needs no quoting in a `Set-Cookie` header and no encoding in a log. */
function issueToken(): SessionToken {
  return randomBytes(TOKEN_BYTES).toString('base64url') as SessionToken;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * The stored session, reduced to what its owner may see.
 *
 * Written as an explicit construction rather than a spread with the secret members deleted: a
 * spread carries whatever is added to {@link StoredSession} next, and the field somebody adds next
 * is exactly the one that should not have travelled.
 *
 * The device fields fall back to the same `unknown` `deviceFingerprintOf` uses, so a session that
 * was started without a request to read one from is still a complete row rather than three empty
 * cells the contract would reject.
 */
function toSummary(stored: StoredSession): SessionSummary {
  return {
    createdAt: stored.createdAt,
    fingerprint: stored.fingerprint ?? UNKNOWN_DEVICE_FIELD,
    id: stored.id,
    ip: stored.ip ?? UNKNOWN_DEVICE_FIELD,
    lastSeenAt: stored.lastSeenAt,
    userAgent: stored.userAgent ?? UNKNOWN_DEVICE_FIELD,
  };
}
