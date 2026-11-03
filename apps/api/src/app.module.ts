import { Module, RequestMethod } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';

import { AppController } from './app.controller';
import { ClockModule } from './common/clock/clock.module';
import { CryptoModule } from './common/crypto/crypto.module';
import { CsrfModule } from './common/csrf/csrf.module';
import { IdempotencyInterceptor } from './common/idempotency/idempotency.interceptor';
import { IdempotencyModule } from './common/idempotency/idempotency.module';
import { RedisModule } from './common/redis/redis.module';
import { RunProfilesModule } from './common/run-profiles/run-profiles.module';
import { REDACTED_PATHS, REDACTION_CENSOR } from './common/telemetry/redaction';
import { createLogDestination } from './common/telemetry/scrubber';
import { type Environment, validateEnvironment } from './config/environment';
import { DatabaseModule } from './database/database.module';
import { AgentModule } from './modules/agent/agent.module';
import { AuditModule } from './modules/audit/audit.module';
import { CheckpointsModule } from './modules/checkpoints/checkpoints.module';
import { ConnectorsModule } from './modules/connectors/connectors.module';
import { PreviewEnvModule } from './modules/connectors/preview-env.module';
import { DeployModule } from './modules/deploy/deploy.module';
import { LocalAgentModule } from './modules/local-agent/local-agent.module';
import { HealthModule } from './modules/health/health.module';
import { IdentityModule } from './modules/identity/identity.module';
import { MailModule } from './modules/mail/mail.module';
import { OutboxModule } from './modules/outbox/outbox.module';
import { PreviewModule } from './modules/preview/preview.module';
import { RbacModule } from './modules/rbac/rbac.module';
import { SandboxModule } from './modules/sandbox/sandbox.module';
import { TenancyModule } from './modules/tenancy/tenancy.module';
import { HooksHostModule } from './modules/webhooks/inbound/hooks-host.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      cache: true,
      expandVariables: true,
      // The suites build their environment in `test/support/test-environment.ts`; the developer's
      // `apps/api/.env` must not leak into them (a model key there is refused beside `RUN_PROFILES=api`,
      // spec 013 R10). The two suites that reach a real Daytona or model load it explicitly.
      ignoreEnvFile: process.env.NODE_ENV === 'test',
      isGlobal: true,
      validate: validateEnvironment,
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: async (config: ConfigService<Environment, true>) => {
        const isDevelopment = config.get('NODE_ENV', { infer: true }) === 'development';

        return {
          // Explicit rather than left to `nestjs-pino`'s default of `[{ path: '*', method: ALL }]`.
          // That default is Express 4 syntax: under Express 5 Nest only reaches the router by
          // auto-converting it, logging a `LegacyRouteConverter` warning per registration on every
          // boot. The named wildcard is the same catch-all `CsrfModule` applies, for the reason
          // spelled out there -- a bare `*` no longer degrades quietly, it throws.
          forRoutes: [{ method: RequestMethod.ALL, path: '*splat' }],
          // The stream replaces the old `transport`: pino accepts one or the other, and the
          // scrubber has to sit in front of the renderer so nothing leaves unscrubbed in either
          // environment. Pretty-printing moves behind it, unchanged (`common/telemetry/scrubber`).
          pinoHttp: [
            {
              level: config.get('LOG_LEVEL', { infer: true }),
              redact: {
                paths: [...REDACTED_PATHS],
                censor: REDACTION_CENSOR,
              },
            },
            await createLogDestination({ pretty: isDevelopment }),
          ] as const,
        };
      },
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Environment, true>) => [
        {
          limit: config.get('THROTTLE_LIMIT', { infer: true }),
          ttl: config.get('THROTTLE_TTL_MS', { infer: true }),
        },
      ],
    }),
    // First of the plain modules, because middleware runs in the order the modules that register
    // it are resolved and criterion 15's check has to be in front of everything an unsafe request
    // could otherwise reach.
    // Ahead of `CsrfModule`: on `HOOKS_HOST` a non-inbound path is an unknown route (spec 029,
    // contracts/hooks-origin.md), and that 404 must not depend on whether a CSRF token came with it.
    HooksHostModule,
    CsrfModule,
    ClockModule,
    RunProfilesModule,
    DatabaseModule,
    RedisModule,
    HealthModule,
    CryptoModule,
    AuditModule,
    MailModule,
    // Registers no consumer (FR-028); the outbox e2e suite overrides `EVENT_CONSUMERS` with a probe.
    OutboxModule,
    IdentityModule,
    RbacModule,
    // After `RbacModule`, whose `APP_GUARD` these routes are the first real consumers of. The order
    // of these two does not change guard ordering — `TenancyModule` registers none — but reading
    // them in dependency order is what keeps the guard chain legible.
    TenancyModule,
    // After `TenancyModule`, whose `ProjectService` it imports (spec 008).
    AgentModule,
    // Spec 040: registers no guard globally; its executor registers itself with `AgentModule`.
    LocalAgentModule,
    // Registers no controller and no guard (spec 010), so the guard order above is unchanged; 011
    // is the first consumer of its port.
    SandboxModule,
    // Registers no guard (spec 016); the history routes and the turn-end commit arrive with it.
    CheckpointsModule,
    // Registers three controllers and no `APP_GUARD` (spec 017): `SandboxCallbackGuard` is
    // module-scoped, so the guard order above is unchanged; the broker paths live on their own listener.
    PreviewModule,
    // Registers no guard (spec 018); after `PreviewModule`, whose global minter the sandbox ops consumer it pulls in needs.
    ConnectorsModule,
    // Spec 030 contracts/preview-env.md § 3: `PREVIEW_ENV_SOURCE` for the sandbox delivery, global.
    PreviewEnvModule,
    // Registers no guard (spec 027); after `ConnectorsModule`, beside the other modules that import
    // `CheckpointsModule` and `SandboxModule`.
    DeployModule,
    // Registers no guard (spec 029).
    WebhooksModule,
    IdempotencyModule,
  ],
  controllers: [AppController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // §14: every unsafe endpoint accepts `Idempotency-Key`. Application-wide, so a route accepts it
    // by existing — the endpoint that forgot a per-route decorator is the one that charges twice.
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
})
export class AppModule {}
