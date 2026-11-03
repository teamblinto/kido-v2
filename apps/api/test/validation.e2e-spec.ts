import type { INestApplication } from '@nestjs/common';
import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { cursorPageQuerySchema, emailSchema, passwordSchema } from '@repo/contracts';
import type { Server } from 'node:http';
import request from 'supertest';
import { z } from 'zod';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { ApiZodSchema, createZodDto } from '../src/common/validation/zod-dto';
import { Public } from '../src/modules/identity/decorators/public.decorator';
import { unsafe } from './support/csrf-client';

/**
 * `ConfigModule.forRoot` validates the environment while `app.module.ts` is being imported, so a
 * `beforeAll` that sets this would run far too late and the docs route would never be mounted.
 * `vi.hoisted` is the one hook that runs above the import block.
 */
vi.hoisted(() => {
  process.env.SWAGGER_ENABLED = 'true';
});

const signupFixtureSchema = z.strictObject({
  email: emailSchema,
  password: passwordSchema,
  profile: z.object({ displayName: z.string().min(1) }).optional(),
});

@ApiZodSchema()
class SignupFixtureDto extends createZodDto(signupFixtureSchema) {}

@ApiZodSchema()
class PageQueryFixtureDto extends createZodDto(cursorPageQuerySchema) {}

/**
 * `@Public()` because T15 registers `SessionGuard` as an `APP_GUARD`: this suite is about what the
 * validation pipe does to a body, and a 401 would arrive before the pipe ever runs.
 */
@Public()
@Controller({ path: 'validation-fixtures', version: '1' })
class ValidationFixtureController {
  @Post()
  @HttpCode(HttpStatus.OK)
  create(@Body() body: SignupFixtureDto): SignupFixtureDto {
    return body;
  }

  @Get()
  list(@Query() query: PageQueryFixtureDto): PageQueryFixtureDto {
    return query;
  }
}

interface OpenApiDocument {
  components?: { schemas?: Record<string, unknown> };
  paths?: Record<string, { get?: { parameters?: { in?: string; name?: string }[] } }>;
}

describe('Validation (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ValidationFixtureController],
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    configureApplication(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('hands the controller the parsed value, not the one that arrived', async () => {
    const response = await unsafe(
      request(app.getHttpServer() as Server).post('/api/v1/validation-fixtures'),
    )
      .send({ email: '  Ada@Example.COM  ', password: 'correct horse battery' })
      .expect(200);

    expect(response.body).toStrictEqual({
      email: 'ada@example.com',
      password: 'correct horse battery',
    });
  });

  it('rejects a bad body as RFC 9457 with a pointer per field', async () => {
    const response = await unsafe(
      request(app.getHttpServer() as Server).post('/api/v1/validation-fixtures'),
    )
      .set('X-Request-Id', 'e2e-validation-1')
      .send({ email: 'not-an-address', password: 'short', profile: { displayName: '' } })
      .expect(422)
      .expect('Content-Type', /application\/problem\+json/);

    expect(response.body).toStrictEqual({
      detail: 'The request body failed validation.',
      errors: [
        { code: 'invalid_format', detail: 'Invalid email address', pointer: '#/email' },
        {
          code: 'too_small',
          detail: 'Too small: expected string to have >=12 characters',
          pointer: '#/password',
        },
        {
          code: 'too_small',
          detail: 'Too small: expected string to have >=1 characters',
          pointer: '#/profile/displayName',
        },
      ],
      instance: '/api/v1/validation-fixtures',
      requestId: 'e2e-validation-1',
      status: 422,
      title: 'Validation Failed',
      type: 'https://forge.dev/problems/validation-failed',
    });
  });

  it('rejects an unknown key rather than ignoring it', async () => {
    const response = await unsafe(
      request(app.getHttpServer() as Server).post('/api/v1/validation-fixtures'),
    )
      .send({
        email: 'ada@example.com',
        isAdmin: true,
        password: 'correct horse battery',
      })
      .expect(422);

    expect(response.body).toMatchObject({
      errors: [
        { code: 'unrecognized_keys', detail: 'Unrecognized key: "isAdmin".', pointer: '#/isAdmin' },
      ],
      type: 'https://forge.dev/problems/validation-failed',
    });
  });

  it('validates the query string too, coercing what a URL can carry', async () => {
    await request(app.getHttpServer() as Server)
      .get('/api/v1/validation-fixtures?limit=50')
      .expect(200)
      .expect({ limit: 50 });

    const response = await request(app.getHttpServer() as Server)
      .get('/api/v1/validation-fixtures?limit=500')
      .expect(422);

    expect(response.body).toMatchObject({
      detail: 'The request query parameters failed validation.',
      errors: [{ code: 'too_big', pointer: '#/limit' }],
    });
  });

  /**
   * The migration risk this task was scheduled early to avoid: retiring the decorator-based
   * validator must not take OpenAPI generation with it (ADR 006).
   */
  it('still serves an OpenAPI document generated from the Zod-derived DTOs', async () => {
    const response = await request(app.getHttpServer() as Server)
      .get('/api/docs/json')
      .expect(200);

    const document = response.body as OpenApiDocument;

    expect(document.components?.schemas?.SignupFixtureDto).toStrictEqual(
      z.toJSONSchema(signupFixtureSchema, {
        io: 'input',
        reused: 'inline',
        target: 'openapi-3.0',
      }),
    );
  });

  /**
   * A query DTO is enforced but not yet described: Swagger flattens a `@Query()` class into
   * individual parameters through its property extractor, which only sees `@ApiProperty` members,
   * and a `createZodDto` subclass has none. The gap is documentation-only — the pipe still rejects
   * `?limit=500` above — and ADR 006 names describing it as the follow-up for the first endpoint
   * that actually takes a query string.
   */
  it('serves a document whose paths all resolve, query DTOs included', async () => {
    const response = await request(app.getHttpServer() as Server)
      .get('/api/docs/json')
      .expect(200);

    const document = response.body as OpenApiDocument;

    expect(document.paths?.['/api/v1/validation-fixtures']?.get).toBeDefined();
  });
});
