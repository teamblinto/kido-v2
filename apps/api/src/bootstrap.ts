import type { INestApplication, INestApplicationContext, LoggerService } from '@nestjs/common';
import { VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';

import { ProblemDetailsFilter, scrubBodyParserError } from './common/errors/problem-details.filter';
import { ZodValidationPipe } from './common/validation/zod-validation.pipe';
import { type Environment, parseCorsOrigins } from './config/environment';

/**
 * How many proxies sit between a client and this process. §03 puts exactly one on the node —
 * Caddy in the architecture and in the compose stack alike (spec 025) — terminating TLS and
 * appending the peer it saw to `X-Forwarded-For`.
 *
 * The number is what Express counts back from the socket to decide which entry of that header is
 * the client, and it has to be a count rather than `true`. `trust proxy: true` believes the whole
 * header, and the whole header is attacker-supplied: anyone may send
 * `X-Forwarded-For: 1.2.3.4` and be counted as 1.2.3.4 by every per-IP bucket in T16. Trusting a
 * fixed number of hops means only the entry the proxy itself appended is believed.
 *
 * It is a constant rather than a setting for the same reason there is no `COOKIE_SECURE`: the value
 * is a property of the deployment topology §03 fixes, and a wrong value disables a rate limit
 * without failing anything.
 */
const TRUSTED_PROXY_HOPS = 1;

/**
 * The largest body the JSON parser will read, and so the ceiling on the raw buffer every request
 * now keeps (research R8). The parser's own default is 100 kB, which a large push or a repository
 * import delivery from GitHub exceeds; 1 MB clears their documented 25 MB-free payloads for the
 * events this feature subscribes to while keeping the per-request cost bounded and known.
 *
 * A constant rather than a setting, for `TRUSTED_PROXY_HOPS`' reason: a deployment that raised it
 * would be changing what the platform accepts on every route, not configuring this one.
 */
export const WEBHOOK_BODY_LIMIT = '1mb';

/**
 * The part of the platform's HTTP server this module configures, declared structurally so that
 * `bootstrap.ts` does not take a dependency on the Express typings that `@repo/api` does not
 * declare — the same reason `ProblemDetailsFilter` describes its response that way.
 */
interface ProxyAwareHttpServer {
  set(setting: string, value: unknown): unknown;
}

/**
 * The one method of `NestExpressApplication` this function needs, declared the same structural way
 * and for the same reason: every caller — `main.ts` and every e2e suite — holds an
 * `INestApplication`, and widening that parameter to the platform type would push the platform
 * typings into forty test files to configure one parser.
 */
interface BodyParserAwareApplication {
  useBodyParser(type: string, options: { limit: string }): unknown;
}

export function configureApplication(app: INestApplication): void {
  const config = app.get(ConfigService<Environment, true>);
  const prefix = config.get('API_PREFIX', { infer: true });

  // Before anything that reads an address or a cookie. Without this, `request.ip` is the proxy on
  // every request, which does not fail — it silently collapses every per-IP limit onto one bucket.
  (app.getHttpAdapter().getInstance() as ProxyAwareHttpServer).set(
    'trust proxy',
    TRUSTED_PROXY_HOPS,
  );

  app.enableCors({
    credentials: true,
    origin: parseCorsOrigins(config.get('CORS_ORIGINS', { infer: true })),
  });
  app.enableShutdownHooks();
  app.enableVersioning({
    defaultVersion: config.get('API_VERSION', { infer: true }),
    type: VersioningType.URI,
  });
  app.setGlobalPrefix(prefix);
  // The raw bytes the signature is over are kept by `rawBody: true` on the factory (`main.ts`,
  // research R8); this sets the ceiling on them. Registered here rather than left at the parser's
  // default so the limit is one number a reviewer can find beside the decision that needs it.
  (app as unknown as BodyParserAwareApplication).useBodyParser('json', {
    limit: WEBHOOK_BODY_LIMIT,
  });
  // Next to the parser, so its refusal (malformed JSON quotes the body) goes on without the body.
  app.use(scrubBodyParserError);
  app.use(helmet());
  app.use(compression());
  // Unsigned on purpose. The session cookie is 32 opaque random bytes whose only meaning is a Redis
  // key, so there is nothing in it for a signature to protect and no secret to rotate; signing it
  // would only add a second way for the cookie to be rejected. The CSRF cookie is not signed for a
  // different reason: it is compared against a header the client copied it into, so a signature
  // would authenticate a value we already only trust for being equal to itself (T17).
  //
  // Registered here, which is what puts it in front of `CsrfMiddleware`. Everything this function
  // installs with `app.use` runs before the middleware Nest registers from a module during
  // `init()`, so `request.cookies` is populated by the time the CSRF check reads it. A CSRF
  // middleware that ran first would see no cookies at all and refuse every unsafe request.
  app.use(cookieParser());
  app.useGlobalFilters(new ProblemDetailsFilter());
  // One validation system on the boundary, and it is the one `@repo/contracts` describes (ADR 006).
  // The `whitelist` / `forbidNonWhitelisted` options this replaces are properties of each schema
  // now rather than global flags — see `ZodValidationPipe`.
  app.useGlobalPipes(new ZodValidationPipe());

  if (config.get('SWAGGER_ENABLED', { infer: true })) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('API')
      .setDescription('Production monorepo API')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup(`${prefix}/docs`, app, document, {
      jsonDocumentUrl: `${prefix}/docs/json`,
    });
  }
}

/**
 * Hand the buffered boot logs to `logger` and route every later `Logger` call to it.
 *
 * The flush is not optional: `main.ts` boots with `autoFlushLogs: false`, under which `useLogger`
 * leaves Nest's buffer attached, and every `new Logger(...)` line after boot (the executor's
 * `checkpoint failed` among them) went into that buffer for the life of the process.
 */
export function adoptLogger(app: INestApplicationContext, logger: LoggerService): void {
  app.useLogger(logger);
  app.flushLogs();
}
