import type { CallHandler, ExecutionContext, INestApplication } from '@nestjs/common';
import { Body, Controller, Get, Injectable, Post } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { IDEMPOTENCY_KEY_HEADER } from '@repo/contracts';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { firstValueFrom, of } from 'rxjs';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { validateEnvironment } from '../../config/environment';
import { ClockModule } from '../clock/clock.module';
import { ConflictError } from '../errors/domain-error';
import { ProblemDetailsFilter } from '../errors/problem-details.filter';
import { SESSION_REDIS } from '../redis/redis.constants';
import { RedisModule } from '../redis/redis.module';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { IDEMPOTENCY_WAIT, IdempotencyModule } from './idempotency.module';
import type { IdempotencyLease, IdempotencyRecord } from './idempotency.store';
import { IdempotencyStore, idempotencyRecordKey } from './idempotency.store';

const reachable = inject('redisReachable');

const CREATE = '/idempotency-fixtures/create';
const READ = '/idempotency-fixtures/read';

/** Shared, mutable, per-test state the fixture handler reports and the tests drive. */
@Injectable()
class Recorder {
  /** Resolved by a test to let the handler finish, so "in flight" is a state and not a race. */
  gate: Promise<void> = Promise.resolve();
  /** Incremented before the gate: the count of times the *handler body* was entered. */
  started = 0;
  throwOnce = false;

  reset(): void {
    this.gate = Promise.resolve();
    this.started = 0;
    this.throwOnce = false;
  }
}

@Controller('idempotency-fixtures')
class FixtureController {
  constructor(private readonly recorder: Recorder) {}

  @Post('create')
  async create(@Body() body: unknown): Promise<Record<string, unknown>> {
    this.recorder.started += 1;

    await this.recorder.gate;

    if (this.recorder.throwOnce) {
      this.recorder.throwOnce = false;
      throw new ConflictError('The fixture was told to fail.');
    }

    return { echo: body, executions: this.recorder.started };
  }

  @Get('read')
  read(): Record<string, unknown> {
    this.recorder.started += 1;

    return { executions: this.recorder.started };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  for (let waited = 0; waited < timeoutMs; waited += 5) {
    if (predicate()) {
      return;
    }

    await delay(5);
  }

  throw new Error('condition was never met');
}

describe('IdempotencyInterceptor', () => {
  /**
   * The interceptor's whole contract is "this ran once", and the only place that fact is recorded
   * is Redis. Every case here therefore drives a real application over real HTTP against the real
   * session instance — including the concurrent one, which is two in-flight requests and not two
   * sequential calls dressed up as a race.
   */
  describe.skipIf(!reachable)('over HTTP, against the session Redis role', () => {
    let app: INestApplication;
    let recorder: Recorder;
    let redis: Redis;
    const written: string[] = [];

    /** A key the interceptor will accept, remembered so `afterAll` can delete its record. */
    function newKey(): string {
      const key = randomUUID();

      written.push(idempotencyRecordKey('anon', key));

      return key;
    }

    async function createApp(wait?: { pollIntervalMs: number; waitBudgetMs: number }): Promise<{
      instance: INestApplication;
      recorder: Recorder;
    }> {
      const builder = Test.createTestingModule({
        controllers: [FixtureController],
        imports: [
          ConfigModule.forRoot({
            ignoreEnvFile: true,
            isGlobal: true,
            validate: validateEnvironment,
          }),
          ClockModule,
          RedisModule,
          IdempotencyModule,
        ],
        providers: [Recorder, { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor }],
      });

      if (wait !== undefined) {
        builder.overrideProvider(IDEMPOTENCY_WAIT).useValue(wait);
      }

      const moduleRef = await builder.compile();
      const instance = moduleRef.createNestApplication();

      instance.useGlobalFilters(new ProblemDetailsFilter());
      await instance.init();

      return { instance, recorder: moduleRef.get(Recorder) };
    }

    function post(target: INestApplication, key: string | undefined, body: object): request.Test {
      const call = request(target.getHttpServer() as Server).post(CREATE);

      return key === undefined ? call.send(body) : call.set(IDEMPOTENCY_KEY_HEADER, key).send(body);
    }

    beforeAll(async () => {
      const created = await createApp();

      app = created.instance;
      recorder = created.recorder;
      redis = app.get<Redis>(SESSION_REDIS);
    });

    beforeEach(() => {
      recorder.reset();
    });

    afterAll(async () => {
      if (written.length > 0) {
        await redis.del(...written);
      }

      await app.close();
    });

    it('leaves a request without the header alone, so existing routes are unaffected', async () => {
      await post(app, undefined, { seats: 1 }).expect(201);
      await post(app, undefined, { seats: 1 }).expect(201);

      expect(recorder.started).toBe(2);
    });

    /**
     * A safe method has nothing to replay and no effect to suppress, and caching one would turn the
     * interceptor into an unasked-for read cache with a 24 h TTL.
     */
    it('leaves a safe method alone even when the header is present', async () => {
      const key = newKey();
      const server = app.getHttpServer() as Server;

      await request(server).get(READ).set(IDEMPOTENCY_KEY_HEADER, key).expect(200);
      await request(server).get(READ).set(IDEMPOTENCY_KEY_HEADER, key).expect(200);

      expect(recorder.started).toBe(2);
    });

    it('replays the original response for a repeat of the same key and body', async () => {
      const key = newKey();
      const body = { email: 'a@example.com', seats: 2 };
      const first = await post(app, key, body).expect(201);
      const second = await post(app, key, body).expect(201);

      expect(recorder.started).toBe(1);
      expect(second.body).toStrictEqual(first.body);
      expect(second.body).toStrictEqual({ echo: body, executions: 1 });
    });

    it('replays a body whose keys arrive in a different order, because it is the same request', async () => {
      const key = newKey();

      await post(app, key, { email: 'a@example.com', seats: 2 }).expect(201);
      await post(app, key, { seats: 2, email: 'a@example.com' }).expect(201);

      expect(recorder.started).toBe(1);
    });

    /**
     * The client has a bug — one key, two requests — and quietly handing back the first response
     * would hide it behind a 201 the caller reads as "the second one worked".
     */
    it('answers 409 with its own slug when the same key carries a different body', async () => {
      const key = newKey();

      await post(app, key, { seats: 2 }).expect(201);

      const conflict = await post(app, key, { seats: 3 })
        .expect(409)
        .expect('Content-Type', /application\/problem\+json/);

      expect(recorder.started).toBe(1);
      expect((conflict.body as { type: string }).type).toBe(
        'https://forge.dev/problems/idempotency-key-reused',
      );
    });

    it('rejects a key with too little entropy to be a replay slot', async () => {
      await post(app, 'short', { seats: 1 }).expect(400);

      expect(recorder.started).toBe(0);
    });

    it('rejects a key carrying characters the record key cannot hold', async () => {
      await post(app, 'a:b/../another-principals-key', { seats: 1 }).expect(400);

      expect(recorder.started).toBe(0);
    });

    /**
     * A failed request did not happen. Keeping its key would mean a transient failure costs the
     * client that key for 24 h, and the retry every client library makes would be refused.
     */
    it('frees the key when the handler fails, so the client can retry', async () => {
      const key = newKey();

      recorder.throwOnce = true;
      await post(app, key, { seats: 1 }).expect(409);

      const retry = await post(app, key, { seats: 1 }).expect(201);

      expect(recorder.started).toBe(2);
      expect(retry.body).toStrictEqual({ echo: { seats: 1 }, executions: 2 });
    });

    /**
     * Two clicks race far more often than one client retries, and the record lives in Redis rather
     * than in the process precisely so a second node cannot execute the same request. This is the
     * proof: the first request is *held inside the handler* while the second is issued, so "in
     * flight" is an established fact and not a timing hope.
     */
    it('does not execute twice when a second request arrives while the first is in flight', async () => {
      const key = newKey();
      const body = { email: 'race@example.com' };
      let release: () => void = () => undefined;

      recorder.gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const first = post(app, key, body).then((response) => response);

      await until(() => recorder.started === 1);

      const second = post(app, key, body).then((response) => response);

      // The second request is now in the server with the first still inside the handler. Without
      // the interceptor it would enter the handler here and `started` would reach 2.
      await delay(150);
      expect(recorder.started).toBe(1);

      release();

      const [firstResponse, secondResponse] = await Promise.all([first, second]);

      expect(recorder.started).toBe(1);
      expect(firstResponse.status).toBe(201);
      expect(secondResponse.status).toBe(201);
      expect(secondResponse.body).toStrictEqual(firstResponse.body);
      expect(secondResponse.body).toStrictEqual({ echo: body, executions: 1 });
    });

    it('executes once when eight requests are issued at the same instant on one key', async () => {
      const key = newKey();
      const body = { email: 'thundering@example.com' };
      let release: () => void = () => undefined;

      recorder.gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const calls = Array.from({ length: 8 }, () => post(app, key, body).then((r) => r));

      await until(() => recorder.started === 1);
      await delay(150);
      release();

      const responses = await Promise.all(calls);

      expect(recorder.started).toBe(1);
      expect(responses.map((response) => response.status)).toStrictEqual(Array(8).fill(201));

      for (const response of responses) {
        expect(response.body).toStrictEqual({ echo: body, executions: 1 });
      }
    });

    /**
     * The record is in Redis, not in the process, which is the only reason two API nodes behind a
     * load balancer cannot both execute the same request. A second application instance replaying
     * the *first* instance's response is what proves it.
     */
    it('replays across application instances, because the record is in Redis', async () => {
      const key = newKey();
      const body = { seats: 9 };
      const first = await post(app, key, body).expect(201);
      const other = await createApp();

      try {
        const replay = await post(other.instance, key, body).expect(201);

        expect(other.recorder.started).toBe(0);
        expect(replay.body).toStrictEqual(first.body);
      } finally {
        await other.instance.close();
      }
    });
  });

  /**
   * The other half of the concurrent requirement: when the first request outlasts the budget the
   * second is willing to wait, the answer is a retryable problem — never a second execution.
   */
  describe.skipIf(!reachable)('when the wait budget expires', () => {
    it('answers a retryable problem instead of executing the request a second time', async () => {
      const key = randomUUID();
      const moduleRef = await Test.createTestingModule({
        controllers: [FixtureController],
        imports: [
          ConfigModule.forRoot({
            ignoreEnvFile: true,
            isGlobal: true,
            validate: validateEnvironment,
          }),
          ClockModule,
          RedisModule,
          IdempotencyModule,
        ],
        providers: [Recorder, { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor }],
      })
        .overrideProvider(IDEMPOTENCY_WAIT)
        .useValue({ pollIntervalMs: 5, waitBudgetMs: 50 })
        .compile();
      const app = moduleRef.createNestApplication();

      app.useGlobalFilters(new ProblemDetailsFilter());
      await app.init();

      const recorder = moduleRef.get(Recorder);
      const server = app.getHttpServer() as Server;
      let release: () => void = () => undefined;

      recorder.gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const first = request(server)
        .post(CREATE)
        .set(IDEMPOTENCY_KEY_HEADER, key)
        .send({ seats: 1 })
        .then((response) => response);

      await until(() => recorder.started === 1);

      try {
        const busy = await request(server)
          .post(CREATE)
          .set(IDEMPOTENCY_KEY_HEADER, key)
          .send({ seats: 1 })
          .expect(409)
          .expect('Content-Type', /application\/problem\+json/);

        expect(recorder.started).toBe(1);
        expect(busy.body).toMatchObject({
          retryAfter: expect.any(Number) as number,
          type: 'https://forge.dev/problems/idempotency-key-in-flight',
        });
      } finally {
        release();
        await first;
        await app.get<Redis>(SESSION_REDIS).del(idempotencyRecordKey('anon', key));
        await app.close();
      }
    });
  });

  /**
   * Redis failing *after* the handler has run is the one case where the interceptor must not turn a
   * completed mutation into an error: the work happened, and a 500 here is a client retry of a
   * request that already succeeded. These two drive the interceptor directly, because a Redis that
   * fails only on the second call is not a state a real instance can be asked for.
   */
  describe('when the store fails after the work is done', () => {
    function httpContext(): ExecutionContext {
      const request = {
        body: { seats: 1 },
        headers: { 'idempotency-key': randomUUID() },
        method: 'POST',
        originalUrl: '/things',
      };
      const response = { status: () => response, statusCode: 201 };

      return {
        getType: () => 'http',
        switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
      } as unknown as ExecutionContext;
    }

    const next: CallHandler = { handle: () => of({ id: 'created' }) };
    const lease: IdempotencyLease = {
      expiresAt: 1,
      fingerprint: 'f'.repeat(64),
      key: 'i:anon:x',
      pending: '{}',
    };

    it('returns the handler result when the completed record cannot be written', async () => {
      const store = {
        begin: () => Promise.resolve({ lease, outcome: 'acquired' as const }),
        complete: () => Promise.reject(new Error('session redis is down')),
        release: () => Promise.resolve(),
      };
      const interceptor = new IdempotencyInterceptor(store as unknown as IdempotencyStore, {
        pollIntervalMs: 5,
        waitBudgetMs: 50,
      });

      await expect(
        firstValueFrom(interceptor.intercept(httpContext(), next)),
      ).resolves.toStrictEqual({ id: 'created' });
    });

    it('reports the handler failure, not the failure to release the slot', async () => {
      const store = {
        begin: () => Promise.resolve({ lease, outcome: 'acquired' as const }),
        complete: (_lease: IdempotencyLease, _record: IdempotencyRecord) => Promise.resolve(),
        release: () => Promise.reject(new Error('session redis is down')),
      };
      const interceptor = new IdempotencyInterceptor(store as unknown as IdempotencyStore, {
        pollIntervalMs: 5,
        waitBudgetMs: 50,
      });
      const failing: CallHandler = {
        handle: () => {
          throw new ConflictError('That email address is already registered.');
        },
      };

      await expect(firstValueFrom(interceptor.intercept(httpContext(), failing))).rejects.toThrow(
        'That email address is already registered.',
      );
    });
  });
});
