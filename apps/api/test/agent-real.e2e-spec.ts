import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { type RunResponse, runResponseSchema } from '@repo/contracts';
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
import { SANDBOX_PORT, type SandboxPort } from '../src/modules/sandbox/sandbox.port';
import { SandboxService } from '../src/modules/sandbox/sandbox.service';
import { unsafe } from './support/csrf-client';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';
import { seedProviderKey } from './support/seed-provider-key';
import {
  createTwoTenantWorld,
  destroyTwoTenantWorld,
  http,
  type TwoTenantWorld,
} from './support/two-tenant-fixture';

vi.hoisted(() => {
  // The developer's .env carries the model key, which this suite seeds as the organisation's;
  // this suite executes real runs, so it carries every profile.
  process.env.RUN_PROFILES = 'api,agent,events,cron';
});

/**
 * Same reasoning as `sandbox-real.e2e-spec.ts`: `apps/api/.env` is where a developer's
 * `ANTHROPIC_*` and `DAYTONA_*` values live, and the `developer-dotenv` import above loads it
 * because `AppModule` ignores that file under test.
 */
const configured = Boolean(
  process.env.ANTHROPIC_API_KEY &&
  process.env.DAYTONA_API_URL &&
  process.env.DAYTONA_API_KEY &&
  process.env.DAYTONA_TEST_SANDBOX_ID,
);

// A banner distinct from the `SKIPPING` one the service probes print, and from `DAYTONA-SKIP`,
// so CI's grep for either word does not match a suite that is *meant* to skip on every machine
// without a real Anthropic key and a real Daytona stack. `process.stderr` rather than
// `console.warn`: Vitest withholds a worker's console output when the file ran nothing.
if (!configured) {
  process.stderr.write(
    'ANTHROPIC-SKIP "agent-real": ANTHROPIC_API_KEY / DAYTONA_API_URL / DAYTONA_API_KEY / DAYTONA_TEST_SANDBOX_ID not set\n',
  );
}

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const ORGS = '/api/v1/orgs';
const RUN_TIMEOUT_MS = 120_000;
const LOCKED_BOOT_TIMEOUT_MS = 600_000;

class ScriptedBreachPort implements BreachedPasswordPort {
  isBreached(_password: string): Promise<boolean> {
    return Promise.resolve(false);
  }
}

/**
 * Spec 011 SC-002: the shipped `AgentExecutor` against the real Anthropic model and a real,
 * hand-created Daytona sandbox (infra/daytona) — no override of `LLM_PROVIDER` or `RUN_EXECUTOR`,
 * so this is exactly what production runs. This suite spends money; it is gated on four
 * environment variables and only ever run by hand (quickstart.md § Real run).
 */
describe('Agent core against the real model and a real sandbox (e2e)', () => {
  describe.skipIf(!configured || !postgres || !redis)(
    'against the self-hosted Daytona stack, Postgres and both Redis roles',
    () => {
      let app: INestApplication;
      let world: TwoTenantWorld;
      let transactions: TenantTransactionRunner;
      let port: SandboxPort;
      let suiteLock: { release: () => Promise<void> } | undefined;

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
        // The developer's key, as the organisation's own: the process holds no model key
        // (platform credits are retired), so a real run is paid the way a customer's is.
        await seedProviderKey(app, world.alpha, 'anthropic', process.env.ANTHROPIC_API_KEY);

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

      it('edits a file in the real sandbox on the real model and ends succeeded', async () => {
        const { orgId, projectId } = world.alpha;
        const runsPath = `${ORGS}/${orgId}/projects/${projectId}/runs`;
        const marker = `agent-real ${randomBytes(4).toString('hex')}`;

        const created = await unsafe(http(app).post(runsPath), [world.alpha.owner.cookie])
          .send({
            model: 'claude-haiku-4-5',
            prompt: `Read README.md, append a line "Edited by ${marker}" and show me the file with cat.`,
          })
          .expect(201);
        const run = runResponseSchema.parse(created.body);

        let final: RunResponse = run;
        const deadline = Date.now() + RUN_TIMEOUT_MS;

        while (final.status !== 'succeeded') {
          if (Date.now() > deadline) {
            throw new Error(`timed out waiting for succeeded; run is ${final.status}`);
          }

          await new Promise((resolve) => setTimeout(resolve, 500));

          const read = await http(app)
            .get(`${runsPath}/${run.id}`)
            .set('Cookie', world.alpha.owner.cookie)
            .expect(200);
          final = runResponseSchema.parse(read.body);

          if (final.status === 'failed' || final.status === 'cancelled') {
            throw new Error(`run ended ${final.status}, expected succeeded`);
          }
        }

        const content = await transactions.runInTenantScope({ orgId, userId: null }, () =>
          port.read({ orgId, projectId }, 'README.md'),
        );
        expect(content).toContain(marker);

        expect(final.inputTokens).toBeGreaterThan(0);
        expect(final.outputTokens).toBeGreaterThan(0);

        // Paste into the spec's matrix row for SC-002 — never the key, only the run id and totals.
        process.stdout.write(
          `agent-real run ${run.id}: inputTokens=${final.inputTokens} outputTokens=${final.outputTokens}\n`,
        );
      });
    },
  );
});
