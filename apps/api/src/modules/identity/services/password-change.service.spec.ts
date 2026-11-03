import { ConfigModule } from '@nestjs/config';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { schema } from '@repo/db';
import { eq, inArray } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { ClockModule } from '../../../common/clock/clock.module';
import { CLOCK } from '../../../common/clock/clock.port';
import { FakeClock } from '../../../common/clock/fake-clock';
import { RedisModule } from '../../../common/redis/redis.module';
import { validateEnvironment } from '../../../config/environment';
import { APP_DATABASE } from '../../../database/database.constants';
import { DatabaseModule } from '../../../database/database.module';
import type { ForgeDatabase } from '../../../database/database.types';
import {
  BREACHED_PASSWORD_PORT,
  type BreachedPasswordPort,
  BreachedPasswordError,
} from '../password/breached-password.port';
import { PasswordHasher } from '../password/hasher';
import { PasswordModule } from '../password/password.module';
import { WeakPasswordError } from '../password/strength-policy';
import { IncorrectPasswordError, PasswordChangeService } from './password-change.service';
import { SessionService } from './session.service';

vi.hoisted(() => {
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_PARALLELISM = '1';
  process.env.ARGON2_TIME_COST = '1';
  process.env.SESSION_TTL_SECONDS = '900';
});

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const START = '2026-08-16T10:00:00.000Z';
const CURRENT = 'thermos-quibble-tundra-vellum';
const CHOSEN = 'kestrel-oxbow-parapet-sundial';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** The adapter fails open on a network error (ADR 008), so it is driven rather than reached. */
class ScriptedBreachPort implements BreachedPasswordPort {
  breached = false;

  isBreached(_password: string): Promise<boolean> {
    return Promise.resolve(this.breached);
  }
}

describe('PasswordChangeService', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and the session Redis role', () => {
    let moduleRef: TestingModule;
    let passwords: PasswordChangeService;
    let sessions: SessionService;
    let hasher: PasswordHasher;
    let database: ForgeDatabase;
    let breach: ScriptedBreachPort;
    let clock: FakeClock;
    const created: string[] = [];

    async function seed(password: string | null = CURRENT): Promise<string> {
      const [user] = await database
        .insert(schema.users)
        .values({
          email: `t19-change-${randomUUID()}@example.test`,
          passwordHash: password === null ? null : await hasher.hash(password),
        })
        .returning({ id: schema.users.id });

      created.push(user!.id);

      return user!.id;
    }

    async function storedHashOf(userId: string): Promise<string | null> {
      const [user] = await database
        .select({ passwordHash: schema.users.passwordHash })
        .from(schema.users)
        .where(eq(schema.users.id, userId));

      return user!.passwordHash;
    }

    beforeAll(async () => {
      clock = new FakeClock(START);
      breach = new ScriptedBreachPort();
      moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            ignoreEnvFile: true,
            isGlobal: true,
            validate: validateEnvironment,
          }),
          ClockModule,
          DatabaseModule,
          RedisModule,
          PasswordModule,
        ],
        providers: [PasswordChangeService, SessionService],
      })
        .overrideProvider(CLOCK)
        .useValue(clock)
        .overrideProvider(BREACHED_PASSWORD_PORT)
        .useValue(breach)
        .compile();

      await moduleRef.init();

      passwords = moduleRef.get(PasswordChangeService);
      sessions = moduleRef.get(SessionService);
      hasher = moduleRef.get(PasswordHasher);
      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
    }, 60_000);

    afterAll(async () => {
      if (created.length > 0) {
        await database.delete(schema.users).where(inArray(schema.users.id, created));
      }

      await moduleRef?.close();
    });

    describe('with the current password', () => {
      it('stores a hash the new password verifies against', async () => {
        const userId = await seed();
        const { token } = await sessions.create(userId);

        await passwords.change({
          currentPassword: CURRENT,
          newPassword: CHOSEN,
          sessionId: sha256(token),
          userId,
        });

        const stored = await storedHashOf(userId);

        await expect(hasher.verify(stored!, CHOSEN)).resolves.toMatchObject({ valid: true });
      });

      it('leaves the old password unable to verify', async () => {
        const userId = await seed();
        const { token } = await sessions.create(userId);

        await passwords.change({
          currentPassword: CURRENT,
          newPassword: CHOSEN,
          sessionId: sha256(token),
          userId,
        });

        const stored = await storedHashOf(userId);

        await expect(hasher.verify(stored!, CURRENT)).resolves.toMatchObject({ valid: false });
      });

      /** Criterion 7: every **other** session. The caller is not signed out of the device they are on. */
      it('keeps the session the request was made on', async () => {
        const userId = await seed();
        const { token } = await sessions.create(userId);

        await passwords.change({
          currentPassword: CURRENT,
          newPassword: CHOSEN,
          sessionId: sha256(token),
          userId,
        });

        await expect(sessions.authenticate(token)).resolves.toMatchObject({ userId });
      });

      it('revokes every other session the account has', async () => {
        const userId = await seed();
        const { token } = await sessions.create(userId);
        const elsewhere = [await sessions.create(userId), await sessions.create(userId)];

        await passwords.change({
          currentPassword: CURRENT,
          newPassword: CHOSEN,
          sessionId: sha256(token),
          userId,
        });

        for (const session of elsewhere) {
          await expect(sessions.authenticate(session.token)).resolves.toBeNull();
        }
      });

      it('answers how many sessions it ended', async () => {
        const userId = await seed();
        const { token } = await sessions.create(userId);

        await sessions.create(userId);
        await sessions.create(userId);

        await expect(
          passwords.change({
            currentPassword: CURRENT,
            newPassword: CHOSEN,
            sessionId: sha256(token),
            userId,
          }),
        ).resolves.toBe(2);
      });
    });

    describe('without it', () => {
      it('refuses a wrong current password', async () => {
        const userId = await seed();
        const { token } = await sessions.create(userId);

        await expect(
          passwords.change({
            currentPassword: 'not the password',
            newPassword: CHOSEN,
            sessionId: sha256(token),
            userId,
          }),
        ).rejects.toBeInstanceOf(IncorrectPasswordError);
      });

      it('leaves the stored password exactly as it was', async () => {
        const userId = await seed();
        const before = await storedHashOf(userId);
        const { token } = await sessions.create(userId);

        await expect(
          passwords.change({
            currentPassword: 'not the password',
            newPassword: CHOSEN,
            sessionId: sha256(token),
            userId,
          }),
        ).rejects.toThrow();

        await expect(storedHashOf(userId)).resolves.toBe(before);
      });

      /**
       * The revocation is the destructive half of this endpoint. A caller who cannot produce the
       * current password must not be able to sign an account out of every other device — that is a
       * denial of service against the owner, available to anyone who steals one session.
       */
      it('revokes nothing', async () => {
        const userId = await seed();
        const { token } = await sessions.create(userId);
        const elsewhere = await sessions.create(userId);

        await expect(
          passwords.change({
            currentPassword: 'not the password',
            newPassword: CHOSEN,
            sessionId: sha256(token),
            userId,
          }),
        ).rejects.toThrow();

        await expect(sessions.authenticate(elsewhere.token)).resolves.toMatchObject({ userId });
      });

      /**
       * An account that has only ever signed in through OAuth has no password to be wrong. It must
       * refuse the same way rather than treating "no hash stored" as "no password required", which
       * would let anyone holding such a session set a password without proving anything.
       */
      it('refuses an account with no password at all', async () => {
        const userId = await seed(null);
        const { token } = await sessions.create(userId);

        await expect(
          passwords.change({
            currentPassword: CURRENT,
            newPassword: CHOSEN,
            sessionId: sha256(token),
            userId,
          }),
        ).rejects.toBeInstanceOf(IncorrectPasswordError);
      });

      /**
       * Order. The current password is checked before the new one is judged, so a caller who cannot
       * prove who they are learns nothing about our policy and spends none of our zxcvbn, HIBP or
       * Argon2id budget — on an endpoint whose input they choose.
       */
      it('says nothing about the new password when the current one is wrong', async () => {
        const userId = await seed();
        const { token } = await sessions.create(userId);

        await expect(
          passwords.change({
            currentPassword: 'not the password',
            newPassword: 'password123456',
            sessionId: sha256(token),
            userId,
          }),
        ).rejects.toBeInstanceOf(IncorrectPasswordError);
      });
    });

    describe('the new password', () => {
      it('is held to the strength floor', async () => {
        const userId = await seed();
        const { token } = await sessions.create(userId);

        await expect(
          passwords.change({
            currentPassword: CURRENT,
            newPassword: 'password123456',
            sessionId: sha256(token),
            userId,
          }),
        ).rejects.toBeInstanceOf(WeakPasswordError);
      });

      it('is refused when it appears in a breach corpus', async () => {
        const userId = await seed();
        const { token } = await sessions.create(userId);

        breach.breached = true;

        await expect(
          passwords.change({
            currentPassword: CURRENT,
            newPassword: CHOSEN,
            sessionId: sha256(token),
            userId,
          }),
        ).rejects.toBeInstanceOf(BreachedPasswordError);

        breach.breached = false;
      });

      /** A rejected password must leave every session alone; nothing changed, so nothing is revoked. */
      it('leaves the other sessions alive when it is refused', async () => {
        const userId = await seed();
        const { token } = await sessions.create(userId);
        const elsewhere = await sessions.create(userId);

        await expect(
          passwords.change({
            currentPassword: CURRENT,
            newPassword: 'password123456',
            sessionId: sha256(token),
            userId,
          }),
        ).rejects.toThrow();

        await expect(sessions.authenticate(elsewhere.token)).resolves.toMatchObject({ userId });
      });
    });
  });
});
