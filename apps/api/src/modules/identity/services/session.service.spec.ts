import { ConfigModule } from '@nestjs/config';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import type { Redis } from 'ioredis';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';

import { openClient } from '../../../../test/support/integration-redis';
import { ClockModule } from '../../../common/clock/clock.module';
import { CLOCK } from '../../../common/clock/clock.port';
import { FakeClock } from '../../../common/clock/fake-clock';
import { SESSION_REDIS } from '../../../common/redis/redis.constants';
import { RedisModule } from '../../../common/redis/redis.module';
import { validateEnvironment } from '../../../config/environment';
import { deviceFingerprintOf } from '../device-fingerprint';
import { SessionService, sessionIndexKey, sessionKey } from './session.service';

/**
 * A TTL short enough to read at a glance and long enough that nothing expires mid-suite. Set above
 * the import block because `ConfigModule.forRoot` validates the environment while the module graph
 * is being built, which is earlier than any `beforeAll`.
 */
const TTL_SECONDS = 900;

vi.hoisted(() => {
  process.env.SESSION_TTL_SECONDS = '900';
});

const reachable = inject('redisReachable');
const START = '2026-08-16T10:00:00.000Z';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('SessionService', () => {
  /**
   * Against the real session instance, not a fake. Every claim T15 makes is a claim about which
   * Redis keys exist and what their TTLs are — "only the hash is a key", "the TTL slides", "the old
   * identifier stops working" — and a stub would answer all three from the code under test.
   */
  describe.skipIf(!reachable)('against the session Redis role', () => {
    let moduleRef: TestingModule;
    let sessions: SessionService;
    let redis: Redis;
    let probe: Redis;
    let clock: FakeClock;
    const written: string[] = [];

    /** Track every key the test touches so the shared instance is left as it was found. */
    function track(...keys: string[]): void {
      written.push(...keys);
    }

    async function establish(userId: string): Promise<string> {
      const { token } = await sessions.create(userId);

      track(sessionKey(sha256(token)), sessionIndexKey(userId));

      return token;
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
          ClockModule,
          RedisModule,
        ],
        providers: [SessionService],
      })
        .overrideProvider(CLOCK)
        .useValue(clock)
        .compile();

      sessions = moduleRef.get(SessionService);
      redis = moduleRef.get<Redis>(SESSION_REDIS);
      probe = openClient(process.env.REDIS_SESSION_URL!);
      await probe.connect();
    });

    afterEach(async () => {
      if (written.length > 0) {
        await redis.del(...written);
        written.length = 0;
      }

      clock.set(START);
    });

    afterAll(async () => {
      probe.disconnect();
      await moduleRef.close();
    });

    describe('create', () => {
      it('issues a token with 32 bytes of entropy, base64url encoded', async () => {
        const token = await establish(randomUUID());

        // 32 bytes is 43 base64url characters without padding, and base64url so the value survives
        // a `Set-Cookie` header without quoting.
        expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      });

      it('never issues the same token twice', async () => {
        const user = randomUUID();
        const tokens = await Promise.all(Array.from({ length: 25 }, () => establish(user)));

        expect(new Set(tokens).size).toBe(tokens.length);
      });

      /**
       * The whole point of hashing. Somebody who can read the session instance — a replica, an
       * `AOF` file, a support console — gets hashes, and a hash cannot be pasted into a cookie.
       */
      it('stores the session under the hash of the token, never under the token', async () => {
        const token = await establish(randomUUID());

        await expect(redis.exists(sessionKey(sha256(token)))).resolves.toBe(1);
        await expect(redis.exists(sessionKey(token))).resolves.toBe(0);
        await expect(redis.exists(token)).resolves.toBe(0);
      });

      /** A hash of the token is not a hash if the token is recoverable from what is stored. */
      it('stores nothing that contains the token itself', async () => {
        const token = await establish(randomUUID());
        const stored = await redis.hgetall(sessionKey(sha256(token)));

        expect(JSON.stringify(stored)).not.toContain(token);
      });

      it('gives the session the configured TTL', async () => {
        const token = await establish(randomUUID());

        await expect(redis.ttl(sessionKey(sha256(token)))).resolves.toBe(TTL_SECONDS);
      });

      it('stamps the session from the injected clock, not the host clock', async () => {
        const token = await establish(randomUUID());
        const session = await sessions.authenticate(token);

        expect(session).toMatchObject({ createdAt: START, lastSeenAt: START });
      });

      /**
       * The index T18 lists and revokes through. Without it, "sign out every other device" would
       * need a `SCAN` of the whole session keyspace to find out which sessions are whose.
       */
      it('adds the hash to the per-user session index', async () => {
        const user = randomUUID();
        const first = await establish(user);
        const second = await establish(user);

        await expect(redis.smembers(sessionIndexKey(user))).resolves.toEqual(
          expect.arrayContaining([sha256(first), sha256(second)]),
        );
      });

      /** An index that outlives its members is a list of sessions that no longer exist. */
      it('gives the index a TTL too', async () => {
        const user = randomUUID();

        await establish(user);

        await expect(redis.ttl(sessionIndexKey(user))).resolves.toBe(TTL_SECONDS);
      });
    });

    describe('authenticate', () => {
      it('resolves the user the session belongs to', async () => {
        const user = randomUUID();
        const token = await establish(user);

        await expect(sessions.authenticate(token)).resolves.toMatchObject({
          sessionId: sha256(token),
          userId: user,
        });
      });

      it('returns null for a token that was never issued', async () => {
        await expect(sessions.authenticate('not-a-session-token')).resolves.toBeNull();
      });

      it('returns null for a token whose session has been dropped from Redis', async () => {
        const token = await establish(randomUUID());

        await redis.del(sessionKey(sha256(token)));

        await expect(sessions.authenticate(token)).resolves.toBeNull();
      });

      /**
       * Sliding renewal, and the reason it is asserted through a TTL somebody else shortened: a
       * session that is used every day must not expire on the fourteenth, and a `create` that sets
       * the TTL once would pass every other test in this file.
       */
      it('slides the TTL back to the full window on use', async () => {
        const token = await establish(randomUUID());
        const key = sessionKey(sha256(token));

        await redis.expire(key, 30);
        await expect(redis.ttl(key)).resolves.toBe(30);

        await sessions.authenticate(token);

        await expect(redis.ttl(key)).resolves.toBe(TTL_SECONDS);
      });

      it('slides the index TTL with it, so the index outlives none of its sessions', async () => {
        const user = randomUUID();
        const token = await establish(user);

        await redis.expire(sessionIndexKey(user), 30);
        await sessions.authenticate(token);

        await expect(redis.ttl(sessionIndexKey(user))).resolves.toBe(TTL_SECONDS);
      });

      it('records when the session was last seen', async () => {
        const token = await establish(randomUUID());

        clock.advance(60_000);
        const session = await sessions.authenticate(token);

        expect(session).toMatchObject({
          createdAt: START,
          lastSeenAt: '2026-08-16T10:01:00.000Z',
        });
      });
    });

    describe('rotate', () => {
      /** Criterion 5, and the half of it that is not about restarts. */
      it('issues a different identifier for the same session', async () => {
        const token = await establish(randomUUID());
        const rotated = await sessions.rotate(token);

        expect(rotated?.token).toBeDefined();
        expect(rotated?.token).not.toBe(token);
        track(sessionKey(sha256(rotated!.token)));
      });

      it('retires the old identifier immediately', async () => {
        const token = await establish(randomUUID());
        const rotated = await sessions.rotate(token);
        track(sessionKey(sha256(rotated!.token)));

        await expect(sessions.authenticate(token)).resolves.toBeNull();
        await expect(redis.exists(sessionKey(sha256(token)))).resolves.toBe(0);
      });

      it('keeps the same user and the original creation time', async () => {
        const user = randomUUID();
        const token = await establish(user);

        clock.advance(3_600_000);
        const rotated = await sessions.rotate(token);
        track(sessionKey(sha256(rotated!.token)));

        await expect(sessions.authenticate(rotated!.token)).resolves.toMatchObject({
          createdAt: START,
          userId: user,
        });
      });

      it('swaps the hash in the per-user index rather than leaving both', async () => {
        const user = randomUUID();
        const token = await establish(user);
        const rotated = await sessions.rotate(token);
        track(sessionKey(sha256(rotated!.token)));

        await expect(redis.smembers(sessionIndexKey(user))).resolves.toEqual([
          sha256(rotated!.token),
        ]);
      });

      it('renews the TTL, because a rotation is a fresh authentication', async () => {
        const token = await establish(randomUUID());

        await redis.expire(sessionKey(sha256(token)), 30);
        const rotated = await sessions.rotate(token);
        track(sessionKey(sha256(rotated!.token)));

        await expect(redis.ttl(sessionKey(sha256(rotated!.token)))).resolves.toBe(TTL_SECONDS);
      });

      it('returns null for a token that was never issued, and creates nothing', async () => {
        await expect(sessions.rotate('not-a-session-token')).resolves.toBeNull();
        await expect(redis.exists(sessionKey(sha256('not-a-session-token')))).resolves.toBe(0);
      });
    });

    /**
     * The half-authenticated state a sign-in stops in when the account has a second factor (T21,
     * criterion 4). The password was right; nothing else has been proved yet.
     */
    describe('a session awaiting its second factor', () => {
      async function establishPending(userId: string, ttlSeconds = 300): Promise<string> {
        const { token } = await sessions.create(userId, undefined, {
          pendingMfa: true,
          ttlSeconds,
        });

        track(sessionKey(sha256(token)), sessionIndexKey(userId));

        return token;
      }

      it('resolves, and says it is still owed a factor', async () => {
        const user = randomUUID();
        const token = await establishPending(user);

        await expect(sessions.authenticate(token)).resolves.toMatchObject({
          pendingMfa: true,
          userId: user,
        });
      });

      /** An ordinary sign-in must not look like one of these, or the guard would refuse everybody. */
      it('is distinguishable from a session that owes nothing', async () => {
        const token = await establish(randomUUID());

        await expect(sessions.authenticate(token)).resolves.toMatchObject({ pendingMfa: false });
      });

      /**
       * Minutes, not a fortnight. This cookie is the whole of an attacker's handle on the challenge,
       * and giving it the full session lifetime would leave a half-authenticated credential lying
       * around for two weeks after somebody abandoned a sign-in.
       */
      it('expires on the short window the challenge is given, not the session TTL', async () => {
        const token = await establishPending(randomUUID(), 120);

        await expect(redis.ttl(sessionKey(sha256(token)))).resolves.toBe(120);
      });

      /**
       * §11 calls completing a challenge a privilege change, and criterion 5 rotates the identifier
       * on one. The value the client held while it could do nothing must not be the value it holds
       * once it can do everything — otherwise anyone who fixed that cookie before the challenge
       * still holds a live session after it.
       */
      it('gets a new identifier when the factor is presented', async () => {
        const token = await establishPending(randomUUID());
        const promoted = await sessions.completeMfa(token);

        expect(promoted?.token).toBeDefined();
        expect(promoted?.token).not.toBe(token);
        track(sessionKey(sha256(promoted!.token)));

        await expect(sessions.authenticate(token)).resolves.toBeNull();
        await expect(redis.exists(sessionKey(sha256(token)))).resolves.toBe(0);
      });

      it('stops being pending once it has been promoted', async () => {
        const user = randomUUID();
        const token = await establishPending(user);
        const promoted = await sessions.completeMfa(token);
        track(sessionKey(sha256(promoted!.token)));

        await expect(sessions.authenticate(promoted!.token)).resolves.toMatchObject({
          pendingMfa: false,
          userId: user,
        });
      });

      /** Promotion is a full authentication, so the fortnight starts here rather than at the login. */
      it('is given the full session TTL on promotion', async () => {
        const token = await establishPending(randomUUID(), 120);
        const promoted = await sessions.completeMfa(token);
        track(sessionKey(sha256(promoted!.token)));

        await expect(redis.ttl(sessionKey(sha256(promoted!.token)))).resolves.toBe(TTL_SECONDS);
      });

      /**
       * Single use, in the only sense that matters: the token the challenge was answered with is
       * gone, so answering twice with it cannot mint a second session.
       */
      it('cannot be promoted twice', async () => {
        const token = await establishPending(randomUUID());
        const promoted = await sessions.completeMfa(token);
        track(sessionKey(sha256(promoted!.token)));

        await expect(sessions.completeMfa(token)).resolves.toBeNull();
      });

      /**
       * And a session that never owed a factor cannot be promoted at all. Without this, any
       * signed-in caller could POST to the challenge route and have their identifier rotated for
       * free — harmless on its own, and exactly the sort of state machine that grows a hole later.
       */
      it('refuses to promote a session that was never pending', async () => {
        const token = await establish(randomUUID());

        await expect(sessions.completeMfa(token)).resolves.toBeNull();
        await expect(sessions.authenticate(token)).resolves.toMatchObject({ pendingMfa: false });
      });
    });

    /**
     * Step-up (T21, criterion 12): a second factor presented *recently*, recorded on the session so
     * a guard can ask how long ago it was.
     */
    describe('the step-up stamp', () => {
      it('is absent on a session nobody stepped up', async () => {
        const token = await establish(randomUUID());

        await expect(sessions.authenticate(token)).resolves.toMatchObject({ steppedUpAt: null });
      });

      it('records the instant from the injected clock', async () => {
        const token = await establish(randomUUID());

        clock.advance(60_000);
        await sessions.recordStepUp(sha256(token));

        await expect(sessions.authenticate(token)).resolves.toMatchObject({
          steppedUpAt: new Date(Date.parse(START) + 60_000).toISOString(),
        });
      });

      /**
       * The stamp is per session, not per account. A step-up performed on a laptop must not
       * authorise the sensitive change somebody else is attempting from a phone.
       */
      it('does not reach the account’s other sessions', async () => {
        const user = randomUUID();
        const stepped = await establish(user);
        const other = await establish(user);

        await sessions.recordStepUp(sha256(stepped));

        await expect(sessions.authenticate(other)).resolves.toMatchObject({ steppedUpAt: null });
      });

      /** Rotation carries it, because the promotion that rotates *is* the proof it records. */
      it('survives the rotation that promotes the session', async () => {
        const { token } = await sessions.create(randomUUID(), undefined, {
          pendingMfa: true,
          ttlSeconds: 300,
        });
        track(sessionKey(sha256(token)));

        await sessions.recordStepUp(sha256(token));

        const promoted = await sessions.completeMfa(token);
        track(sessionKey(sha256(promoted!.token)));

        await expect(sessions.authenticate(promoted!.token)).resolves.toMatchObject({
          steppedUpAt: START,
        });
      });
    });

    /**
     * The device a session was established from (§11), stored beside it so T18 can render a list a
     * user can recognise their own devices in — and, more to the point, one they can spot a device
     * they do not recognise in.
     */
    describe('the device a session belongs to', () => {
      const DEVICE = deviceFingerprintOf({ ip: '203.0.113.7', userAgent: 'curl/8.4.0' });

      it('records the address, the agent and the fingerprint', async () => {
        const { token } = await sessions.create(randomUUID(), DEVICE);

        track(sessionKey(sha256(token)));

        await expect(redis.hgetall(sessionKey(sha256(token)))).resolves.toMatchObject({
          fingerprint: DEVICE.fingerprint,
          ip: '203.0.113.7',
          userAgent: 'curl/8.4.0',
        });
      });

      /** A rotation is the same session on the same device. Losing the device on rotation would
       * empty the session list every time a privilege changed. */
      it('survives a rotation', async () => {
        const { token } = await sessions.create(randomUUID(), DEVICE);
        const rotated = await sessions.rotate(token);

        track(sessionKey(sha256(token)), sessionKey(sha256(rotated!.token)));

        await expect(redis.hgetall(sessionKey(sha256(rotated!.token)))).resolves.toMatchObject({
          fingerprint: DEVICE.fingerprint,
        });
      });

      it('is optional, because not every caller has a request to read one from', async () => {
        const { token } = await sessions.create(randomUUID());

        track(sessionKey(sha256(token)));

        await expect(sessions.authenticate(token)).resolves.not.toBeNull();
      });
    });

    /**
     * What `POST /auth/logout` does, and what T18's remote revocation will do to somebody else's
     * session. Revocation has to be immediate and complete — the reason ADR 001 rejected JWTs.
     */
    describe('revoke', () => {
      it('stops the token authenticating, in the same request', async () => {
        const token = await establish(randomUUID());

        await expect(sessions.revoke(token)).resolves.toBe(true);
        await expect(sessions.authenticate(token)).resolves.toBeNull();
      });

      it('deletes the session key rather than leaving it to expire', async () => {
        const token = await establish(randomUUID());

        await sessions.revoke(token);

        await expect(redis.exists(sessionKey(sha256(token)))).resolves.toBe(0);
      });

      /** An index still naming a dead session is a device T18 would list and could not revoke. */
      it('takes the session out of the user index', async () => {
        const user = randomUUID();
        const kept = await establish(user);
        const revoked = await establish(user);

        await sessions.revoke(revoked);

        await expect(redis.smembers(sessionIndexKey(user))).resolves.toEqual([sha256(kept)]);
      });

      it('leaves the user signed in everywhere else', async () => {
        const user = randomUUID();
        const kept = await establish(user);
        const revoked = await establish(user);

        await sessions.revoke(revoked);

        await expect(sessions.authenticate(kept)).resolves.toMatchObject({ userId: user });
      });

      /**
       * Logging out twice, or logging out with a cookie that expired while the page was open, is a
       * request that succeeded from the caller's point of view: the session is gone either way.
       */
      it('answers false for a token that was never a session, and throws nothing', async () => {
        await expect(sessions.revoke('not-a-session-token')).resolves.toBe(false);
      });
    });

    /**
     * What §11 means by "revoked wholesale on password reset or member removal" — and the reason
     * `revoke` on its own is not enough for T19. A reset that walked the sessions it happened to
     * know about would leave the ones it did not, and the one it did not is the attacker's.
     *
     * Every claim here is checked against Redis rather than against the return value, because the
     * return value is this class's own account of what it did and the keys are what the guard reads.
     */
    describe('revokeAll', () => {
      it('ends every session the user has', async () => {
        const user = randomUUID();
        const tokens = [await establish(user), await establish(user), await establish(user)];

        await sessions.revokeAll(user);

        for (const token of tokens) {
          await expect(sessions.authenticate(token)).resolves.toBeNull();
        }
      });

      it('deletes the session keys rather than leaving them to expire', async () => {
        const user = randomUUID();
        const token = await establish(user);

        await sessions.revokeAll(user);

        await expect(redis.exists(sessionKey(sha256(token)))).resolves.toBe(0);
      });

      /** An index still naming dead sessions is a device list T18 would show and could not revoke. */
      it('leaves no index behind naming sessions that are gone', async () => {
        const user = randomUUID();

        await establish(user);
        await establish(user);

        await sessions.revokeAll(user);

        await expect(redis.smembers(sessionIndexKey(user))).resolves.toEqual([]);
      });

      it('answers how many it ended, so a caller can log the size of the revocation', async () => {
        const user = randomUUID();

        await establish(user);
        await establish(user);

        await expect(sessions.revokeAll(user)).resolves.toBe(2);
      });

      it('touches nobody else', async () => {
        const user = randomUUID();
        const bystander = randomUUID();

        await establish(user);
        const theirs = await establish(bystander);

        await sessions.revokeAll(user);

        await expect(sessions.authenticate(theirs)).resolves.toMatchObject({ userId: bystander });
      });

      it('is a no-op for a user with no sessions, and throws nothing', async () => {
        await expect(sessions.revokeAll(randomUUID())).resolves.toBe(0);
      });

      /**
       * The password *change* half of criterion 7: every **other** session dies and the caller stays
       * signed in. Keyed on the session hash rather than the token, because the hash is what the
       * guard resolved and the token is the one thing a request handler never has to be trusted with.
       */
      describe('with a session excepted', () => {
        it('keeps the excepted session alive', async () => {
          const user = randomUUID();
          const kept = await establish(user);

          await establish(user);
          await sessions.revokeAll(user, { except: sha256(kept) });

          await expect(sessions.authenticate(kept)).resolves.toMatchObject({ userId: user });
        });

        it('ends every other one', async () => {
          const user = randomUUID();
          const kept = await establish(user);
          const others = [await establish(user), await establish(user)];

          await sessions.revokeAll(user, { except: sha256(kept) });

          for (const token of others) {
            await expect(sessions.authenticate(token)).resolves.toBeNull();
          }
        });

        it('leaves the index naming exactly the session that survived', async () => {
          const user = randomUUID();
          const kept = await establish(user);

          await establish(user);
          await sessions.revokeAll(user, { except: sha256(kept) });

          await expect(redis.smembers(sessionIndexKey(user))).resolves.toEqual([sha256(kept)]);
        });

        it('does not count the survivor among the sessions it ended', async () => {
          const user = randomUUID();
          const kept = await establish(user);

          await establish(user);

          await expect(sessions.revokeAll(user, { except: sha256(kept) })).resolves.toBe(1);
        });

        /**
         * A hash that is not in this user's index excepts nothing. The alternative — treating an
         * unrecognised exception as "keep everything" or as an error — would turn a caller's stale
         * session id into a reset that quietly revoked nothing at all.
         */
        it('ends everything when the excepted hash is not one of this user’s', async () => {
          const user = randomUUID();
          const token = await establish(user);

          await sessions.revokeAll(user, { except: sha256('a session somebody else holds') });

          await expect(sessions.authenticate(token)).resolves.toBeNull();
        });
      });
    });

    /**
     * T18, criterion 6. Both of these read the per-user index T15 built for exactly this, and
     * neither ever touches a key outside it — which is what makes "another user's session" a thing
     * this service cannot find rather than a thing it declines to act on.
     */
    describe('the session list', () => {
      const DEVICE = deviceFingerprintOf({
        ip: '203.0.113.7',
        userAgent: 'Mozilla/5.0 (Macintosh)',
      });

      async function establishOn(userId: string, device = DEVICE): Promise<string> {
        const { token } = await sessions.create(userId, device);

        track(sessionKey(sha256(token)), sessionIndexKey(userId));

        return token;
      }

      describe('list', () => {
        it('reports the device, address, creation and last-seen criterion 6 names', async () => {
          const user = randomUUID();

          await establishOn(user);

          const [session] = await sessions.list(user);

          // Asserted as the *whole* row rather than field by field: the absence of a token and of
          // the hash is the point, and a `toMatchObject` would pass with either of them beside it.
          expect(session).toEqual({
            createdAt: START,
            fingerprint: DEVICE.fingerprint,
            id: session!.id,
            ip: DEVICE.ip,
            lastSeenAt: START,
            userAgent: DEVICE.userAgent,
          });
          expect(session!.id).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
          );
        });

        it('lists every session the user has', async () => {
          const user = randomUUID();

          await establishOn(user);
          await establishOn(user);
          await establishOn(user);

          await expect(sessions.list(user)).resolves.toHaveLength(3);
        });

        /**
         * The property the endpoint is built on. It is not that another user's rows are filtered
         * out — it is that they are never read: the index key is derived from the user asked about,
         * so there is no path on which one user's list can contain another's session.
         */
        it('never contains another user’s session', async () => {
          const mine = randomUUID();
          const theirs = randomUUID();

          await establishOn(mine);
          await establishOn(theirs);

          const listed = await sessions.list(mine);
          const others = await sessions.list(theirs);

          expect(listed).toHaveLength(1);
          expect(others).toHaveLength(1);
          expect(listed[0]!.id).not.toBe(others[0]!.id);
        });

        it('answers an empty list for a user with no sessions at all', async () => {
          await expect(sessions.list(randomUUID())).resolves.toEqual([]);
        });

        /**
         * The standing rule for this task, asserted rather than reviewed for. The token is the
         * cookie's, and the hash is a Redis key; a list that carried either would put a
         * server-side identifier in a client's hands.
         */
        it('carries neither the token nor the hash it is stored under', async () => {
          const user = randomUUID();
          const token = await establishOn(user);
          const serialised = JSON.stringify(await sessions.list(user));

          expect(serialised).not.toContain(token);
          expect(serialised).not.toContain(sha256(token));
        });

        it('gives each session an id of its own', async () => {
          const user = randomUUID();

          await establishOn(user);
          await establishOn(user);

          const ids = (await sessions.list(user)).map((session) => session.id);

          expect(new Set(ids).size).toBe(2);
        });

        /**
         * Rotation replaces the identifier, not the device. A list whose ids changed under the
         * user every time they signed in or stepped up would make "sign this one out" point at a
         * row that had already moved.
         */
        it('keeps a session’s id across a rotation', async () => {
          const user = randomUUID();
          const token = await establishOn(user);
          const [before] = await sessions.list(user);
          const rotated = await sessions.rotate(token);

          track(sessionKey(sha256(rotated!.token)));

          await expect(sessions.list(user)).resolves.toEqual([before]);
        });

        /**
         * `SMEMBERS` promises no order, so without one of our own the same screen read twice would
         * reshuffle itself. Newest sign-in first is the useful end to start from.
         */
        it('orders newest sign-in first, and answers the same order twice', async () => {
          const user = randomUUID();

          await establishOn(user);
          clock.advance(60_000);
          await establishOn(user);
          clock.advance(60_000);
          await establishOn(user);

          const listed = await sessions.list(user);
          const again = await sessions.list(user);

          expect([...listed].sort((l, r) => r.createdAt.localeCompare(l.createdAt))).toEqual(
            listed,
          );
          expect(again.map((session) => session.id)).toEqual(listed.map((session) => session.id));
        });

        /**
         * A half-authenticated session is a sign-in part way through its challenge, not a device.
         * It can do nothing but answer that challenge and it expires in minutes, so a row for it
         * would offer the user an action whose only honest form is to wait.
         */
        it('leaves out a session that still owes its second factor', async () => {
          const user = randomUUID();
          const { token } = await sessions.create(user, DEVICE, {
            pendingMfa: true,
            ttlSeconds: 300,
          });

          track(sessionKey(sha256(token)), sessionIndexKey(user));
          await establishOn(user);

          await expect(sessions.list(user)).resolves.toHaveLength(1);
        });

        it('reports the sliding last-seen rather than the creation time', async () => {
          const user = randomUUID();
          const token = await establishOn(user);

          clock.advance(60_000);
          await sessions.authenticate(token);

          const [session] = await sessions.list(user);

          expect(session!.createdAt).toBe(START);
          expect(session!.lastSeenAt).not.toBe(START);
        });

        /**
         * A session key expires on its own; its index entry does not. Listing a device that cannot
         * be revoked — because the thing it names is already gone — is the one row a user would
         * click and click again, so the read prunes what it finds missing.
         */
        it('skips an index entry whose session has expired, and prunes it', async () => {
          const user = randomUUID();
          const token = await establishOn(user);

          await establishOn(user);
          await redis.del(sessionKey(sha256(token)));

          await expect(sessions.list(user)).resolves.toHaveLength(1);
          await expect(redis.smembers(sessionIndexKey(user))).resolves.not.toContain(sha256(token));
        });
      });

      describe('revokeById', () => {
        it('ends the session named, and says it did', async () => {
          const user = randomUUID();
          const token = await establishOn(user);
          const [session] = await sessions.list(user);

          await expect(sessions.revokeById(user, session!.id)).resolves.toBe(true);
          await expect(sessions.authenticate(token)).resolves.toBeNull();
        });

        /** Criterion 6's "within one request": the key is deleted, not left to a TTL. */
        it('deletes the key rather than expiring it', async () => {
          const user = randomUUID();
          const token = await establishOn(user);
          const [session] = await sessions.list(user);

          await sessions.revokeById(user, session!.id);

          await expect(redis.exists(sessionKey(sha256(token)))).resolves.toBe(0);
        });

        it('takes the index entry with it, so the device stops being listed', async () => {
          const user = randomUUID();

          await establishOn(user);

          const [session] = await sessions.list(user);

          await sessions.revokeById(user, session!.id);

          await expect(sessions.list(user)).resolves.toEqual([]);
          await expect(redis.smembers(sessionIndexKey(user))).resolves.toEqual([]);
        });

        it('leaves the caller’s other sessions alone', async () => {
          const user = randomUUID();
          const laptop = deviceFingerprintOf({ ip: '203.0.113.7', userAgent: 'a laptop' });
          const phone = deviceFingerprintOf({ ip: '198.51.100.4', userAgent: 'a phone' });
          const doomed = await establishOn(user, laptop);
          const kept = await establishOn(user, phone);
          const target = (await sessions.list(user)).find(
            (session) => session.userAgent === 'a laptop',
          );

          await expect(sessions.revokeById(user, target!.id)).resolves.toBe(true);

          await expect(sessions.authenticate(doomed)).resolves.toBeNull();
          await expect(sessions.authenticate(kept)).resolves.not.toBeNull();
          await expect(sessions.list(user)).resolves.toHaveLength(1);
        });

        /**
         * The answer that becomes a `404` rather than a `403`, and the reason this method takes the
         * user as well as the id: it looks only in that user's index, so an id belonging to
         * somebody else is indistinguishable from an id belonging to nobody. There is no branch
         * here that knows the session exists, which is what stops the endpoint being an oracle.
         */
        it('answers false for a session that belongs to another user', async () => {
          const mine = randomUUID();
          const theirs = randomUUID();

          await establishOn(mine);

          const victim = await establishOn(theirs);
          const [theirSession] = await sessions.list(theirs);

          await expect(sessions.revokeById(mine, theirSession!.id)).resolves.toBe(false);
          await expect(sessions.authenticate(victim)).resolves.not.toBeNull();
        });

        it('answers false for an id nobody was ever given', async () => {
          const user = randomUUID();

          await establishOn(user);

          await expect(sessions.revokeById(user, randomUUID())).resolves.toBe(false);
        });

        it('answers false for an id that is not even an id', async () => {
          const user = randomUUID();

          await establishOn(user);

          await expect(sessions.revokeById(user, 'not-a-uuid')).resolves.toBe(false);
          await expect(sessions.revokeById(user, '')).resolves.toBe(false);
        });

        it('answers false for a user with no sessions at all', async () => {
          await expect(sessions.revokeById(randomUUID(), randomUUID())).resolves.toBe(false);
        });

        /** Revoking the same device twice is not an error; it is a click somebody repeated. */
        it('answers false the second time the same session is revoked', async () => {
          const user = randomUUID();

          await establishOn(user);

          const [session] = await sessions.list(user);

          await expect(sessions.revokeById(user, session!.id)).resolves.toBe(true);
          await expect(sessions.revokeById(user, session!.id)).resolves.toBe(false);
        });
      });
    });
  });
});
