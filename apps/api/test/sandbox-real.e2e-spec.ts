import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import './support/developer-dotenv';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { TenantTransactionRunner } from '../src/database/tenant-transaction';
import {
  BREACHED_PASSWORD_PORT,
  type BreachedPasswordPort,
} from '../src/modules/identity/password/breached-password.port';
import {
  type MutationContext,
  SANDBOX_PORT,
  type SandboxPort,
} from '../src/modules/sandbox/sandbox.port';
import { SandboxService } from '../src/modules/sandbox/sandbox.service';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';
import {
  createTwoTenantWorld,
  destroyTwoTenantWorld,
  type TwoTenantWorld,
} from './support/two-tenant-fixture';

vi.hoisted(() => {
  // The developer's .env carries the model key, which the schema allows only beside `agent`;
  // this suite reaches a real Daytona through the whole app, so it carries every profile.
  process.env.RUN_PROFILES = 'api,agent,events,cron';
});

/**
 * `apps/api/.env` is where a developer's `DAYTONA_*` values live (infra/daytona writes them to
 * `.generated/daytona.env`; the README says to append them); the `developer-dotenv` import above
 * loads it, since `AppModule` ignores that file under test.
 */
const configured = Boolean(
  process.env.DAYTONA_API_URL && process.env.DAYTONA_API_KEY && process.env.DAYTONA_TEST_SANDBOX_ID,
);

// A banner distinct from the `SKIPPING` one the service probes print, so CI's grep for that word
// — which turns a skipped Postgres suite into a failure under `EXPECT_INTEGRATION=1` — does not
// match a suite that is *meant* to skip on every machine without a Daytona stack.
// `process.stderr` rather than `console.warn`: Vitest withholds a worker's console output when
// the file ran nothing, which is exactly when this line is the only evidence of why.
if (!configured) {
  process.stderr.write(
    'DAYTONA-SKIP "sandbox-real": DAYTONA_API_URL / DAYTONA_API_KEY / DAYTONA_TEST_SANDBOX_ID not set\n',
  );
}

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const LOCKED_BOOT_TIMEOUT_MS = 600_000;

class ScriptedBreachPort implements BreachedPasswordPort {
  isBreached(_password: string): Promise<boolean> {
    return Promise.resolve(false);
  }
}

/**
 * Spec 010 US6 / SC-007: the port against a real, hand-created sandbox on the self-hosted stack
 * (infra/daytona). One `it`, every operation, and its own file removed afterwards so the sandbox
 * is left as it was found. Nothing here is faked: the registration row, the lookup, the proxy
 * hop and the daemon are all the real ones.
 */
describe('Sandbox against a real Daytona (e2e)', () => {
  describe.skipIf(!configured || !postgres || !redis)(
    'against the self-hosted stack, Postgres and both Redis roles',
    () => {
      let app: INestApplication;
      let world: TwoTenantWorld;
      let transactions: TenantTransactionRunner;
      let port: SandboxPort;
      let suiteLock: { release: () => Promise<void> } | undefined;

      const ctx: MutationContext = { leaseEpoch: 0, operationId: 'sandbox-real/probe' };

      /** Every port call under alpha's tenant scope, as 011's tool broker will make them. */
      function inAlpha<T>(work: () => Promise<T>): Promise<T> {
        return transactions.runInTenantScope({ orgId: world.alpha.orgId, userId: null }, work);
      }

      beforeAll(async () => {
        // Every profile means a real relay and real workers on the shared table and queue.
        suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
          .overrideProvider(BREACHED_PASSWORD_PORT)
          .useClass(ScriptedBreachPort)
          .compile();

        app = moduleRef.createNestApplication();
        configureApplication(app);
        await app.init();

        transactions = app.get(TenantTransactionRunner);
        port = app.get<SandboxPort>(SANDBOX_PORT);
        world = await createTwoTenantWorld(app);

        const { orgId, projectId } = world.alpha;
        await transactions.runInTenantScope({ orgId, userId: null }, (tx) =>
          app
            .get(SandboxService)
            .register(tx, { daytonaId: process.env.DAYTONA_TEST_SANDBOX_ID!, orgId, projectId }),
        );
      }, LOCKED_BOOT_TIMEOUT_MS);

      afterAll(async () => {
        if (world) await destroyTwoTenantWorld(app, world);
        await app?.close();
        await suiteLock?.release();
      });

      it('writes, reads, lists, runs and searches against a real Daytona sandbox, then cleans up', async () => {
        const ref = { orgId: world.alpha.orgId, projectId: world.alpha.projectId };
        const name = `forge-010-${randomBytes(4).toString('hex')}.txt`;
        const content = `hello from spec 010 ${name}\n`;

        try {
          const edited = await inAlpha(() => port.edit(ref, { content, path: name }, ctx));
          expect(edited.bytes).toBe(Buffer.byteLength(content));
          expect(edited.diff.startsWith(`--- /dev/null\n+++ b/${name}\n`)).toBe(true);

          expect(await inAlpha(() => port.read(ref, name))).toBe(content);

          const listed = await inAlpha(() => port.list(ref, '.'));
          expect(listed).toContainEqual({ kind: 'file', name, size: Buffer.byteLength(content) });

          const ran = await inAlpha(() => port.exec(ref, 'ls -la', ctx));
          expect(ran.timedOut).toBe(false);
          if (!ran.timedOut) {
            expect(ran.exitCode).toBe(0);
            expect(ran.output).toContain(name);
          }

          const found = await inAlpha(() => port.search(ref, { text: `spec 010 ${name}` }));
          expect(found).toEqual([{ line: 1, path: name, text: content.trimEnd() }]);

          expect(await inAlpha(() => port.find(ref, { glob: 'forge-010-*' }))).toContain(name);
        } finally {
          const removed = await inAlpha(() => port.exec(ref, `rm -f ${name}`, ctx));
          expect(removed).toMatchObject({ exitCode: 0, timedOut: false });
        }
      });
    },
  );
});
