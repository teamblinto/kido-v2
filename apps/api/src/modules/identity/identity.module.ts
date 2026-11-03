import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { RatelimitModule } from '../../common/ratelimit/ratelimit.module';
import { OutboxModule } from '../outbox/outbox.module';
import { AuthController } from './controllers/auth.controller';
import { MfaController } from './controllers/mfa.controller';
import { OauthController } from './controllers/oauth.controller';
import { PasswordController } from './controllers/password.controller';
import { SessionController } from './controllers/session.controller';
import { SessionGuard } from './guards/session.guard';
import { StepUpGuard } from './guards/step-up.guard';
import { TurnstileGuard } from './guards/turnstile.guard';
import { PasswordModule } from './password/password.module';
import { AccountService } from './services/account.service';
import { EmailVerificationService } from './services/email-verification.service';
import {
  DEFAULT_GITHUB_ENDPOINTS,
  GITHUB_ENDPOINTS,
  GithubProvider,
} from './services/github.provider';
import {
  DEFAULT_GOOGLE_ENDPOINTS,
  GOOGLE_ENDPOINTS,
  GoogleProvider,
} from './services/google.provider';
import { IdentityMailConsumer } from './services/identity-mail.consumer';
import { LoginService } from './services/login.service';
import { OAUTH_PROVIDERS_PORT } from './services/oauth-provider.port';
import { OauthService } from './services/oauth.service';
import { MfaService } from './services/mfa.service';
import { PasswordChangeService } from './services/password-change.service';
import { PasswordResetService } from './services/password-reset.service';
import { SessionService } from './services/session.service';
import { SignupService } from './services/signup.service';
import { TokenService } from './services/token.service';

/**
 * Identity: sessions today, and the login, CSRF, MFA and OAuth that hang off them next.
 *
 * `SessionGuard` is registered here as an `APP_GUARD` rather than applied per controller, which is
 * what makes authentication the application's default and `@Public()` the deliberate exception. A
 * guard each route opts into is a guard that some route will not opt into, and that route looks
 * exactly like the others in review.
 *
 * Registering it from this module rather than from `AppModule` keeps the guard's dependency — the
 * session store — inside the module that owns it: `AppModule` never has to know that authenticating
 * a request costs a Redis lookup.
 */
@Module({
  controllers: [
    AuthController,
    MfaController,
    OauthController,
    PasswordController,
    SessionController,
  ],
  // `TokenService` is exported for T29. `token.service.ts` was written for three callers — email
  // verification, password reset and invitations — and the third lives in `TenancyModule`. A second
  // single-use-token primitive over there is exactly what this export exists to prevent.
  exports: [AccountService, SessionService, TokenService],
  // `OutboxModule` for `OutboxWriter`: the four mail-sending flows append an event and answer
  // (spec 006); the consumer that drains it is the provider below.
  imports: [OutboxModule, PasswordModule, RatelimitModule],
  providers: [
    // Exported for one method: `noticeAddress(userId)` is the only one other modules may call
    // (spec 032 R1: the BYOS mail has no organisation to ask membership for an address). `describe`
    // stays `GET /auth/me`'s; nothing else here is a reader of the `users` table for others.
    AccountService,
    EmailVerificationService,
    GithubProvider,
    GoogleProvider,
    // Not exported and not wired anywhere: `QueueRegistry` discovers it as a provider (spec 006
    // research R6). It issues the verification and reset tokens the mails carry, which is why it
    // lives beside `confirm` and `complete` rather than in `mail`.
    IdentityMailConsumer,
    LoginService,
    OauthService,
    // Where `github.com` and `accounts.google.com` are written down. Value providers rather than
    // environment variables, for the reason the tokens argue: these are not a deployment's decision
    // the way a client id is, and each e2e suite overrides one symbol to point an adapter at a
    // local stub.
    { provide: GITHUB_ENDPOINTS, useValue: DEFAULT_GITHUB_ENDPOINTS },
    { provide: GOOGLE_ENDPOINTS, useValue: DEFAULT_GOOGLE_ENDPOINTS },
    // The adapter list `OauthService` indexes by provider. Assembled here rather than injected one
    // class at a time so another provider is one entry in this array and no change at all to the
    // core — which is exactly what T23 turned out to be. `identity.module.spec.ts` asserts the list
    // now covers every published provider exactly once: a duplicate would not throw, it would
    // silently win the `Map` and make array order decide which adapter is reached, and a gap would
    // answer a provider the contract publishes as though an operator had switched it off.
    {
      inject: [GithubProvider, GoogleProvider],
      provide: OAUTH_PROVIDERS_PORT,
      useFactory: (github: GithubProvider, google: GoogleProvider) => [github, google],
    },
    // Not exported. Enrolling, challenging and stepping up all happen inside this module, and the
    // day another one needs to ask "does this account have MFA" is the day to decide what exactly
    // it may ask — rather than to have handed it the whole service in advance.
    MfaService,
    PasswordChangeService,
    PasswordResetService,
    SessionService,
    SignupService,
    // Not exported. T19 and T29 reuse the class, but each gets its own instance from its own
    // module: it holds no state, and exporting it would make "which flows mint tokens" a question
    // about this module's consumers rather than about their own provider lists.
    TokenService,
    // An ordinary provider rather than another `APP_GUARD`, and `turnstile.guard.ts` argues why:
    // an anti-automation check is a property of the two unauthenticated routes that cost money to
    // abuse, not of every route in the application. Listed here so Nest instantiates it during
    // `onModuleInit` — which is where its one boot-time warning comes from — rather than lazily on
    // the first request that reaches a handler carrying `@UseGuards(TurnstileGuard)`.
    TurnstileGuard,
    { provide: APP_GUARD, useClass: SessionGuard },
    // After `SessionGuard`, and the order is load-bearing: Nest runs `APP_GUARD`s in declaration
    // order, and this one reads the principal the first resolves. It fails closed on a missing
    // principal, so swapping the two would 403 every `@StepUp()` route rather than open one —
    // `identity.module.spec.ts` asserts the order so that failure is never a mystery.
    { provide: APP_GUARD, useClass: StepUpGuard },
  ],
})
export class IdentityModule {}
