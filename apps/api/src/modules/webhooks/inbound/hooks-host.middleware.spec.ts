import type { INestApplication, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { Controller, Get, HttpCode, HttpStatus, Module, Post, RequestMethod } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { INBOUND_PATHS } from '../../../common/csrf/inbound-paths';
import { DomainError } from '../../../common/errors/domain-error';
import { ProblemDetailsFilter } from '../../../common/errors/problem-details.filter';
import { HooksHostMiddleware } from './hooks-host.middleware';

const HOOKS = 'hooks.localhost';
const PRODUCT = 'app.localhost';
const INBOUND = INBOUND_PATHS[0];

function configOf(legacy: boolean): ConfigService {
  const values: Record<string, unknown> = { HOOKS_HOST: HOOKS, WEBHOOK_LEGACY_ADDRESS: legacy };

  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

/** Runs the middleware once and reports whether it passed or what it threw. */
function outcome(
  host: string | undefined,
  url: string,
  legacy = true,
): { passed: boolean; thrown?: unknown } {
  const middleware = new HooksHostMiddleware(configOf(legacy) as never);
  let passed = false;

  try {
    middleware.use(
      { headers: host === undefined ? {} : { host }, method: 'POST', originalUrl: url, url },
      {},
      () => {
        passed = true;
      },
    );
  } catch (thrown) {
    return { passed, thrown };
  }

  return { passed };
}

/**
 * Spec 029 T085 — every row of contracts/hooks-origin.md § API. The host is compared with its port
 * stripped and lowercased; the hooks host serves the inbound paths and nothing else; the product
 * host serves them only while the legacy address is on; everything else is not this middleware's.
 */
describe('HooksHostMiddleware', () => {
  describe('the table', () => {
    it('passes an inbound path on the hooks host', () => {
      expect(outcome(HOOKS, INBOUND)).toEqual({ passed: true });
    });

    it('refuses any other path on the hooks host with not-found', () => {
      const { passed, thrown } = outcome(HOOKS, '/api/v1/orgs');

      expect(passed).toBe(false);
      expect(thrown).toBeInstanceOf(DomainError);
      expect((thrown as DomainError).type).toBe('not-found');
    });

    it('passes an inbound path on the product host while the legacy address is on', () => {
      expect(outcome(PRODUCT, INBOUND, true)).toEqual({ passed: true });
    });

    it('refuses an inbound path on the product host once the legacy address is retired', () => {
      const { passed, thrown } = outcome(PRODUCT, INBOUND, false);

      expect(passed).toBe(false);
      expect((thrown as DomainError).type).toBe('not-found');
    });

    it('passes any other path on any other host, whatever the setting', () => {
      expect(outcome(PRODUCT, '/api/v1/orgs', false)).toEqual({ passed: true });
      expect(outcome(undefined, '/api/v1/orgs', false)).toEqual({ passed: true });
    });

    it('treats a request with no Host as not the hooks host', () => {
      expect(outcome(undefined, INBOUND, true)).toEqual({ passed: true });
      expect(outcome(undefined, INBOUND, false).passed).toBe(false);
    });
  });

  describe('the host comparison', () => {
    it.each(['hooks.localhost:8080', 'HOOKS.Localhost', 'Hooks.LOCALHOST:443'])(
      'reads %s as the hooks host',
      (host) => {
        expect(outcome(host, INBOUND)).toEqual({ passed: true });
        expect(outcome(host, '/api/v1/orgs').passed).toBe(false);
      },
    );

    it('does not read a host that merely contains the hooks host as the hooks host', () => {
      expect(outcome('evil-hooks.localhost', '/api/v1/orgs')).toEqual({ passed: true });
      expect(outcome('hooks.localhost.evil.test', '/api/v1/orgs')).toEqual({ passed: true });
    });

    it('compares the path without its query string', () => {
      expect(outcome(HOOKS, `${INBOUND}?x=1`)).toEqual({ passed: true });
      expect(outcome(PRODUCT, `${INBOUND}?x=1`, false).passed).toBe(false);
    });
  });

  describe('through the HTTP stack', () => {
    @Controller()
    class ProbeController {
      @Post(INBOUND.slice(1))
      @HttpCode(HttpStatus.NO_CONTENT)
      inbound(): void {
        // The route only has to exist; the middleware is under test.
      }

      @Get('api/v1/orgs')
      orgs(): { ok: true } {
        return { ok: true };
      }
    }

    let app: INestApplication | undefined;

    afterEach(async () => {
      await app?.close();
      app = undefined;
    });

    async function start(legacy: boolean): Promise<request.Agent> {
      @Module({
        controllers: [ProbeController],
        providers: [
          HooksHostMiddleware,
          { provide: ConfigService, useValue: configOf(legacy) },
          { provide: APP_FILTER, useClass: ProblemDetailsFilter },
        ],
      })
      class ProbeModule implements NestModule {
        configure(consumer: MiddlewareConsumer): void {
          consumer
            .apply(HooksHostMiddleware)
            .forRoutes({ method: RequestMethod.ALL, path: '*splat' });
        }
      }

      const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();

      return request(app.getHttpServer() as Server);
    }

    it('answers a refused host with the unknown route’s problem document, byte for byte', async () => {
      const http = await start(true);

      // The same path and the same request id, so the two documents can only differ if the
      // middleware's refusal is distinguishable from a route that does not exist.
      const refused = await http
        .get('/api/v1/orgs')
        .set('Host', HOOKS)
        .set('X-Request-Id', 'probe-1')
        .expect(HttpStatus.NOT_FOUND);
      const unknown = await http
        .get('/api/v1/orgs/nope')
        .set('Host', PRODUCT)
        .set('X-Request-Id', 'probe-1')
        .expect(HttpStatus.NOT_FOUND);
      const refusedUnknown = await http
        .get('/api/v1/orgs/nope')
        .set('Host', HOOKS)
        .set('X-Request-Id', 'probe-1')
        .expect(HttpStatus.NOT_FOUND);

      expect(refusedUnknown.text).toBe(unknown.text);
      expect(refused.headers['content-type']).toBe(unknown.headers['content-type']);
      expect(refused.text).toBe(unknown.text.replaceAll('/api/v1/orgs/nope', '/api/v1/orgs'));
    });

    it('serves the inbound path on the hooks host and the product host by default', async () => {
      const http = await start(true);

      await http.post(INBOUND).set('Host', `${HOOKS}:8080`).expect(HttpStatus.NO_CONTENT);
      await http.post(INBOUND).set('Host', PRODUCT).expect(HttpStatus.NO_CONTENT);
      await http.get('/api/v1/orgs').set('Host', PRODUCT).expect(HttpStatus.OK);
    });

    it('refuses the product-host inbound path when WEBHOOK_LEGACY_ADDRESS=false', async () => {
      const http = await start(false);

      await http.post(INBOUND).set('Host', PRODUCT).expect(HttpStatus.NOT_FOUND);
      await http.post(INBOUND).set('Host', HOOKS).expect(HttpStatus.NO_CONTENT);
    });
  });
});
