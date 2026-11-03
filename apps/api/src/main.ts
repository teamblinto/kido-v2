import 'reflect-metadata';

import { ConfigModule, ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

import { adoptLogger, configureApplication } from './bootstrap';
import type { Environment } from './config/environment';
import { parseRunProfiles } from './config/run-profiles';
import { BrokerListener, PLAIN_BROKER_HOST } from './modules/preview/broker-listener';

/**
 * One root module, two factories (spec 013, research R2). A second root module for the worker was
 * rejected: every worker profile needs the whole module set minus controllers — `events` needs
 * `IdentityModule` and `TenancyModule` for their mail consumers, `agent` needs `AgentModule` and
 * everything under it — and `createApplicationContext` already is "the whole set, no routes, no
 * middleware, no guards". The profile gates actors, not modules.
 *
 * The profile is read before `AppModule` exists because it picks the factory, and it is read
 * through `ConfigModule` rather than `process.env` because a developer's `RUN_PROFILES` lives in
 * `apps/api/.env`, which only `ConfigModule` loads — and the schema's validated value is a `Set`,
 * which `@nestjs/config` never copies back into `process.env`. The identity `validate` makes this
 * call do exactly the load half of what `AppModule`'s `forRoot` does: `.env` under `process.env`.
 *
 * A refusal — an unparsable profile here, or any schema issue when `AppModule` is decorated —
 * reaches stderr as its message alone: no stack, exit 1 (contract § 1). `forRoot` is `async`, so
 * the schema's refusal is a rejection that only surfaces when Nest awaits the import; hence
 * `abortOnError: false` (rethrown to the catch below rather than `process.exit`) and
 * `autoFlushLogs: false` (the exception handler's stack-bearing line stays in the buffer that
 * `adoptLogger` flushes only on the success path).
 */
const FACTORY_OPTIONS = { abortOnError: false, autoFlushLogs: false, bufferLogs: true } as const;

/**
 * Keep each request's untouched bytes on `request.rawBody` for the webhook signature check
 * (research R8). It is a factory option and not middleware because Nest installs its body parser
 * during `create()`, before `configureApplication` runs: anything registered later sees a body that
 * has already been parsed and would have to re-serialise it, and a JSON round trip changes bytes
 * and breaks every HMAC — silently. The worker factory below does not take it: it serves no
 * requests.
 */
const API_FACTORY_OPTIONS = { ...FACTORY_OPTIONS, rawBody: true } as const;

async function bootstrap(): Promise<void> {
  await ConfigModule.forRoot({ expandVariables: true, validate: (config) => config });
  const profiles = parseRunProfiles(process.env.RUN_PROFILES);
  const { AppModule } = await import('./app.module.js');

  if (profiles.has('api')) {
    const app = await NestFactory.create(AppModule, API_FACTORY_OPTIONS);
    const logger = app.get(Logger);
    const config = app.get(ConfigService<Environment, true>);

    adoptLogger(app, logger);
    configureApplication(app);

    const host = config.get('HOST', { infer: true });
    const port = config.get('PORT', { infer: true });
    await app.listen(port, host);
    logger.log(
      `API listening on http://${host}:${port} with profiles ${[...profiles].join(',')}`,
      'Bootstrap',
    );
    // The broker the gateway calls is a second listener beside the Nest one (spec 017 R4), never
    // `httpsOptions` on the factory; it closes with the application (`configureApplication` enables the hooks).
    await app.get(BrokerListener).listen();
    const transport = config.get('BROKER_TRANSPORT', { infer: true });
    logger.log(
      `broker (${transport}) listening on ${transport === 'mtls' ? `https://${host}` : `http://${PLAIN_BROKER_HOST}`}:${String(config.get('BROKER_PORT', { infer: true }))}`,
      'Bootstrap',
    );
    return;
  }

  const app = await NestFactory.createApplicationContext(AppModule, FACTORY_OPTIONS);
  const logger = app.get(Logger);

  adoptLogger(app, logger);
  app.enableShutdownHooks();
  logger.log(`worker booted with profiles ${[...profiles].join(',')}`, 'Bootstrap');
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
