import { Body, Controller, Delete, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  MFA_DISABLED,
  MFA_STEPPED_UP,
  type BeginTotpEnrolmentResponse,
  type ConfirmTotpEnrolmentResponse,
  type DisableMfaResponse,
  type MfaChallengeResponse,
  type StepUpResponse,
} from '@repo/contracts';

import type { Environment } from '../../../config/environment';
import { CurrentUser } from '../decorators/current-user.decorator';
import { Public } from '../decorators/public.decorator';
import { StepUp } from '../decorators/step-up.decorator';
import { ConfirmTotpEnrolmentDto, MfaChallengeDto, StepUpDto } from '../dto/mfa.dto';
import {
  type CookieBearingRequest,
  type CookieWritingResponse,
  readSessionCookie,
  setSessionCookie,
} from '../session-cookie';
import { MfaService } from '../services/mfa.service';
import type { AuthenticatedUser } from '../services/session.service';

/**
 * TOTP enrolment (§11, criterion 8).
 *
 * Both routes are guarded — no `@Public()` — so `SessionGuard` resolves the caller before either
 * method runs, which is what makes `@CurrentUser()` present rather than optional here. That is also
 * the whole of the authorisation: neither handler reads an account from the body, so a signed-in
 * caller can only ever enrol *themselves*. A `userId` parameter on either of these would be a way
 * to hand somebody a working second factor for an account they do not own.
 *
 * There is no `@Res` anywhere here. Enrolling changes nothing about the session the caller is
 * already holding — the privilege change that rotates a session identifier is completing a *login*
 * challenge, not acquiring a factor for the next one.
 */
@ApiTags('auth')
@Controller({ path: 'auth/mfa', version: '1' })
export class MfaController {
  private readonly cookieName: string;

  constructor(
    private readonly mfa: MfaService,
    config: ConfigService<Environment, true>,
  ) {
    this.cookieName = config.get('SESSION_COOKIE_NAME', { infer: true });
  }

  /**
   * `POST /auth/mfa/totp`. Mints a seed and answers with the URI a QR code is rendered from.
   *
   * `200` rather than `201`: nothing durable was created. That is the point of the two-step flow —
   * the account is untouched until a confirming code arrives, so a mis-scanned QR code costs the
   * user a second attempt rather than an account they can no longer sign in to.
   */
  @Post('totp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start a TOTP enrolment and get a provisioning URI to scan' })
  async beginEnrolment(
    @CurrentUser() caller: AuthenticatedUser,
  ): Promise<BeginTotpEnrolmentResponse> {
    return this.mfa.beginEnrolment(caller.userId);
  }

  /**
   * `POST /auth/mfa/totp/confirm`. Proves the phone read the QR code, and turns MFA on.
   *
   * The one response in this API that legitimately carries secrets, and the only time these codes
   * are readable. They are returned straight from the service rather than reshaped here, because
   * every hop that copies them is a hop that could keep them.
   */
  @Post('totp/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm a TOTP enrolment and receive ten one-time recovery codes' })
  async confirmEnrolment(
    @Body() body: ConfirmTotpEnrolmentDto,
    @CurrentUser() caller: AuthenticatedUser,
  ): Promise<ConfirmTotpEnrolmentResponse> {
    const { recoveryCodes } = await this.mfa.confirmEnrolment(caller.userId, body.code);

    return { recoveryCodes: [...recoveryCodes] };
  }

  /**
   * `POST /auth/mfa/challenge` — the second leg of a sign-in that answered `mfa_required`
   * (criterion 4).
   *
   * `@Public()`, and that is not a hole. `SessionGuard` refuses a pending-MFA session exactly as it
   * refuses a dead cookie, so a guarded handler here could never run; this route reads the cookie
   * itself and hands it to the service, which is the only code in the application that will act on
   * a half-authenticated session. The alternative — teaching the guard an exception for one route —
   * would put "which routes may run un-authenticated" in two places instead of one.
   *
   * The response writes a *new* cookie, because completing the challenge rotates the identifier.
   */
  @Public()
  @Post('challenge')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Complete a sign-in with a TOTP or recovery code' })
  async completeChallenge(
    @Body() body: MfaChallengeDto,
    @Req() incoming: CookieBearingRequest,
    @Res({ passthrough: true }) response: CookieWritingResponse,
  ): Promise<MfaChallengeResponse> {
    // An absent cookie is passed on as an empty string rather than short-circuited here, so
    // "no challenge in progress" and "wrong code" are one answer produced in one place.
    const { session, user } = await this.mfa.completeChallenge(
      readSessionCookie(incoming, this.cookieName) ?? '',
      body.code,
    );

    setSessionCookie(response, this.cookieName, session.token, session.ttlSeconds);

    return { user };
  }

  /**
   * `POST /auth/mfa/step-up`. Re-prove the second factor on a session that is already signed in,
   * opening the window `@StepUp()` routes require (criterion 12).
   *
   * Guarded, and no `@Res`: the session is unchanged apart from the stamp. Rotating here would sign
   * the caller out of the request they are in the middle of, and there is no privilege change to
   * rotate for — the caller had these rights a moment ago and has them now.
   */
  @Post('step-up')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Re-authenticate with a second factor before a sensitive change' })
  async stepUp(
    @Body() body: StepUpDto,
    @CurrentUser() caller: AuthenticatedUser,
  ): Promise<StepUpResponse> {
    // `caller.sessionId` is the session *hash* the guard resolved, which is what makes the stamp
    // land on this device rather than on the account.
    await this.mfa.stepUp(caller.sessionId, caller.userId, body.code);

    return { status: MFA_STEPPED_UP };
  }

  /**
   * `DELETE /auth/mfa/totp` — criterion 12's named example.
   *
   * `@StepUp()` is the whole point of this route existing here. Removing the second factor is the
   * first thing somebody who has picked up an unlocked laptop would do, and it is the change whose
   * damage most outlives the session that made it: afterwards the password alone is the account.
   * A session is therefore not enough — a second factor presented in the last few minutes is.
   */
  @Delete('totp')
  @HttpCode(HttpStatus.OK)
  @StepUp()
  @ApiOperation({ summary: 'Remove the authenticator app and its recovery codes' })
  async disable(@CurrentUser() caller: AuthenticatedUser): Promise<DisableMfaResponse> {
    await this.mfa.disable(caller.userId);

    return { status: MFA_DISABLED };
  }
}
