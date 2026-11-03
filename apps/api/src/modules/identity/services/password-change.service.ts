import { Inject, Injectable, Logger } from '@nestjs/common';
import { schema } from '@repo/db';
import { eq } from 'drizzle-orm';

import { DomainError } from '../../../common/errors/domain-error';
import { APP_DATABASE } from '../../../database/database.constants';
import type { ForgeDatabase } from '../../../database/database.types';
import { PasswordHasher } from '../password/hasher';
import { NewPasswordService } from '../password/new-password';
import { SessionService } from './session.service';

/** What a signed-in caller gives up to change their password. */
export interface PasswordChangeAttempt {
  readonly currentPassword: string;
  readonly newPassword: string;
  /**
   * The hash of the session the request arrived on — the one that survives. This is
   * `AuthenticatedUser.sessionId`, which is what the guard resolved; the raw token never reaches a
   * service, which is the reason {@link SessionService.revokeAll} excepts by hash.
   */
  readonly sessionId: string;
  readonly userId: string;
}

/**
 * The current password was not the account's password — including the case where the account has no
 * password at all.
 *
 * One error for both, because the difference is not the caller's business and there is nothing they
 * can do with it that they cannot do with this. It is a `403` rather than a `401`; see the note in
 * `problem-types.ts` on why the distinction matters to a client holding a perfectly good session.
 */
export class IncorrectPasswordError extends DomainError {
  constructor() {
    super('current-password-incorrect', 'That is not the current password for this account.');
  }
}

/**
 * `POST /auth/password/change` (§11, criterion 7).
 *
 * Two properties, in this order, and the order is the design:
 *
 * 1. **The current password is proved first.** Everything after it is either destructive (revoking
 *    the account's other sessions) or expensive on input the caller chooses (zxcvbn, the HIBP
 *    lookup, Argon2id at 64 MB). A caller holding a stolen session who cannot produce the password
 *    must not be able to sign the owner out of every other device, and must not learn our password
 *    policy by probing it either.
 * 2. **Every other session dies.** That is the point of the endpoint, not a courtesy. Somebody
 *    changes their password *because* they think another device is not theirs, and a change that
 *    left those sessions live would leave the attacker exactly where they were — holding an opaque
 *    cookie that no longer has anything to do with the password that was just rotated.
 *
 * The caller's own session is kept rather than rotated. Rotation exists for a value that may have
 * been captured while the holder had fewer rights (T15); this session's holder has just proved they
 * know the password, and signing them out of the device they are standing at is the thing that makes
 * users avoid changing passwords.
 *
 * There is no audit row here for the reason `signup.service.ts` gives at length: `audit_log.org_id`
 * is `not null` and this event belongs to a person, not to an organisation. It goes to the
 * structured application log (§05), with the user id and the size of the revocation and nothing else.
 */
@Injectable()
export class PasswordChangeService {
  private readonly logger = new Logger(PasswordChangeService.name);

  constructor(
    @Inject(APP_DATABASE) private readonly database: ForgeDatabase,
    private readonly hasher: PasswordHasher,
    private readonly passwords: NewPasswordService,
    private readonly sessions: SessionService,
  ) {}

  /**
   * @returns how many other sessions were revoked — a number for the log line, never for the body.
   * @throws {IncorrectPasswordError} the current password is wrong, or there is none.
   * @throws {WeakPasswordError | PersonalInformationPasswordError | BreachedPasswordError} the new
   * password is one of the three §11 refuses.
   */
  async change(attempt: PasswordChangeAttempt): Promise<number> {
    const [user] = await this.database
      .select({ email: schema.users.email, passwordHash: schema.users.passwordHash })
      .from(schema.users)
      .where(eq(schema.users.id, attempt.userId))
      .limit(1);

    // No row means the account was deleted while its session was still live, and no hash means it
    // has only ever signed in through OAuth. Neither has a current password to present, and neither
    // is a reason to let the change through — "there is nothing to prove" must not mean "you have
    // proved it".
    if (user?.passwordHash == null) {
      throw new IncorrectPasswordError();
    }

    const { valid } = await this.hasher.verify(user.passwordHash, attempt.currentPassword);

    if (!valid) {
      // No mention of the account beyond its id: §05 keeps mailboxes out of the log, and the request
      // id pino attaches is what ties this line to the caller.
      this.logger.warn(`Password change refused: current password wrong [user=${attempt.userId}]`);

      throw new IncorrectPasswordError();
    }

    // The owner is the account's own address, so a password made of it is refused here exactly as it
    // would have been at signup.
    const passwordHash = await this.passwords.vet(attempt.newPassword, { email: user.email });

    await this.database
      .update(schema.users)
      .set({ passwordHash })
      .where(eq(schema.users.id, attempt.userId));

    // After the write, never before. A revocation that ran first and then failed to store the new
    // password would sign the account out of every device for nothing.
    const revoked = await this.sessions.revokeAll(attempt.userId, { except: attempt.sessionId });

    this.logger.log(`Password changed [user=${attempt.userId} sessions_revoked=${revoked}]`);

    return revoked;
  }
}
