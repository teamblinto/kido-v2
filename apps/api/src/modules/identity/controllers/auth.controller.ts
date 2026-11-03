import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  EMAIL_VERIFIED,
  MFA_REQUIRED,
  SIGNUP_ACCEPTED,
  VERIFICATION_RESEND_ACCEPTED,
  type CurrentUserResponse,
  type LoginResponse,
  type ResendVerificationResponse,
  type SignupResponse,
  type VerifyEmailResponse,
} from '@repo/contracts';

import type { Environment } from '../../../config/environment';
import { CurrentUser } from '../decorators/current-user.decorator';
import { Public } from '../decorators/public.decorator';
import { type DeviceBearingRequest, deviceFingerprintOf } from '../device-fingerprint';
import { TurnstileGuard } from '../guards/turnstile.guard';
import { LoginDto } from '../dto/login.dto';
import { SignupDto } from '../dto/signup.dto';
import { ResendVerificationDto, VerifyEmailDto } from '../dto/verify.dto';
import {
  type CookieBearingRequest,
  type CookieClearingResponse,
  type CookieWritingResponse,
  clearSessionCookie,
  readSessionCookie,
  setSessionCookie,
} from '../session-cookie';
import { AccountService } from '../services/account.service';
import { EmailVerificationService } from '../services/email-verification.service';
import { LoginService } from '../services/login.service';
import type { AuthenticatedUser } from '../services/session.service';
import { SignupService } from '../services/signup.service';

/**
 * The part of the platform request these two routes read, declared structurally for the reason
 * `ProblemDetailsFilter` gives: this package depends on `@nestjs/platform-express`, not on
 * `express`, and naming the Express typings here would be importing something it does not declare.
 *
 * `ip` is Express's, and it is the real client only because `bootstrap.ts` configures `trust proxy`
 * — without that it is the edge, and every per-IP bucket in this module counts one caller (T15).
 */
interface AuthenticatingRequest extends CookieBearingRequest {
  readonly headers?: Readonly<Record<string, string | string[] | undefined>>;
  readonly ip?: string;
}

@ApiTags('auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  private readonly cookieName: string;

  constructor(
    private readonly login: LoginService,
    private readonly signup: SignupService,
    private readonly verification: EmailVerificationService,
    private readonly account: AccountService,
    config: ConfigService<Environment, true>,
  ) {
    this.cookieName = config.get('SESSION_COOKIE_NAME', { infer: true });
  }

  /**
   * `202`, always, with the same body for an address that has an account and one that does not
   * (ADR 007).
   *
   * "Accepted" rather than "Created" because the endpoint will not say which happened — a `201` for
   * a new address beside a `202` for a taken one would be the enumeration oracle the whole design
   * avoids, told in the status line before the body was even read.
   *
   * Note what this method does not take: no `@Res`. There is nothing to write a cookie to, which is
   * deliberate. Signing a new account straight in would establish a session on one branch and not
   * the other, and no amount of care over the body would cover that. A caller signs in afterwards
   * like anybody else.
   */
  @Public()
  // §03, T31. Verification only — the challenge is issued at the Cloudflare edge — and inert on a
  // deployment with no `TURNSTILE_SECRET_KEY`, which every developer machine is. Ahead of the pipe
  // that validates the body, because guards run before pipes: an automated caller with no token is
  // turned away before anything is parsed, hashed or written.
  @UseGuards(TurnstileGuard)
  @Post('signup')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Register an account, or notify the address that it already has one' })
  async signUp(@Body() body: SignupDto): Promise<SignupResponse> {
    await this.signup.register({
      email: body.email,
      ...(body.next === undefined ? {} : { next: body.next }),
      password: body.password,
    });

    // Built here rather than returned by the service, so there is exactly one expression in the
    // codebase that decides what signup answers with, and it takes no arguments.
    return { status: SIGNUP_ACCEPTED };
  }

  /**
   * `POST /auth/verify` (criterion 2). `@Public()`, because the whole point of a mailed link is
   * that it works in the browser the mail was opened in, which is not the one holding the session.
   *
   * `200` rather than `204`: the body is a constant, but a client that has just confirmed an
   * address needs something to parse to know it succeeded, and a `204` would make "verified" and
   * "some proxy ate the response" the same event.
   *
   * The token arrives in the body rather than in the URL. The link the mail carries *is* a query
   * parameter — `links.ts` argues that at length, because T09's scrubber censors credentials by
   * parameter name — but the web app reads it from its own URL and posts it, so the token reaches
   * this API in a body no access log records.
   */
  @Public()
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm an email address with the token from its verification link' })
  async verifyEmail(@Body() body: VerifyEmailDto): Promise<VerifyEmailResponse> {
    await this.verification.confirm(body.token);

    return { status: EMAIL_VERIFIED };
  }

  /**
   * `202`, always, with the same body for an address that has an account, one that has already
   * confirmed, and one that has never registered.
   *
   * The same constant signup answers with, and deliberately so: this endpoint takes the same input
   * signup takes, and an enumeration-safe signup beside a resend that said "no such account" would
   * be one endpoint's property undone by the next one along (ADR 007).
   */
  @Public()
  @Post('verify/resend')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Send a fresh verification link, if the address is awaiting one' })
  async resendVerification(
    @Body() body: ResendVerificationDto,
    @Req() incoming: AuthenticatingRequest,
  ): Promise<ResendVerificationResponse> {
    // Through `deviceFingerprintOf` rather than reading `incoming.ip` directly, so the per-IP
    // bucket here is keyed exactly as the one in `LoginService` is — same normalisation, same
    // fallback for a request that arrived without one.
    await this.verification.resend({
      email: body.email,
      ...(body.next === undefined ? {} : { next: body.next }),
      ip: deviceFingerprintOf(deviceOf(incoming)).ip,
    });

    return { status: VERIFICATION_RESEND_ACCEPTED };
  }

  /**
   * `@Public()` because a caller with a session is not who this is for — and because the throttle,
   * not the guard, is what protects it.
   */
  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Exchange an email and password for a session cookie' })
  async signIn(
    @Body() body: LoginDto,
    @Req() incoming: AuthenticatingRequest,
    @Res({ passthrough: true }) response: CookieWritingResponse,
  ): Promise<LoginResponse> {
    const outcome = await this.login.authenticate({
      currentToken: readSessionCookie(incoming, this.cookieName),
      device: deviceFingerprintOf(deviceOf(incoming)),
      email: body.email,
      password: body.password,
    });

    // Written on both arms, because both establish a session — what differs is what that session is
    // allowed to do, not whether it exists. The challenge is bound to this cookie and to nothing in
    // the body, which is what stops one caller answering another's challenge.
    setSessionCookie(response, this.cookieName, outcome.session.token, outcome.session.ttlSeconds);

    // Criterion 4. The account is named only on the arm where the caller has finished proving they
    // own it; the other says nothing but the word, for the reason `login.ts` gives at length.
    if (outcome.kind === 'mfa-required') {
      return { status: MFA_REQUIRED };
    }

    // The token is written to the cookie above and to nothing else. Criterion 3, and the reason
    // both arms of `loginResponseSchema` are strict objects with no room for one.
    return { user: outcome.user };
  }

  /**
   * `GET /auth/me` — the account this request's cookie resolves to.
   *
   * The one route on this controller that is **not** `@Public()`, and the only sensible answer for
   * a caller without a session is the `401` `SessionGuard` already gives them. That refusal is the
   * response: a single-page app calls this on first paint precisely to find out whether the cookie
   * the browser kept is still live, and a `200` carrying `{ user: null }` would make "signed out"
   * and "signed in" the same status code for every proxy, cache and error handler in between.
   *
   * `@CurrentUser()` is therefore present rather than optional, and it is also the whole of the
   * authorisation — the same argument `MfaController` and `SessionController` make. The handler
   * takes no id from the request, so a signed-in caller can only ever describe *themselves*; a
   * `userId` parameter here would be a lookup of anybody's address by uuid.
   *
   * The body is `signedInResponseSchema` under another name (`me.ts` argues why), so resuming a
   * session and completing one produce the same shape and a client has one branch to write. No
   * `@Res`: reading who you are neither establishes nor rotates anything, and a route that quietly
   * extended the session on every poll would be a fortnight's idle timeout that never expires.
   */
  @Get('me')
  @ApiOperation({ summary: 'Resolve the account the current session belongs to' })
  async me(@CurrentUser() caller: AuthenticatedUser): Promise<CurrentUserResponse> {
    return { user: await this.account.describe(caller.userId) };
  }

  /**
   * `@Public()` and always `204`.
   *
   * Guarding this would answer a caller whose session expired in an open tab with a 401 — leaving
   * them holding a cookie the response did not clear, on a page that still believes they are signed
   * in. Signing out is idempotent: whatever the caller presented is gone afterwards, including
   * when it was already gone.
   */
  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke the current session and clear its cookie' })
  async signOut(
    @Req() incoming: AuthenticatingRequest,
    @Res({ passthrough: true }) response: CookieClearingResponse,
  ): Promise<void> {
    const token = readSessionCookie(incoming, this.cookieName);

    if (token !== undefined) {
      await this.login.signOut(token);
    }

    clearSessionCookie(response, this.cookieName);
  }
}

/** `User-Agent` can legitimately arrive more than once; the first one is the request's own. */
function deviceOf(incoming: AuthenticatingRequest): DeviceBearingRequest {
  const userAgent = incoming.headers?.['user-agent'];

  return {
    ip: incoming.ip,
    userAgent: Array.isArray(userAgent) ? userAgent[0] : userAgent,
  };
}
