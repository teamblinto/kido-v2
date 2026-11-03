import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { type RunResponse, runResponseSchema } from '@repo/contracts';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import './support/developer-dotenv';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { TenantTransactionRunner } from '../src/database/tenant-transaction';
import {
  BREACHED_PASSWORD_PORT,
  type BreachedPasswordPort,
} from '../src/modules/identity/password/breached-password.port';
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
  // Real runs need every profile; the developer's .env key becomes the organisation's own.
  process.env.RUN_PROFILES = 'api,agent,events,cron';
});

/**
 * 021 T027 / SC-003's real walk: two one-turn runs on an unchanged project against the real
 * Anthropic model and the hand-created Daytona sandbox, exactly as `agent-real.e2e-spec.ts` boots
 * it. The executor's system + map blocks carry `cache_control` (T006), so the second run's
 * `cacheReadTokens` must cover at least 80 % of what the first run wrote. Spends money; gated on
 * the same variables as agent-real and only ever run by hand (quickstart.md § 4).
 */
const anthropic = Boolean(process.env.ANTHROPIC_API_KEY);
const daytona = Boolean(
  process.env.DAYTONA_API_URL && process.env.DAYTONA_API_KEY && process.env.DAYTONA_TEST_SANDBOX_ID,
);

// Two banners, one per missing side, distinct from `SKIPPING` (see agent-real for why stderr).
if (!anthropic) {
  process.stderr.write('ANTHROPIC-SKIP "context-real": ANTHROPIC_API_KEY not set\n');
}
if (!daytona) {
  process.stderr.write(
    'DAYTONA-SKIP "context-real": DAYTONA_API_URL / DAYTONA_API_KEY / DAYTONA_TEST_SANDBOX_ID not set\n',
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

describe('Context assembly against the real model and a real sandbox (e2e)', () => {
  describe.skipIf(!anthropic || !daytona || !postgres || !redis)(
    'against the self-hosted Daytona stack, Postgres and both Redis roles',
    () => {
      let app: INestApplication;
      let world: TwoTenantWorld;
      let suiteLock: { release: () => Promise<void> } | undefined;

      beforeAll(async () => {
        suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
          .overrideProvider(BREACHED_PASSWORD_PORT)
          .useClass(ScriptedBreachPort)
          .compile();

        app = moduleRef.createNestApplication();
        configureApplication(app);
        await app.init();

        world = await createTwoTenantWorld(app);
        // The developer's key, as the organisation's own: the process holds no model key
        // (platform credits are retired), so a real run is paid the way a customer's is.
        await seedProviderKey(app, world.alpha, 'anthropic', process.env.ANTHROPIC_API_KEY);

        const { orgId, projectId } = world.alpha;
        await app
          .get(TenantTransactionRunner)
          .runInTenantScope({ orgId, userId: null }, (tx) =>
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

      // A read-only prompt: no tool calls, so the tree — and the map — is unchanged between runs.
      async function oneTurnRun(): Promise<RunResponse> {
        const { orgId, projectId } = world.alpha;
        const runsPath = `${ORGS}/${orgId}/projects/${projectId}/runs`;

        const created = await unsafe(http(app).post(runsPath), [world.alpha.owner.cookie])
          .send({
            model: 'claude-haiku-4-5',
            prompt: 'Reply with the single word: pong. Do not use any tools.',
          })
          .expect(201);
        let final = runResponseSchema.parse(created.body);
        const deadline = Date.now() + RUN_TIMEOUT_MS;

        while (final.status !== 'succeeded') {
          if (Date.now() > deadline) {
            throw new Error(`timed out waiting for succeeded; run is ${final.status}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 500));

          const read = await http(app)
            .get(`${runsPath}/${final.id}`)
            .set('Cookie', world.alpha.owner.cookie)
            .expect(200);
          final = runResponseSchema.parse(read.body);

          if (final.status === 'failed' || final.status === 'cancelled') {
            const events = await http(app)
              .get(`${runsPath}/${final.id}/events`)
              .set('Cookie', world.alpha.owner.cookie);
            throw new Error(
              `run ended ${final.status} (${final.failureClass}), expected succeeded: ${JSON.stringify(events.body)}`,
            );
          }
        }
        return final;
      }

      it("SC-003: the second of two one-turn runs on an unchanged project reports cacheReadTokens ≥ 80% of the first run's cacheWriteTokens", async () => {
        const first = await oneTurnRun();
        const second = await oneTurnRun();

        // Paste into the spec's matrix row for SC-003 — never the key, only the ids and totals.
        process.stdout.write(
          `context-real first run ${first.id}: cacheWriteTokens=${first.cacheWriteTokens} cacheReadTokens=${first.cacheReadTokens} inputTokens=${first.inputTokens}\n` +
            `context-real second run ${second.id}: cacheWriteTokens=${second.cacheWriteTokens} cacheReadTokens=${second.cacheReadTokens} inputTokens=${second.inputTokens}\n`,
        );

        expect(first.cacheWriteTokens).toBeGreaterThan(0);
        expect(second.cacheReadTokens).toBeGreaterThanOrEqual(first.cacheWriteTokens * 0.8);
      });
    },
  );
});
