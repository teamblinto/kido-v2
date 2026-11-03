import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { inject } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { CLOCK, type ClockPort } from '../src/common/clock/clock.port';
import { SystemClock } from '../src/common/clock/system-clock';

describe('API (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.SWAGGER_ENABLED = 'false';
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    configureApplication(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1', async () => {
    const response = await request(app.getHttpServer() as Server)
      .get('/api/v1')
      .expect(200);
    expect(response.body).toMatchObject({ name: 'api', status: 'running' });
  });

  /**
   * `ClockModule` is `@Global`, which only holds if the application imports it exactly once. Without
   * that import the first service to inject `CLOCK` fails at boot, and no unit test would say so.
   */
  it('resolves the clock port from the application container', () => {
    expect(app.get<ClockPort>(CLOCK)).toBeInstanceOf(SystemClock);
  });

  /**
   * The endpoint gates the container, so its two answers are both worth asserting. With Postgres and
   * all three Redis roles up it is a 200; without them it is a 503 naming the dependency that is missing,
   * which is what the compose healthcheck turns into "this container is not ready".
   */
  it('GET /api/v1/health', async () => {
    const dependenciesUp = inject('postgresReachable') && inject('redisReachable');

    const response = await request(app.getHttpServer() as Server)
      .get('/api/v1/health')
      .expect(dependenciesUp ? 200 : 503);

    expect(response.body).toMatchObject(
      dependenciesUp
        ? {
            status: 'ok',
            details: {
              postgres: { status: 'up' },
              redis_cache: { status: 'up' },
              redis_queue: { status: 'up' },
              redis_session: { status: 'up' },
              redis_stream: { status: 'up' },
            },
          }
        : {
            status: 503,
            type: 'https://forge.dev/problems/service-unavailable',
            indicators: {
              postgres: 'down',
              redis_cache: 'down',
              redis_queue: 'down',
              redis_session: 'down',
              redis_stream: 'down',
            },
          },
    );
  });
});
