import { schema } from '@repo/db';
import { inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { openPool } from '../../../../test/support/integration-database';
import type { ForgeDatabase } from '../../../database/database.types';
import { NotFoundError } from '../../../common/errors/domain-error';
import { AccountService } from './account.service';

const reachable = inject('postgresReachable');

const pool = reachable ? openPool(process.env.DATABASE_URL ?? '', 2) : undefined;

/**
 * `GET /auth/me`'s one service, against the real table.
 *
 * Written as an integration test rather than against a stubbed Drizzle instance because there is
 * almost nothing here *except* the query: the interesting claims are that `users` is readable with
 * no tenant context at all (ADR 015 — it is a root, and this is what makes it true rather than
 * asserted), that a verified address comes back as a boolean, and that the password hash and MFA
 * seed sitting in the same row do not.
 */
describe.skipIf(!reachable)('AccountService', () => {
  let database: ForgeDatabase;
  let accounts: AccountService;
  const userIds: string[] = [];

  async function seed(
    emailVerifiedAt: Date | null,
    mfaSecretEnc: Buffer | null = Buffer.from('not-a-real-seed'),
  ): Promise<{ email: string; id: string }> {
    const email = `me-${randomUUID()}@example.test`;

    const [user] = await database
      .insert(schema.users)
      .values({
        email,
        emailVerifiedAt,
        mfaSecretEnc,
        passwordHash: 'argon2id$not-a-real-hash',
      })
      .returning({ id: schema.users.id });

    userIds.push(user!.id);

    return { email, id: user!.id };
  }

  beforeAll(() => {
    database = drizzle(pool!, { schema });
    accounts = new AccountService(database);
  });

  afterAll(async () => {
    if (!reachable) {
      return;
    }

    if (userIds.length > 0) {
      await database.delete(schema.users).where(inArray(schema.users.id, userIds));
    }

    await pool!.end();
  });

  it('describes the account behind a user id', async () => {
    const { email, id } = await seed(new Date());

    await expect(accounts.describe(id)).resolves.toEqual({
      email,
      emailVerified: true,
      id,
      mfaEnabled: true,
    });
  });

  /**
   * §11 makes an unverified account usable but unable to create sandboxes, so a client has to be
   * able to render the banner from this response rather than from a second round trip.
   */
  it('reports an unconfirmed address as unverified rather than omitting it', async () => {
    const { email, id } = await seed(null);

    await expect(accounts.describe(id)).resolves.toEqual({
      email,
      emailVerified: false,
      id,
      mfaEnabled: true,
    });
  });

  /**
   * Spec 003. The account screen offers "set up" or "remove" from this one boolean, and a pending
   * enrolment lives in Redis rather than in this column — so an account mid-enrolment reports
   * `false` here, which is the answer the two-step flow wants.
   */
  it('reports an account with no second factor as unprotected', async () => {
    const { email, id } = await seed(new Date(), null);

    await expect(accounts.describe(id)).resolves.toEqual({
      email,
      emailVerified: true,
      id,
      mfaEnabled: false,
    });
  });

  /**
   * The row this reads also holds a password hash, an MFA seed and a verification timestamp. The
   * projection is the only thing keeping them out of a response body, so it is asserted as the
   * *complete* set of keys — a `select()` with no argument list would pass a test that only checked
   * the four fields that should be there. The seed is read to compute `mfaEnabled` and must not
   * ride along with it.
   */
  it('returns exactly four fields, and none of the secrets beside them', async () => {
    const { id } = await seed(new Date());
    const account = await accounts.describe(id);

    expect(Object.keys(account).sort()).toEqual(['email', 'emailVerified', 'id', 'mfaEnabled']);
    expect(JSON.stringify(account)).not.toContain('not-a-real-hash');
    expect(JSON.stringify(account)).not.toContain('not-a-real-seed');
  });

  /**
   * Reachable when an account is deleted while one of its sessions is still live. A `404` rather
   * than a `401`: the session was resolved and is real, and telling the caller to authenticate
   * again would send them round a login loop against an account that is gone.
   */
  it('refuses an id that names nobody, without inventing an empty account', async () => {
    await expect(accounts.describe(randomUUID())).rejects.toBeInstanceOf(NotFoundError);
  });

  /** Spec 032 R1: the one method other modules may call — an address to notify, or nothing. */
  describe('noticeAddress', () => {
    it('is the verified address', async () => {
      const { email, id } = await seed(new Date());

      await expect(accounts.noticeAddress(id)).resolves.toBe(email);
    });

    it('is undefined for an unverified address', async () => {
      const { id } = await seed(null);

      await expect(accounts.noticeAddress(id)).resolves.toBeUndefined();
    });

    it('is undefined for a deleted account, rather than a refusal', async () => {
      await expect(accounts.noticeAddress(randomUUID())).resolves.toBeUndefined();
    });
  });
});
