import { Inject, Injectable, Logger } from '@nestjs/common';
import { schema } from '@repo/db';
import { eq } from 'drizzle-orm';

import { APP_DATABASE } from '../../../database/database.constants';
import type { ForgeDatabase, TenantTransaction } from '../../../database/database.types';
import { OutboxWriter } from '../../outbox/outbox-writer';
import {
  BREACHED_PASSWORD_PORT,
  type BreachedPasswordPort,
  BreachedPasswordError,
} from '../password/breached-password.port';
import { PasswordHasher } from '../password/hasher';
import { PasswordStrengthPolicy } from '../password/strength-policy';
import { EmailVerificationService, returnAddress } from './email-verification.service';

/** What a caller gives up to register. Nothing else: signup takes no organisation name (ADR 007). */
export interface SignupAttempt {
  readonly email: string;
  /** Spec 031 (R7): the page to return to once verified, carried on either mail alike. */
  readonly next?: string;
  readonly password: string;
}

/**
 * `POST /api/v1/auth/signup` (§11, success criterion 1).
 *
 * ## The account it creates
 *
 * One `users` row, and nothing else. Signup does **not** create an organisation, a membership or a
 * workspace — that is open question 1, answered "no", and recorded in ADR 007. `users` is a root
 * table (T04): a person exists before any organisation, so this whole flow runs with no tenant
 * context and touches nothing RLS governs.
 *
 * That answer is also why there is no `AuditService.record()` here. `audit_log.org_id` is
 * `not null` and every row in it belongs to an organisation; this event belongs to none, and T05
 * rejected the nullable column that would have allowed one — a null `org_id` is invisible to the
 * `tenant_isolation` policy's `=` and readable only by the bypass role, "a silent hole rather than
 * a design". `schema/audit.ts` already prescribes the alternative for account-scope events, and
 * this class follows it: the structured application log (§05). The first audited-to-`audit_log`
 * event in a user's life is whatever they do inside the organisation they later join or create.
 *
 * ## Why it answers the same way twice
 *
 * The endpoint is enumeration-safe (open question 2, answered "enumeration-safe"). An address that
 * already has an account gets the same `202` and the same body as one that does not, and an
 * "account already exists" mail instead of a `409`. `signupRequestSchema`'s response type has no
 * member that could differ, and this method returns `void` for the same reason — there is no user
 * id to hand back on one branch and withhold on the other.
 *
 * Three things have to hold for that to be true, and each is a test:
 *
 * - **The body.** Guaranteed by the return type and by `signup.e2e-spec.ts` comparing bytes.
 * - **The work.** Argon2id at 64 MB dominates this request. Both branches hash, and the hash
 *   happens before the row is looked for, so there is no branch to put a `return` inside. The
 *   taken-address branch throws its digest away, which is the point.
 * - **The order.** Password policy runs first, on every request, before anything has looked at the
 *   address. A policy that ran after the lookup could not reject a weak password for a taken
 *   address without saying so.
 *
 * - **The mail.** Both branches append exactly one outbox event in the transaction the insert runs
 *   in (spec 006, ADR 030): the fresh address gets "confirm your email address", the taken one gets
 *   "this address already has an account". Which template went out is a fact only the mailbox's
 *   owner learns, and nothing renders or sends on the request path — the `mail` queue's consumer
 *   issues the token and calls the transport after the commit.
 *
 * Neither mail can fail the request, because neither is sent here: an append is one row on the
 * handle the insert is on, and a queue store that is down is the relay's condition, not this
 * request's (spec 006 SC-007). A provider outage that reached the caller as a 500 on one branch
 * and a 202 on the other would be the oracle this whole design withholds.
 */
@Injectable()
export class SignupService {
  private readonly logger = new Logger(SignupService.name);

  constructor(
    @Inject(APP_DATABASE) private readonly database: ForgeDatabase,
    @Inject(BREACHED_PASSWORD_PORT) private readonly breached: BreachedPasswordPort,
    private readonly hasher: PasswordHasher,
    private readonly outbox: OutboxWriter,
    private readonly strength: PasswordStrengthPolicy,
    private readonly verification: EmailVerificationService,
  ) {}

  /**
   * Resolves either way. The caller learns nothing from this method that it could pass on.
   *
   * It throws only for a password the user has to change — the three §11 rejections, which are the
   * same three for every address — and for a genuine fault, which is a 500 for both branches alike.
   */
  async register(attempt: SignupAttempt): Promise<void> {
    // First, and before anything has looked the address up. The owner is the address that was
    // *typed*: an account does not have to exist for `ada@…` to make `ada` a bad password.
    this.strength.assert(attempt.password, { email: attempt.email });

    if (await this.breached.isBreached(attempt.password)) {
      throw new BreachedPasswordError();
    }

    // Unconditional, and deliberately not inside either branch. This is the expensive half of the
    // request, and the reason a taken address costs what a fresh one costs.
    const passwordHash = await this.hasher.hash(attempt.password);
    const created = await this.database.transaction(async (tx) => {
      const id = await this.createIfAbsent(tx, attempt.email, passwordHash);

      if (id === undefined) {
        await this.notifyExistingAccount(tx, attempt.email, attempt.next);

        return undefined;
      }

      // The half of the enumeration story this class could not close on its own. Both branches
      // append exactly one event — this one, and the account-exists notice above — so the
      // difference between a fresh address and a taken one is which template went out, a fact
      // only the mailbox's owner ever learns. Both are one row in the transaction the account is
      // created in: the mail is accepted when the account is, and neither can fail without the
      // other (spec 006 FR-002).
      await this.verification.request(tx, id, attempt.email, attempt.next);

      return id;
    });

    if (created !== undefined) {
      // The address is deliberately absent: §05 keeps mailboxes out of the log, and the request id
      // pino attaches is what correlates this line with the request that produced it.
      this.logger.log(`Account created [user=${created}]`);
    }
  }

  /**
   * The insert, and the race it is written to survive.
   *
   * `on conflict do nothing` rather than a `select` and then an `insert`. Two overlapping signups
   * for the same new address both see no row, both insert, and the second takes a 23505 that the
   * endpoint has no branch for — a 500 where every other caller gets a 202, which is an
   * enumeration oracle available to anyone willing to send two requests at once. One statement has
   * no window between the check and the write, so the loser is told the same thing as somebody who
   * arrived an hour late.
   *
   * The transaction around it exists for the outbox row that joins it (spec 006), not for this
   * statement, which is atomic on its own.
   */
  private async createIfAbsent(
    tx: TenantTransaction,
    email: string,
    passwordHash: string,
  ): Promise<string | undefined> {
    const [created] = await tx
      .insert(schema.users)
      .values({ email, passwordHash })
      .onConflictDoNothing({ target: schema.users.email })
      .returning({ id: schema.users.id });

    return created?.id;
  }

  /**
   * The only channel that tells an existing address the truth: one event, and the consumer mails
   * the notice to the address the account holds — after re-checking it still does (spec 006).
   *
   * The lookup is one indexed select, sub-millisecond beside the Argon2id both branches already
   * paid for (research R4). An address whose row vanished between the conflict and this read is
   * the same as one that never existed: nothing to notify.
   */
  private async notifyExistingAccount(
    tx: TenantTransaction,
    email: string,
    next?: string,
  ): Promise<void> {
    const [existing] = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);

    if (existing === undefined) {
      return;
    }

    await this.outbox.append(tx, {
      aggregateId: existing.id,
      payload: { ...returnAddress(next), recipient: email, userId: existing.id },
      type: 'mail.account-exists',
    });
  }
}
