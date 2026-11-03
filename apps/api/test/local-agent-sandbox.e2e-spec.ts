import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  type CompanionCommand,
  type CompanionRunEvent,
  checkpointListResponseSchema,
  pairingTokenResponseSchema,
  runEventsResponseSchema,
  runResponseSchema,
  startPairingResponseSchema,
} from '@repo/contracts';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { TenantTransactionRunner } from '../src/database/tenant-transaction';
import { AGENT_TIMINGS, type AgentTimings } from '../src/modules/agent/agent.constants';
import {
  BREACHED_PASSWORD_PORT,
  type BreachedPasswordPort,
} from '../src/modules/identity/password/breached-password.port';
import {
  DEFAULT_LOCAL_AGENT_TIMINGS,
  LOCAL_AGENT_TIMINGS,
  type LocalAgentTimings,
} from '../src/modules/local-agent/local-agent.constants';
import { SandboxService } from '../src/modules/sandbox/sandbox.service';
import { unsafe } from './support/csrf-client';
import { type FakeDaytona, startFakeDaytona } from './support/fake-daytona';
import { type FakeGit, fakeGit } from './support/fake-git';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';
import { type Frame, type OpenStream, openStream } from './support/sse';
import { stepUp } from './support/step-up';
import {
  createTwoTenantWorld,
  destroyTwoTenantWorld,
  http,
  type TwoTenantWorld,
} from './support/two-tenant-fixture';

/** Before any import: the worker claims runs, local agents are on, the Daytona is the fake's. */
const FAKE = vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
  process.env.RUN_PROFILES = 'api,agent,events';
  process.env.LOCAL_AGENT_ENABLED = 'true';
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_PARALLELISM = '1';
  process.env.ARGON2_TIME_COST = '1';
  process.env.THROTTLE_LIMIT = '100000';

  const port = 20_000 + Math.floor(Math.random() * 20_000);
  process.env.DAYTONA_API_URL = `http://127.0.0.1:${port}/api`;
  process.env.DAYTONA_API_KEY = 'dtn_fake_key';

  return { port };
});

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const LOCKED_BOOT_TIMEOUT_MS = 600_000;
const WAIT_MS = 20_000;
const ME = '/api/v1/me/local-agents';
const COMPANION = '/api/v1/local-agent';

const TIMINGS: LocalAgentTimings = {
  ...DEFAULT_LOCAL_AGENT_TIMINGS,
  cancelPollMs: 50,
  heartbeatMs: 1_000,
  interruptWaitMs: 1_000,
  offlineGraceMs: 1_000,
  readBlockMs: 100,
  startAckMs: 10_000,
};

const AGENT: AgentTimings = {
  batchMs: 10,
  batchSize: 32,
  cancelPollMs: 20,
  heartbeatMs: 200,
  leaseTtlMs: 1_000,
  providerAttempts: 3,
  providerBackoffBaseMs: 10,
  providerBackoffCapMs: 50,
  reaperMs: 60_000,
  staleAfterMs: 60_000,
  summaryMs: 30_000,
};

class ScriptedBreachPort implements BreachedPasswordPort {
  isBreached(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Spec 041's sandbox tool bridge through HTTP against Postgres, Redis, the worker and the fake
 * Daytona: a local run with no workspace is offered the sandbox tools, its companion's
 * `tool.call` edits the project's sandbox through the same broker as a cloud run, the result
 * comes back down as `tool.result`, and the completed turn is checkpointed. This suite plays the
 * companion.
 */
describe('Local agent sandbox tool bridge (e2e)', () => {
  describe.skipIf(!postgres || !redis)(
    'against Postgres, Redis, the worker and a fake Daytona',
    () => {
      let app: INestApplication;
      let port: number;
      let fake: FakeDaytona;
      let git: FakeGit;
      let world: TwoTenantWorld;
      let suiteLock: { release: () => Promise<void> } | undefined;
      const open: OpenStream[] = [];

      const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

      function runsPath(): string {
        return `/api/v1/orgs/${world.alpha.orgId}/projects/${world.alpha.projectId}/runs`;
      }

      async function pair(cookie: string) {
        const started = await http(app)
          .post(`${COMPANION}/pairings`)
          .send({ companionVersion: '0.2.0', name: 'Bridge laptop', platform: 'linux' })
          .expect(201);
        const { deviceCode, userCode } = startPairingResponseSchema.parse(started.body);
        await stepUp(app, cookie);
        await unsafe(http(app).post(`${ME}/pairings/approve`), [cookie])
          .send({ userCode })
          .expect(204);
        const answer = pairingTokenResponseSchema.parse(
          (await http(app).post(`${COMPANION}/pairings/token`).send({ deviceCode }).expect(200))
            .body,
        );
        if (answer.status !== 'approved') throw new Error(`pairing ${answer.status}`);
        return { deviceId: answer.deviceId, token: answer.deviceToken };
      }

      async function connect(token: string) {
        const opened = await openStream(port, `${COMPANION}/connect`, { headers: bearer(token) });
        open.push(opened);
        const iterator = opened.frames[Symbol.asyncIterator]();
        return async (type: string): Promise<Frame> => {
          const deadline = Date.now() + WAIT_MS;
          for (;;) {
            const result = await Promise.race([
              iterator.next(),
              sleep(Math.max(1, deadline - Date.now())).then(() => 'timeout' as const),
            ]);
            if (result === 'timeout') throw new Error(`timed out waiting for ${type}`);
            if (result.done === true) throw new Error(`stream ended waiting for ${type}`);
            if (result.value.event === type) return result.value;
          }
        };
      }

      async function statusOf(runId: string): Promise<string | undefined> {
        const read = await http(app)
          .get(`${runsPath()}/${runId}`)
          .set('Cookie', world.alpha.owner.cookie);
        return (read.body as { status?: string }).status;
      }

      beforeAll(async () => {
        suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
        fake = await startFakeDaytona({ port: FAKE.port });
        git = fakeGit(fake);
        fake.workspace.set(`${fake.workDir}/README.md`, {
          content: Buffer.from('# Demo\n'),
          kind: 'file',
        });

        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
          .overrideProvider(BREACHED_PASSWORD_PORT)
          .useClass(ScriptedBreachPort)
          .overrideProvider(LOCAL_AGENT_TIMINGS)
          .useValue(TIMINGS)
          .overrideProvider(AGENT_TIMINGS)
          .useValue(AGENT)
          .compile();

        app = moduleRef.createNestApplication();
        configureApplication(app);
        await app.init();
        await app.listen(0);
        port = ((app.getHttpServer() as Server).address() as AddressInfo).port;
        world = await createTwoTenantWorld(app);

        const { orgId, projectId } = world.alpha;
        await app
          .get(TenantTransactionRunner)
          .runInTenantScope({ orgId, userId: null }, (tx) =>
            app.get(SandboxService).register(tx, { daytonaId: fake.sandboxId, orgId, projectId }),
          );
      }, LOCKED_BOOT_TIMEOUT_MS);

      afterAll(async () => {
        for (const each of open.splice(0)) each.close();
        if (world) await destroyTwoTenantWorld(app, world);
        await app?.close();
        await fake?.close();
        await suiteLock?.release();
      });

      it(
        'runs a companion tool.call in the sandbox, answers it with tool.result, and checkpoints the turn',
        async () => {
          const device = await pair(world.alpha.owner.cookie);
          await http(app)
            .post(`${COMPANION}/status`)
            .set(bearer(device.token))
            .send({
              companionVersion: '0.2.0',
              providers: [
                {
                  auth: { method: 'subscription', plan: 'Max', status: 'authenticated' },
                  checkedAt: new Date().toISOString(),
                  installed: true,
                  message: null,
                  models: [],
                  policy: { allowed: true, reason: null },
                  provider: 'claude',
                  version: '2.0.0',
                },
              ],
              // No workspace at all: a sandbox run needs none.
              workspaces: [],
            })
            .expect(204);
          const next = await connect(device.token);
          await next('hello');

          const created = await unsafe(http(app).post(runsPath()), [world.alpha.owner.cookie])
            .send({
              localAgent: { deviceId: device.deviceId, provider: 'claude' },
              prompt: 'edit the readme',
            })
            .expect(201);
          const run = runResponseSchema.parse(created.body);

          const start = JSON.parse((await next('run.start')).data!) as Extract<
            CompanionCommand,
            { type: 'run.start' }
          >;
          expect(start).toMatchObject({ runId: run.id, toolMode: 'sandbox', workspaceId: null });
          expect(start.conversationKey).toMatch(/^[0-9a-f]{32}$/);
          expect(start.toolset?.map((tool) => tool.name)).toEqual([
            'fs_read',
            'fs_list',
            'fs_edit',
            'exec',
            'search',
            'find',
            'preview_status',
          ]);

          const post = (events: CompanionRunEvent[]) =>
            http(app)
              .post(`${COMPANION}/runs/${run.id}/events`)
              .set(bearer(device.token))
              .send({ events, turn: 1 })
              .expect(204);

          const content = '# Demo\n\nEdited over the bridge.\n';
          await post([
            {
              data: { input: { path: 'README.md' }, name: 'mcp__baios__fs_edit', toolId: 'cli-1' },
              seq: 1,
              type: 'tool.start',
            },
            {
              data: { callId: 'call-1', input: { content, path: 'README.md' }, name: 'fs_edit' },
              seq: 2,
              type: 'tool.call',
            },
          ]);

          const result = JSON.parse((await next('tool.result')).data!) as Extract<
            CompanionCommand,
            { type: 'tool.result' }
          >;
          expect(result).toMatchObject({ callId: 'call-1', ok: true, runId: run.id, turn: 1 });
          expect(result.output).toContain('Edited over the bridge.');
          const readme = fake.workspace.get(`${fake.workDir}/README.md`);
          expect(readme?.kind === 'file' ? readme.content.toString() : undefined).toBe(content);

          await post([
            { data: { ok: true, summary: 'edited', toolId: 'cli-1' }, seq: 3, type: 'tool.end' },
            { data: { text: 'Edited.' }, seq: 4, type: 'text.delta' },
            { data: { status: 'completed' }, seq: 5, type: 'terminal' },
          ]);

          const deadline = Date.now() + WAIT_MS;
          while ((await statusOf(run.id)) !== 'awaiting_input') {
            if (Date.now() > deadline) throw new Error('timed out waiting for awaiting_input');
            await sleep(50);
          }

          const events = runEventsResponseSchema.parse(
            (
              await http(app)
                .get(`${runsPath()}/${run.id}/events?after=0&limit=500`)
                .set('Cookie', world.alpha.owner.cookie)
                .expect(200)
            ).body,
          ).events;
          const tools = events.filter((event) => event.type === 'tool.start');
          // One step, the server's: the CLI's own event for the bridged call is not duplicated.
          expect(tools).toHaveLength(1);
          expect(tools[0]).toMatchObject({ data: { tool: 'fs_edit' } });
          expect(events.map((event) => event.type)).toEqual(
            expect.arrayContaining(['tool.end', 'file.patch', 'checkpoint']),
          );

          const checkpoints = checkpointListResponseSchema.parse(
            (
              await http(app)
                .get(
                  `/api/v1/orgs/${world.alpha.orgId}/projects/${world.alpha.projectId}/checkpoints`,
                )
                .set('Cookie', world.alpha.owner.cookie)
                .expect(200)
            ).body,
          );
          expect(checkpoints.items.map((item) => item.kind)).toEqual(['turn', 'baseline']);
          expect(checkpoints.items[0]).toMatchObject({
            gitSha: git.head(),
            label: 'Turn 1',
            runId: run.id,
            turn: 1,
          });
        },
        WAIT_MS * 3,
      );
    },
  );
});
