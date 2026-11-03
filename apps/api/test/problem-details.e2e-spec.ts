import type { INestApplication } from '@nestjs/common';
import { Controller, Get, Logger, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { ConflictError, RateLimitedError } from '../src/common/errors/domain-error';
import { Public } from '../src/modules/identity/decorators/public.decorator';

/**
 * `@Public()` because T15 registers `SessionGuard` as an `APP_GUARD`: without it every fixture here
 * answers 401 and the suite would be asserting the guard's problem document, not the filter's.
 */
@Public()
@Controller({ path: 'problem-fixtures', version: '1' })
class ProblemFixtureController {
  @Get('conflict')
  conflict(): never {
    throw new ConflictError('That email address is already registered.');
  }

  @Get('crash')
  crash(): never {
    throw new Error('query failed on postgres://forge:hunter2@db:5432/forge');
  }

  @Get('missing')
  missing(): never {
    throw new NotFoundException('No such widget.');
  }

  @Get('throttled')
  throttled(): never {
    throw new RateLimitedError('Too many verification attempts.', 30);
  }
}

describe('Problem details (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.SWAGGER_ENABLED = 'false';
    const module = await Test.createTestingModule({
      controllers: [ProblemFixtureController],
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    configureApplication(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('renders a domain error as RFC 9457 with the correlation id echoed back', async () => {
    const response = await request(app.getHttpServer() as Server)
      .get('/api/v1/problem-fixtures/conflict')
      .set('X-Request-Id', 'e2e-conflict-1')
      .expect(409)
      .expect('Content-Type', /application\/problem\+json/);

    expect((response.headers as Record<string, string>)['x-request-id']).toBe('e2e-conflict-1');
    expect(response.body).toStrictEqual({
      detail: 'That email address is already registered.',
      instance: '/api/v1/problem-fixtures/conflict',
      requestId: 'e2e-conflict-1',
      status: 409,
      title: 'Conflict',
      type: 'https://forge.dev/problems/conflict',
    });
  });

  it('renders a framework exception through the same catalogue', async () => {
    const response = await request(app.getHttpServer() as Server)
      .get('/api/v1/problem-fixtures/missing')
      .expect(404)
      .expect('Content-Type', /application\/problem\+json/);

    expect(response.body).toMatchObject({
      detail: 'No such widget.',
      requestId: expect.any(String) as unknown,
      status: 404,
      title: 'Not Found',
      type: 'https://forge.dev/problems/not-found',
    });
  });

  it('sets Retry-After on a rate limited error', async () => {
    const response = await request(app.getHttpServer() as Server)
      .get('/api/v1/problem-fixtures/throttled')
      .expect(429)
      .expect('Content-Type', /application\/problem\+json/);

    expect((response.headers as Record<string, string>)['retry-after']).toBe('30');
    expect(response.body).toMatchObject({
      retryAfter: 30,
      type: 'https://forge.dev/problems/rate-limited',
    });
  });

  it('never leaks an unexpected error to the client', async () => {
    const response = await request(app.getHttpServer() as Server)
      .get('/api/v1/problem-fixtures/crash')
      .expect(500)
      .expect('Content-Type', /application\/problem\+json/);

    const serialised = JSON.stringify(response.body);

    expect(response.body).toMatchObject({
      status: 500,
      title: 'Internal Server Error',
      type: 'https://forge.dev/problems/internal-server-error',
    });
    expect(serialised).not.toContain('hunter2');
    expect(serialised).not.toContain('postgres');
    expect(serialised).not.toContain('.ts:');
  });

  /**
   * ## The case criterion 17 turns on, and the one nothing else here reaches
   *
   * Every other assertion in this file is about an exception a handler *threw*, which reaches
   * `ProblemDetailsFilter` because Nest routed the request to a handler in the first place. A URL
   * that matches no route never reaches one, and the received wisdom about Nest on Express is that
   * such a request falls through to Express's default handler and is answered in HTML — which would
   * make criterion 17's "**every** error response is a valid RFC 9457 document" false for the single
   * most common error a public API emits, and would have gone unnoticed because no test asked.
   *
   * It is not true here. Nest raises its own `NotFoundException` for an unmatched route, inside the
   * request pipeline, so the global filter renders it exactly like any other. The four paths below
   * are the four shapes worth distinguishing — inside the version, inside the prefix but outside the
   * version, outside the prefix entirely, and the bare root — because the global prefix registers
   * wildcard routes of its own and a change in how it does so could easily hold for one and not the
   * others.
   *
   * This test exists so the property is a fact rather than a belief, and so the day a Nest upgrade
   * or an added `app.use` changes it, the criterion fails instead of quietly becoming untrue.
   */
  /**
   * Malformed JSON is the client's mistake, so a 400 — and its parser message, which quotes the body
   * (a one-time code, say, on `/me/subscriptions/claude/code`), is neither answered nor logged.
   */
  it('answers malformed JSON with a 400 that never echoes or logs a body fragment', async () => {
    const secret = 'SECRET-sign-in-code-4f1c';
    const captured: string[] = [];
    const capture = (chunk: unknown) => {
      captured.push(String(chunk));
      return true;
    };
    const spies = [
      vi.spyOn(process.stdout, 'write').mockImplementation(capture),
      vi.spyOn(process.stderr, 'write').mockImplementation(capture),
      ...(['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
        vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
          captured.push(JSON.stringify(args));
        }),
      ),
    ];

    try {
      const response = await request(app.getHttpServer() as Server)
        .post('/api/v1/me/subscriptions/claude/code')
        .set('Content-Type', 'application/json')
        .send(`{"code":${secret}`)
        .expect(400)
        .expect('Content-Type', /application\/problem\+json/);

      expect(response.body).toMatchObject({
        detail: 'Bad Request',
        status: 400,
        type: 'https://forge.dev/problems/bad-request',
      });
      expect(JSON.stringify(response.body)).not.toContain(secret);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    expect(captured.join('\n')).not.toContain(secret);
  });

  it.each([
    ['under the version', '/api/v1/no-such-route'],
    ['under the prefix but not the version', '/api/no-such-route'],
    ['outside the prefix entirely', '/no-such-route'],
    ['the bare root', '/'],
  ])('answers an unmatched route %s with a problem document, not HTML', async (_name, path) => {
    const response = await request(app.getHttpServer() as Server)
      .get(path)
      .expect(404)
      .expect('Content-Type', /application\/problem\+json/);

    expect(response.body).toMatchObject({
      instance: path,
      requestId: expect.any(String) as unknown,
      status: 404,
      title: 'Not Found',
      type: 'https://forge.dev/problems/not-found',
    });
  });
});
