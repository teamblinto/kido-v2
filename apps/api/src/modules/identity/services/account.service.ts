import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@repo/db';
import { eq } from 'drizzle-orm';

import { NotFoundError } from '../../../common/errors/domain-error';
import { APP_DATABASE } from '../../../database/database.constants';
import type { ForgeDatabase } from '../../../database/database.types';
import { isEmailVerified } from '../email-verified';

/**
 * The account behind a session, as every route that names one describes it.
 *
 * Structurally the `user` member of `signedInResponseSchema`, and declared here rather than
 * imported from `@repo/contracts` for the reason the rest of this module gives: a service says
 * what it holds, and a controller is where that becomes a wire format.
 *
 * Four fields, and the absent ones are the point. No password hash, no MFA seed, no
 * `emailVerifiedAt` — a timestamp invites a client to compare it against a clock it does not share,
 * where the only question anybody has is the boolean. `mfaEnabled` is that boolean for the seed:
 * the account screen offers "set up" or "remove" from it (spec 003), and the seed itself is the
 * one thing that response must never carry.
 */
export interface AccountSummary {
  readonly email: string;
  readonly emailVerified: boolean;
  readonly id: string;
  readonly mfaEnabled: boolean;
}

/**
 * Reading the account a request is already authenticated as — `GET /auth/me`, and nothing else.
 *
 * `SessionGuard` resolves a principal from Redis on every guarded request, and what it resolves
 * carries the session: a user id, when the session started, when it was last seen, whether a second
 * factor is still owed. It deliberately does not carry an email address, because no guarded route
 * needs one to make a decision and a principal that held one would be a copy of a mutable row,
 * cached for a fortnight, in front of every handler in the application.
 *
 * So the address is read here, at the one moment somebody actually asked for it. That is also why
 * this is a service of its own rather than a method on `LoginService`: nothing about answering "who
 * is this?" is a sign-in — there is no credential, no throttle and no session to establish — and
 * `login.service.ts` is a file whose every other line is about making a miss cost what a hit costs.
 *
 * `users` is a root table with no `org_id` and no RLS policy (ADR 015), so this read needs no
 * tenant context and would be wrong to open one: the account exists before any organisation and may
 * hold memberships in several.
 */
@Injectable()
export class AccountService {
  constructor(@Inject(APP_DATABASE) private readonly database: ForgeDatabase) {}

  /**
   * The account with this id.
   *
   * Reachable with an id that names nothing only when the row was deleted while one of its sessions
   * was still live — the same window `MfaService` answers for, and answered the same way. A `404`
   * rather than a `401`: the caller's session is real and was resolved, and telling them to
   * re-authenticate would send them round a login loop against an account that is gone.
   */
  async describe(userId: string): Promise<AccountSummary> {
    const [user] = await this.database
      .select({
        email: schema.users.email,
        emailVerifiedAt: schema.users.emailVerifiedAt,
        id: schema.users.id,
        mfaSecretEnc: schema.users.mfaSecretEnc,
      })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    if (user === undefined) {
      throw new NotFoundError('That account no longer exists.');
    }

    return {
      email: user.email,
      // Through `isEmailVerified` rather than `!== null` inline, which is the whole reason
      // `email-verified.ts` exists: §11's rule lives in one place, and the fourth caller spelling it
      // by hand is the one that eventually spells it `!=`.
      emailVerified: isEmailVerified(user),
      id: user.id,
      // The same definition `MfaService.isEnrolled` uses. A pending enrolment is in Redis, not in
      // this column, so an account mid-enrolment reports `false` — which is what the two-step flow
      // promises: nothing is durable until the confirming code lands.
      mfaEnabled: user.mfaSecretEnc !== null,
    };
  }

  /**
   * The address to send a notice about this account to (spec 032 R1), or `undefined` when there
   * is none to use: the account is gone, or its address was never confirmed — mailing an
   * unconfirmed address would notify whoever typed it. The one method other modules may call:
   * a question with an answer, not a reader of the `users` row.
   */
  async noticeAddress(userId: string): Promise<string | undefined> {
    const [user] = await this.database
      .select({ email: schema.users.email, emailVerifiedAt: schema.users.emailVerifiedAt })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    return user !== undefined && isEmailVerified(user) ? user.email : undefined;
  }
}
