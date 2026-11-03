import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  PASSWORD_CHANGED,
  PASSWORD_RESET,
  PASSWORD_RESET_REQUESTED,
  type ChangePasswordResponse,
  type RequestPasswordResetResponse,
  type ResetPasswordResponse,
} from '@repo/contracts';

import { CurrentUser } from '../decorators/current-user.decorator';
import { Public } from '../decorators/public.decorator';
import { type DeviceBearingRequest, deviceFingerprintOf } from '../device-fingerprint';
import { ChangePasswordDto, RequestPasswordResetDto, ResetPasswordDto } from '../dto/password.dto';
import { TurnstileGuard } from '../guards/turnstile.guard';
import { PasswordChangeService } from '../services/password-change.service';
import { PasswordResetService } from '../services/password-reset.service';
import type { AuthenticatedUser } from '../services/session.service';

/**
 * The part of the platform request this controller reads, declared structurally for the reason
 * `auth.controller.ts` gives: this package depends on `@nestjs/platform-express`, not on `express`.
 *
 * `ip` is the real client only because `bootstrap.ts` configures `trust proxy` — without it every
 * per-IP bucket on the reset endpoint counts one caller (T15).
 */
interface ClientBearingRequest {
  readonly headers?: Readonly<Record<string, string | string[] | undefined>>;
  readonly ip?: string;
}

/**
 * The three password routes (§11, criterion 7).
 *
 * They are split across two guard states on purpose, and the split is the design:
 *
 * - **Change is guarded**, and asks for the current password on top of the session. A session alone
 *   is not enough to rotate the credential that outlives it — someone who picks up an unlocked
 *   laptop must not be able to lock the owner out of their own account with two fields.
 * - **Reset is `@Public()`**, because its whole purpose is to work for somebody who cannot sign in.
 *   The throttle, not the guard, is what protects it, and the enumeration-safe response is what
 *   stops it answering the question an attacker actually came for.
 *
 * There is no `@Res` anywhere here. Change deliberately leaves the caller's cookie alone — they are
 * still signed in, on the session that survived — and the confirm route establishes nothing, because
 * consuming a reset token revokes every session and handing one straight back would undo that for
 * whoever happened to be holding the link.
 */
@ApiTags('auth')
@Controller({ path: 'auth/password', version: '1' })
export class PasswordController {
  constructor(
    private readonly change: PasswordChangeService,
    private readonly reset: PasswordResetService,
  ) {}

  /**
   * `POST /auth/password/change`. Guarded — no `@Public()` — so `SessionGuard` resolves the caller
   * before this method runs, which is what makes `@CurrentUser()` present rather than optional here.
   *
   * `200` with a constant body rather than `204`: a client that has just changed a password needs
   * something to parse to know it worked, and a `204` makes "changed" and "a proxy ate the response"
   * the same event.
   */
  @Post('change')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Replace the password, and sign every other device out' })
  async changePassword(
    @Body() body: ChangePasswordDto,
    @CurrentUser() caller: AuthenticatedUser,
  ): Promise<ChangePasswordResponse> {
    // `caller.sessionId` is the session *hash*, which is what the guard resolved and the only thing
    // that identifies "the device this request came from" without handing a service a live token.
    await this.change.change({
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
      sessionId: caller.sessionId,
      userId: caller.userId,
    });

    // Built here rather than returned by the service, so there is exactly one expression in the
    // codebase that decides what a password change answers with, and it takes no arguments — in
    // particular not the count of sessions the service just ended.
    return { status: PASSWORD_CHANGED };
  }

  /**
   * `POST /auth/password/reset` (criterion 7). `202`, always, with the same body for an address that
   * has an account and one that does not.
   *
   * "Accepted" rather than "OK" for the reason signup gives: the status line must not answer the
   * question either. A `200` for a known address beside a `202` for an unknown one would be the
   * oracle this whole endpoint is shaped to withhold, told before the body was even read.
   */
  @Public()
  // §03, T31, and for the same reason signup carries it: this is the other endpoint that sends mail
  // to an address the caller has not proved they own. Verification only, inert without a secret.
  @UseGuards(TurnstileGuard)
  @Post('reset')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Send a reset link, if the address has an account' })
  async requestReset(
    @Body() body: RequestPasswordResetDto,
    @Req() incoming: ClientBearingRequest,
  ): Promise<RequestPasswordResetResponse> {
    // Through `deviceFingerprintOf` rather than reading `incoming.ip` directly, so the per-IP bucket
    // here is keyed exactly as the ones in `LoginService` and the resend endpoint are — same
    // normalisation, same fallback for a request that arrived without an address.
    await this.reset.request({ email: body.email, ip: deviceFingerprintOf(deviceOf(incoming)).ip });

    return { status: PASSWORD_RESET_REQUESTED };
  }

  /**
   * `POST /auth/password/reset/confirm`. `@Public()`, because the whole point of a mailed link is
   * that it works in the browser the mail was opened in, which is not the one holding the session —
   * and by the time this returns there is no session anywhere for this account anyway.
   *
   * The token arrives in the body rather than the URL. The link the mail carries *is* a query
   * parameter — `links.ts` argues why — but the web app reads it from its own URL and posts it, so
   * the token reaches this API in a body no access log records.
   */
  @Public()
  @Post('reset/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Choose a new password with the token from a reset link' })
  async confirmReset(@Body() body: ResetPasswordDto): Promise<ResetPasswordResponse> {
    await this.reset.complete({ password: body.password, token: body.token });

    return { status: PASSWORD_RESET };
  }
}

/** `User-Agent` can legitimately arrive more than once; the first one is the request's own. */
function deviceOf(incoming: ClientBearingRequest): DeviceBearingRequest {
  const userAgent = incoming.headers?.['user-agent'];

  return {
    ip: incoming.ip,
    userAgent: Array.isArray(userAgent) ? userAgent[0] : userAgent,
  };
}
