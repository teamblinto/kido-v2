import type { MiddlewareConsumer, Type } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { validateEnvironment } from '../../config/environment';
import { isDeviceTokenPath, isExemptPath } from './csrf-token';
import { CSRF_DEVICE_TOKEN_PATHS, CSRF_EXEMPT_PATHS, CsrfMiddleware } from './csrf.middleware';
import { CsrfModule, DEVICE_TOKEN_PATHS, SIGNATURE_VERIFIED_WEBHOOK_PATHS } from './csrf.module';

/**
 * What `forRoutes` was handed. Declared here rather than imported: Nest publishes `RouteInfo` from
 * `@nestjs/common/interfaces`, and reaching into a package's subpath for a two-field shape buys a
 * dependency on where that file lives.
 */
interface RecordedRoute {
  readonly method: RequestMethod;
  readonly path: string;
}

/** Just enough of Nest's fluent consumer to record what `configure` asked for. */
function recordingConsumer(): {
  applied: Type<unknown>[];
  consumer: MiddlewareConsumer;
  routes: (RecordedRoute | string)[];
} {
  const applied: Type<unknown>[] = [];
  const routes: (RecordedRoute | string)[] = [];
  const consumer = {
    apply(...middleware: Type<unknown>[]) {
      applied.push(...middleware);

      return {
        exclude: () => this,
        forRoutes: (...forRoutes: (RecordedRoute | string)[]) => {
          routes.push(...forRoutes);

          return this;
        },
      };
    },
  } as unknown as MiddlewareConsumer;

  return { applied, consumer, routes };
}

async function compiled() {
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ ignoreEnvFile: true, isGlobal: true, validate: validateEnvironment }),
      CsrfModule,
    ],
  }).compile();
}

describe('CsrfModule', () => {
  it('provides the middleware', async () => {
    const moduleRef = await compiled();

    expect(moduleRef.get(CsrfMiddleware)).toBeInstanceOf(CsrfMiddleware);
  });

  it('binds the exemption list the middleware injects', async () => {
    const moduleRef = await compiled();

    expect(moduleRef.get(CSRF_EXEMPT_PATHS)).toBe(SIGNATURE_VERIFIED_WEBHOOK_PATHS);
  });

  describe('the exemption list', () => {
    /**
     * Exactly the listed entries, and asserted to be. Every addition has to arrive with an edit
     * here, which is where a reviewer would want to be asked "and what verifies that one's
     * signature?" — for the sandbox callback (spec 017 R11), `SandboxCallbackGuard`.
     */
    it('holds the sandbox callback and the GitHub webhook, and nothing else', () => {
      expect(SIGNATURE_VERIFIED_WEBHOOK_PATHS).toEqual([
        '/api/v1/internal/sandbox-callbacks',
        '/api/v1/webhooks/github',
      ]);
    });

    it('is frozen, so nothing widens it at runtime', () => {
      expect(Object.isFrozen(SIGNATURE_VERIFIED_WEBHOOK_PATHS)).toBe(true);
    });

    /**
     * Every entry has to be a whole path. `isExemptPath` compares by equality, so a pattern or a
     * bare segment would not exempt anything — it would sit here looking like an exemption and
     * quietly be none, which is the worse of the two ways to get this wrong.
     */
    it('holds absolute paths, never patterns', () => {
      for (const path of SIGNATURE_VERIFIED_WEBHOOK_PATHS) {
        expect(path.startsWith('/')).toBe(true);
        expect(path).not.toMatch(/[*:?]/);
      }
    });

    /**
     * The rule the file's own comment states, made a test rather than a promise (spec 026 T052).
     *
     * `isExemptPath` compares by equality, so this holds today by construction — which is exactly
     * why it is worth asserting: the day somebody "fixes" the comparison to `startsWith` so that a
     * trailing slash or a query string stops mattering, every sibling beneath every listed path
     * becomes exempt at once, and this is the test that says so.
     */
    it('exempts no sibling mounted beneath a listed path', () => {
      const exempt = new Set(SIGNATURE_VERIFIED_WEBHOOK_PATHS);

      for (const path of SIGNATURE_VERIFIED_WEBHOOK_PATHS) {
        expect(isExemptPath(path, exempt)).toBe(true);

        for (const sibling of [
          `${path}/anything`,
          `${path}/../${path}`,
          `${path}x`,
          path.replace('/api/v1/', '/api/'),
          path.slice(0, -1),
        ]) {
          expect(isExemptPath(sibling, exempt)).toBe(false);
        }
      }
    });

    /** A query string is not a different path, and the webhook's caller may well append one. */
    it('exempts a listed path carrying a query string', () => {
      expect(
        isExemptPath('/api/v1/webhooks/github?x=1', new Set(SIGNATURE_VERIFIED_WEBHOOK_PATHS)),
      ).toBe(true);
    });
  });

  describe('configure', () => {
    it('applies the middleware to every method on every path', () => {
      const { applied, consumer, routes } = recordingConsumer();

      new CsrfModule().configure(consumer);

      expect(applied).toEqual([CsrfMiddleware]);
      expect(routes).toEqual([{ method: RequestMethod.ALL, path: '*splat' }]);
    });

    /**
     * A bare `*` is what this used to be spelled as, and Express 5 no longer accepts it. The
     * assertion is here because the failure it guards against is not "matches fewer routes" — it
     * is a boot-time throw, and a wildcard that silently matched nothing would be worse.
     */
    it('uses a named wildcard, which is the only kind Express 5 parses', () => {
      const { consumer, routes } = recordingConsumer();

      new CsrfModule().configure(consumer);

      expect(routes[0]).not.toBe('*');
      expect((routes[0] as RecordedRoute).path).toMatch(/^\*\w+$/);
    });
  });
});

/** Spec 040 § 5: the companion's device-token routes, and nothing beside or beneath them. */
describe('DEVICE_TOKEN_PATHS', () => {
  const RUN = 'b0400000-0000-4000-8000-000000000001';

  it('is bound for the middleware and frozen', async () => {
    const moduleRef = await compiled();

    expect(moduleRef.get(CSRF_DEVICE_TOKEN_PATHS)).toBe(DEVICE_TOKEN_PATHS);
    expect(Object.isFrozen(DEVICE_TOKEN_PATHS)).toBe(true);
  });

  it.each([
    '/api/v1/local-agent/pairings',
    '/api/v1/local-agent/pairings/token',
    '/api/v1/local-agent/status',
    '/api/v1/local-agent/auth',
    `/api/v1/local-agent/runs/${RUN}/events`,
    `/api/v1/local-agent/runs/${RUN}/events/`,
    '/api/v1/local-agent/status?x=1',
  ])('exempts %s', (path) => {
    expect(isDeviceTokenPath(path, DEVICE_TOKEN_PATHS)).toBe(true);
  });

  it.each([
    '/api/v1/local-agent/connect-x',
    '/api/v1/local-agent/status/anything',
    '/api/v1/local-agent/auth/anything',
    '/api/v1/local-agent/runs/not-a-uuid/events',
    `/api/v1/local-agent/runs/${RUN}/events/more`,
    `/api/v1/local-agent/runs/${RUN}/../../../me/local-agents/pairings/approve`,
    '/api/v1/me/local-agents/pairings/approve',
    `/api/v1/orgs/${RUN}/projects/${RUN}/runs/${RUN}/approvals/r1`,
    '/api/local-agent/status',
  ])('exempts nothing else (%s)', (path) => {
    expect(isDeviceTokenPath(path, DEVICE_TOKEN_PATHS)).toBe(false);
  });
});
