import { Injectable, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { OAUTH_PROVIDERS } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import { ClockModule } from '../../common/clock/clock.module';
import { RedisModule } from '../../common/redis/redis.module';
import { RunProfilesModule } from '../../common/run-profiles/run-profiles.module';
import { validateEnvironment } from '../../config/environment';
import { DatabaseModule } from '../../database/database.module';
import { MailModule } from '../mail/mail.module';
import { CryptoModule } from '../../common/crypto/crypto.module';
import { MfaController } from './controllers/mfa.controller';
import { OauthController } from './controllers/oauth.controller';
import { SessionController } from './controllers/session.controller';
import { SessionGuard } from './guards/session.guard';
import { StepUpGuard } from './guards/step-up.guard';
import { IdentityModule } from './identity.module';
import { MfaService } from './services/mfa.service';
import { OAUTH_PROVIDERS_PORT, type OauthProviderPort } from './services/oauth-provider.port';
import { SessionService } from './services/session.service';

@Injectable()
class NeedsSessions {
  constructor(readonly sessions: SessionService) {}
}

@Module({ imports: [IdentityModule], providers: [NeedsSessions] })
class ConsumerModule {}

function compile(...imports: unknown[]) {
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ ignoreEnvFile: true, isGlobal: true, validate: validateEnvironment }),
      ClockModule,
      // `@Global` like the clock: the outbox behind the mailer asks it what this process runs.
      RunProfilesModule,
      // All three are `@Global`: `LoginService` reaches for the app pool and the session client,
      // and `SignupService` reaches for the mailer. None of them connects or sends while the graph
      // is built, so this stays a test about wiring.
      // `MfaService` seals the seed through the account-scoped half of the crypto module (T08).
      CryptoModule,
      DatabaseModule,
      MailModule,
      RedisModule,
      ...(imports as never[]),
    ],
  }).compile();
}

describe('IdentityModule', () => {
  it('provides a SessionService', async () => {
    const moduleRef = await compile(IdentityModule);

    expect(moduleRef.get(SessionService)).toBeInstanceOf(SessionService);
  });

  /**
   * The MFA routes are the ones an unwired module fails silently on: Nest answers a controller it
   * was never handed with a 404, which looks exactly like a route nobody has written yet.
   */
  it('registers the MFA controller and its service', async () => {
    const moduleRef = await compile(IdentityModule);

    expect(moduleRef.get(MfaService)).toBeInstanceOf(MfaService);
    expect(Reflect.getMetadata('controllers', IdentityModule)).toContain(MfaController);
  });

  /** Same silent failure, same assertion: an unregistered device list is a 404 that looks unbuilt. */
  it('registers the session controller', () => {
    expect(Reflect.getMetadata('controllers', IdentityModule)).toContain(SessionController);
  });

  /**
   * Criterion 9's routes, and the reason they are asserted here rather than left to the e2e suite:
   * an unregistered `OauthController` answers `404`, which is the *one* response the task's
   * disabled-when-unconfigured design exists to never send. A missing controller would look exactly
   * like a provider somebody switched off on purpose.
   */
  it('registers the OAuth controller', () => {
    expect(Reflect.getMetadata('controllers', IdentityModule)).toContain(OauthController);
  });

  /**
   * The adapter list, exhaustively — which is what T22 said this would become once T23 landed the
   * Google adapter, and the list is now closed in both directions.
   *
   * **No provider has two.** `OauthService` builds a `Map` from this list, so a second entry for one
   * provider does not throw: it silently wins, and which adapter is actually reached becomes a fact
   * about array order.
   *
   * **No published provider has none.** Until T23 a missing adapter was answered as
   * `oauth-provider-not-configured`, which was the honest description of a deployment that could not
   * complete a Google sign-in. Now that both adapters exist, that same answer for a provider in
   * `OAUTH_PROVIDERS` would mean something else entirely — a wiring mistake wearing the costume of a
   * deliberate operator choice, on a route whose whole design is that those two are told apart. This
   * assertion is what keeps the disguise unavailable, and it fails the day a third provider is added
   * to the contract and forgotten here.
   */
  it('provides exactly one adapter for every published provider', async () => {
    const moduleRef = await compile(IdentityModule);
    const adapters = moduleRef.get<OauthProviderPort[]>(OAUTH_PROVIDERS_PORT);
    const named = adapters.map((adapter) => adapter.provider);

    expect(new Set(named).size).toBe(named.length);
    expect([...named].sort()).toEqual([...OAUTH_PROVIDERS].sort());
  });

  /** Not `@Global`: only the identity flows have any business starting or resolving a session. */
  it('exports it, so a module that imports it can inject one', async () => {
    const moduleRef = await compile(ConsumerModule);

    expect(moduleRef.get(NeedsSessions, { strict: false }).sessions).toBeInstanceOf(SessionService);
  });

  /**
   * The registration that makes authentication the default. If this provider ever goes missing,
   * nothing fails to compile and no unit test changes colour — every route in the application
   * simply becomes public, which is why it is asserted here as a fact about the module's metadata
   * rather than left to whichever e2e suite happens to notice.
   */
  /**
   * And the second one, with the ordering it depends on.
   *
   * `StepUpGuard` reads the principal `SessionGuard` resolves, and Nest runs `APP_GUARD`s in the
   * order they are declared. Swapping these two lines would leave the step-up guard looking at a
   * request with no principal on every call — it fails closed, so nothing would be *insecure*, but
   * every `@StepUp()` route would 403 unconditionally and no unit test would say why. The order is
   * asserted rather than commented.
   */
  it('registers StepUpGuard as an APP_GUARD, after SessionGuard', () => {
    const providers = Reflect.getMetadata('providers', IdentityModule) as {
      provide?: unknown;
      useClass?: unknown;
    }[];
    const guards = providers
      .filter((provider) => provider.provide === APP_GUARD)
      .map((provider) => provider.useClass);

    expect(guards).toEqual([SessionGuard, StepUpGuard]);
  });

  it('registers SessionGuard as an APP_GUARD', () => {
    // Read off the module metadata rather than resolved from the container: Nest rewrites an
    // `APP_GUARD` entry onto a generated token when it builds the application, so `get(APP_GUARD)`
    // answers nothing even when the registration is there. The declaration is the invariant.
    const providers = Reflect.getMetadata('providers', IdentityModule) as unknown[];

    expect(providers).toContainEqual({ provide: APP_GUARD, useClass: SessionGuard });
  });
});
