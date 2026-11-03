import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';

import { CLOCK, type ClockPort } from '../../../common/clock/clock.port';
import { DomainError } from '../../../common/errors/domain-error';
import type { Environment } from '../../../config/environment';
import { REQUIRES_STEP_UP } from '../decorators/step-up.decorator';
import { AUTHENTICATED_USER, type AuthenticatedUser } from '../services/session.service';

/**
 * One sentence, and it names the remedy.
 *
 * Unlike the guard above it, this one *should* be specific: the caller is signed in, the request
 * was understood, and the only thing standing between them and it is a code they can produce in ten
 * seconds. Being vague here would leave a client guessing at a state it is entitled to know.
 */
const REJECTION = 'This change needs a recent second factor. Confirm your code and try again.';

/**
 * The step-up requirement failed (criterion 12).
 *
 * A `403` refinement rather than a `401`, for the reason `problem-types.ts` gives about
 * `current-password-incorrect`: the session is perfectly good, and a client that signed the user
 * out over this would throw away the form they were filling in. The refinement is what lets a
 * client prompt for a code and retry, where a bare `forbidden` would only let it say "ask an
 * administrator" about a permission the caller already has.
 */
export class StepUpRequiredError extends DomainError {
  constructor() {
    super('step-up-required', REJECTION);
  }
}

/**
 * Requires a recent second factor on any handler carrying `@StepUp()` (§11, criterion 12).
 *
 * Registered as a second `APP_GUARD` in `IdentityModule`, *after* `SessionGuard`, because it reads
 * the principal that guard resolves. That ordering is the one piece of coupling here, and it is why
 * a missing principal is refused rather than ignored: if somebody reorders the providers array,
 * this guard must fail closed and be noticed, not silently stop enforcing anything.
 *
 * ## Why a window rather than a nonce
 *
 * The alternative is a one-shot token minted by the step-up route and spent by the sensitive one.
 * That is tighter and it is worse here: it forces every sensitive route to accept and thread a
 * token, and a single sensitive *flow* — removing MFA, say, which a client may retry after a
 * validation error — would need a fresh code each attempt. A short window keyed on the session is
 * what §11 describes and what a user can actually work with, and its cost is bounded by
 * `MFA_STEP_UP_TTL_SECONDS`.
 */
@Injectable()
export class StepUpGuard implements CanActivate {
  private readonly windowMs: number;

  constructor(
    private readonly reflector: Reflector,
    @Inject(CLOCK) private readonly clock: ClockPort,
    config: ConfigService<Environment, true>,
  ) {
    this.windowMs = config.get('MFA_STEP_UP_TTL_SECONDS', { infer: true }) * 1_000;
  }

  canActivate(context: ExecutionContext): boolean {
    // Handler first, then class, so a `@StepUp()` controller reads as "all of these" and a handler
    // can be marked on an otherwise ordinary one.
    const required = this.reflector.getAllAndOverride<boolean>(REQUIRES_STEP_UP, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (required !== true) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Record<PropertyKey, unknown>>();
    const caller = request[AUTHENTICATED_USER] as AuthenticatedUser | undefined;

    if (caller === undefined) {
      throw new StepUpRequiredError();
    }

    if (!this.steppedUpRecently(caller.steppedUpAt)) {
      throw new StepUpRequiredError();
    }

    return true;
  }

  /**
   * Whether the stamp is both readable and inside the window.
   *
   * Every rejected shape collapses to one answer, and the two unusual ones are worth naming. An
   * unparseable stamp yields `NaN`, and every comparison against `NaN` is false — so writing this
   * as "is it older than the window" rather than "is it inside it" would admit a corrupt field.
   * A stamp in the *future* is a clock that went backwards or a field somebody wrote, and reading
   * it as "very recent" would turn one bad write into a standing bypass.
   */
  private steppedUpRecently(steppedUpAt: string | null): boolean {
    if (steppedUpAt === null) {
      return false;
    }

    const age = this.clock.now().getTime() - Date.parse(steppedUpAt);

    return age >= 0 && age < this.windowMs;
  }
}
