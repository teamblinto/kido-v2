import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  type CompanionAuthCommand,
  type CompanionCommand,
  type CompanionRunEvent,
  checkpointListResponseSchema,
  runEventsResponseSchema,
  runResponseSchema,
  subscriptionListSchema,
  subscriptionStatusSchema,
} from '@repo/contracts';
import { agentHomes } from '@repo/db';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { STREAM_REDIS } from '../src/common/redis/redis.constants';
import { APP_DATABASE } from '../src/database/database.constants';
import type { ForgeDatabase } from '../src/database/database.types';
import { TenantTransactionRunner } from '../src/database/tenant-transaction';
import { AGENT_TIMINGS, type AgentTimings } from '../src/modules/agent/agent.constants';
import {
  BREACHED_PASSWORD_PORT,
  type BreachedPasswordPort,
} from '../src/modules/identity/password/breached-password.port';
import { AgentHomeRepository } from '../src/modules/local-agent/agent-home.repository';
import {
  AGENT_HOME_TIMINGS,
  type AgentHomeTimings,
} from '../src/modules/local-agent/agent-home.service';
import {
  DEFAULT_LOCAL_AGENT_TIMINGS,
  LOCAL_AGENT_TIMINGS,
  type LocalAgentTimings,
} from '../src/modules/local-agent/local-agent.constants';
import { LocalAgentStore } from '../src/modules/local-agent/local-agent.store';
import { SandboxService } from '../src/modules/sandbox/sandbox.service';
import { unsafe } from './support/csrf-client';
import { type FakeDaytona, startFakeDaytona } from './support/fake-daytona';
import { type FakeGit, fakeGit } from './support/fake-git';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';
import { type Frame, type OpenStream, openStream } from './support/sse';
import { dropFakeVersions, publishFakeVersion } from './support/template-versions';
import {
  createTwoTenantWorld,
  destroyTwoTenantWorld,
  http,
  type TwoTenantWorld,
} from './support/two-tenant-fixture';

/** Before any import: the worker claims runs, homes are on, the Daytona is the fake's. */
const FAKE = vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
  process.env.RUN_PROFILES = 'api,agent,events';
  process.env.LOCAL_AGENT_ENABLED = 'true';
  process.env.AGENT_HOME_ENABLED = 'true';
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_PARALLELISM = '1';
  process.env.ARGON2_TIME_COST = '1';
  process.env.THROTTLE_LIMIT = '100000';

  const port = 20_000 + Math.floor(Math.random() * 20_000);
  process.env.DAYTONA_API_URL = `http://127.0.0.1:${port}/api`;
  process.env.DAYTONA_API_KEY = 'dtn_fake_key';

  return { port };
});

const bundleDir = mkdtempSync(path.join(tmpdir(), 'agent-home-e2e-'));
process.env.AGENT_HOME_RUNNER_BUNDLE = path.join(bundleDir, 'main.js');
writeFileSync(process.env.AGENT_HOME_RUNNER_BUNDLE, 'console.log("hosted runner")\n');

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const LOCKED_BOOT_TIMEOUT_MS = 600_000;
const WAIT_MS = 20_000;
const SUBSCRIPTIONS = '/api/v1/me/subscriptions';
const COMPANION = '/api/v1/local-agent';
const CODE = 'Code_from-Anthropic.page#42';
const SIGN_IN_URL = 'https://claude.com/cai/oauth/authorize?code=true&state=e2e';

const TIMINGS: LocalAgentTimings = {
  ...DEFAULT_LOCAL_AGENT_TIMINGS,
  cancelPollMs: 50,
  heartbeatMs: 1_000,
  interruptWaitMs: 1_000,
  offlineGraceMs: 1_000,
  readBlockMs: 100,
  startAckMs: 10_000,
};

const HOME_TIMINGS: AgentHomeTimings = {
  disconnectStartMs: 2_000,
  onlineMs: 10_000,
  pollMs: 50,
  reportMs: 2_000,
  sandboxReadyMs: 10_000,
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

async function until<T>(what: string, probe: () => Promise<T | undefined> | T | undefined) {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

/**
 * Spec 041's cloud subscription agent through HTTP against Postgres, Redis, the worker and the
 * fake Daytona: connect provisions and starts an agent home, the suite plays the hosted runner the
 * home would have started (with the token the server wrote into it), the sign-in URL and code
 * round-trip — the code only on the live `auth` channel — the status report makes it connected, and
 * a subscription run bridges a tool call into the project's sandbox and checkpoints the turn.
 */
describe('Cloud subscription agent (e2e)', () => {
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
      const cookie = () => world.alpha.owner.cookie;
      const runsPath = () =>
        `/api/v1/orgs/${world.alpha.orgId}/projects/${world.alpha.projectId}/runs`;

      async function status() {
        const read = await http(app).get(SUBSCRIPTIONS).set('Cookie', cookie()).expect(200);
        return subscriptionListSchema.parse(read.body).claude;
      }

      async function connect(token: string) {
        const opened = await openStream(port, `${COMPANION}/connect`, { headers: bearer(token) });
        open.push(opened);
        const iterator = opened.frames[Symbol.asyncIterator]();
        const seen: Frame[] = [];
        const next = async (event: string, type?: string): Promise<Frame> => {
          const deadline = Date.now() + WAIT_MS;
          for (;;) {
            const result = await Promise.race([
              iterator.next(),
              sleep(Math.max(1, deadline - Date.now())).then(() => 'timeout' as const),
            ]);
            if (result === 'timeout')
              throw new Error(`timed out waiting for ${event} ${type ?? ''}`);
            if (result.done === true) throw new Error(`stream ended waiting for ${event}`);
            seen.push(result.value);
            const parsed = JSON.parse(result.value.data ?? '{}') as { type?: string };
            if (result.value.event === event && (type === undefined || parsed.type === type)) {
              return result.value;
            }
          }
        };
        return { next, seen };
      }

      /** What the signed-in CLI's own `initialize` and `get_usage` said, as the runner reports it. */
      const MODELS = [{ description: 'For complex work', id: 'opus', label: 'Opus 5.5' }];
      const USAGE = {
        checkedAt: '2026-11-03T12:00:00.000Z',
        windows: [{ kind: 'session', resetsAt: '2026-11-03T17:50:00.000Z', utilization: 59 }],
      };

      function report(
        token: string,
        auth: 'authenticated' | 'unauthenticated',
        details: { models: unknown[]; usage?: unknown } = { models: [] },
      ) {
        return http(app)
          .post(`${COMPANION}/status`)
          .set(bearer(token))
          .send({
            companionVersion: '0.3.0',
            providers: [
              {
                auth: {
                  method: auth === 'authenticated' ? 'subscription' : null,
                  plan: auth === 'authenticated' ? 'Max' : null,
                  status: auth,
                },
                checkedAt: new Date().toISOString(),
                installed: true,
                // What a signed-out runner says; the person must never see it.
                message:
                  auth === 'authenticated'
                    ? null
                    : 'Claude Code is not signed in. Sign in again from BAIOS.',
                models: details.models,
                policy: { allowed: true, reason: null },
                provider: 'claude',
                ...(details.usage === undefined ? {} : { usage: details.usage }),
                version: '2.1.0',
              },
            ],
          })
          .expect(204);
      }

      beforeAll(async () => {
        suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
        fake = await startFakeDaytona({ port: FAKE.port });
        // The home's one command of its own: protecting the token file.
        git = fakeGit(fake, (request) =>
          request.command.startsWith('chmod 600 ')
            ? { exitCode: 0, result: '' }
            : { exitCode: 127, result: 'unscripted' },
        );
        fake.workspace.set(`${fake.workDir}/README.md`, {
          content: Buffer.from('# Demo\n'),
          kind: 'file',
        });

        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
          .overrideProvider(BREACHED_PASSWORD_PORT)
          .useClass(ScriptedBreachPort)
          .overrideProvider(LOCAL_AGENT_TIMINGS)
          .useValue(TIMINGS)
          .overrideProvider(AGENT_HOME_TIMINGS)
          .useValue(HOME_TIMINGS)
          .overrideProvider(AGENT_TIMINGS)
          .useValue(AGENT)
          .compile();

        app = moduleRef.createNestApplication();
        configureApplication(app);
        await app.init();
        await app.listen(0);
        port = ((app.getHttpServer() as Server).address() as AddressInfo).port;
        world = await createTwoTenantWorld(app);
        await publishFakeVersion(
          app.get<ForgeDatabase>(APP_DATABASE),
          'agent-home',
          'forge-tpl-agent-home-e2e',
        );

        const { orgId, projectId } = world.alpha;
        await app
          .get(TenantTransactionRunner)
          .runInTenantScope({ orgId, userId: null }, (tx) =>
            app.get(SandboxService).register(tx, { daytonaId: fake.sandboxId, orgId, projectId }),
          );
      }, LOCKED_BOOT_TIMEOUT_MS);

      afterAll(async () => {
        for (const each of open.splice(0)) each.close();
        if (app) await dropFakeVersions(app.get<ForgeDatabase>(APP_DATABASE), 'agent-home');
        if (world) await destroyTwoTenantWorld(app, world);
        await app?.close();
        await fake?.close();
        await suiteLock?.release();
      });

      it('creates one home for concurrent connects: the race loser reads the winner’s', async () => {
        const repository = app.get(AgentHomeRepository);
        const userId = world.beta.owner.userId;
        const homes = await Promise.all(
          Array.from({ length: 6 }, (_, n) =>
            repository.findOrCreate(userId, 'claude', `placeholder-${String(n)}`),
          ),
        );

        expect(new Set(homes.map((home) => home.id)).size).toBe(1);
        await repository.remove(homes[0]!, new Date());
      });

      it('releases the start lock only while it still holds it', async () => {
        const store = app.get(LocalAgentStore);
        const stream = app.get<Redis>(STREAM_REDIS);
        const key = 'local-agent:home-start:e2e-lock';

        const token = await store.lockHomeStart('e2e-lock', 60);
        expect(token).toBeDefined();
        expect(await store.lockHomeStart('e2e-lock', 60)).toBeUndefined();
        // Our TTL ran out and another start took the lock: our release must leave theirs.
        await stream.set(key, 'someone-else');
        await store.unlockHomeStart('e2e-lock', token!);
        expect(await stream.get(key)).toBe('someone-else');
        await store.unlockHomeStart('e2e-lock', 'someone-else');
        expect(await stream.exists(key)).toBe(0);
      });

      it(
        'connects, signs in with the code on the live channel only, runs a tool call and checkpoints',
        async () => {
          expect((await status()).state).toBe('disconnected');

          // A subscription run before connecting is refused with its own slug.
          const refused = await unsafe(http(app).post(runsPath()), [cookie()])
            .send({ prompt: 'hi', subscription: { provider: 'claude' } })
            .expect(409);
          expect((refused.body as { type: string }).type).toMatch(/subscription-not-connected$/);

          const connected = await unsafe(http(app).post(`${SUBSCRIPTIONS}/claude/connect`), [
            cookie(),
          ]).expect(202);
          expect(subscriptionStatusSchema.parse(connected.body).state).toBe('provisioning');

          // Daytona's runner catching up with the home's creation.
          const homeId = await until('the home sandbox', () => {
            const home = [...fake.sandboxes.values()].find(
              (sandbox) => sandbox.labels.baios === 'agent-home',
            );
            if (home !== undefined) fake.settle(home.id);
            return home?.id;
          });
          expect(fake.sandboxes.get(homeId)?.labels).toMatchObject({
            owner: 'forge-test',
            provider: 'claude',
            userId: world.alpha.owner.userId,
          });
          const session = await until('the runner session', () => fake.sessions.at(-1));
          expect(session).toMatchObject({ sandboxId: homeId, sessionId: 'baios-runner' });
          expect(session.command).toContain('node /opt/baios/runner.mjs start --hosted');

          const tokenFile = fake.workspace.get('/opt/baios/token');
          const token = tokenFile?.kind === 'file' ? tokenFile.content.toString() : '';
          expect(token).toMatch(/^bld_/);
          expect(session.command).not.toContain(token);

          // The suite is now the hosted runner.
          const runner = await connect(token);
          await runner.next('hello');
          await report(token, 'unauthenticated');
          const start = JSON.parse(
            (await runner.next('auth', 'auth.login.start')).data!,
          ) as CompanionAuthCommand;
          expect(start).toEqual({ provider: 'claude', type: 'auth.login.start' });

          // A malformed URL is a 422, never a 500.
          await http(app)
            .post(`${COMPANION}/auth`)
            .set(bearer(token))
            .send({ provider: 'claude', type: 'auth.login.url', url: 'not a url' })
            .expect(422);
          await http(app)
            .post(`${COMPANION}/auth`)
            .set(bearer(token))
            .send({ provider: 'claude', type: 'auth.login.url', url: SIGN_IN_URL })
            .expect(204);
          const awaiting = await status();
          expect(awaiting).toMatchObject({
            signIn: { url: SIGN_IN_URL },
            state: 'awaiting-sign-in',
          });

          // A code with control characters is refused, and the refusal does not echo it.
          const bad = await unsafe(http(app).post(`${SUBSCRIPTIONS}/claude/code`), [cookie()])
            .send({ code: 'evil\u001b[2Jcode' })
            .expect(422);
          expect(JSON.stringify(bad.body)).not.toContain('evil');

          await unsafe(http(app).post(`${SUBSCRIPTIONS}/claude/code`), [cookie()])
            .send({ code: CODE })
            .expect(202);
          const delivered = await runner.next('auth', 'auth.login.code');
          expect(delivered.id).toBeUndefined();
          expect(JSON.parse(delivered.data!) as CompanionAuthCommand).toEqual({
            code: CODE,
            provider: 'claude',
            type: 'auth.login.code',
          });

          // Nowhere durable: not the device's command stream, not any Redis key.
          const stream = app.get<Redis>(STREAM_REDIS);
          const [home] = await app
            .get<ForgeDatabase>(APP_DATABASE)
            .select()
            .from(agentHomes)
            .where(eq(agentHomes.userId, world.alpha.owner.userId));
          const deviceId = home!.deviceId;
          const commands = await stream.xrange(`local-agent:cmd:${deviceId}`, '-', '+');
          expect(JSON.stringify(commands)).not.toContain(CODE);
          for (const key of await stream.keys('local-agent:*')) {
            if ((await stream.type(key)) === 'string') {
              expect(await stream.get(key)).not.toContain(CODE);
            }
          }

          await http(app)
            .post(`${COMPANION}/auth`)
            .set(bearer(token))
            .send({ message: null, ok: true, provider: 'claude', type: 'auth.login.result' })
            .expect(204);
          expect((await status()).state).toBe('verifying');
          await report(token, 'authenticated', { models: MODELS, usage: USAGE });
          expect(await status()).toMatchObject({
            models: [{ description: 'For complex work', id: 'opus', label: 'Opus 5.5' }],
            plan: 'Max',
            signIn: null,
            state: 'connected',
            usage: USAGE,
          });
          // A report whose runner could not ask the CLI keeps the last models and limits.
          await report(token, 'authenticated');
          expect(await status()).toMatchObject({ models: MODELS, usage: USAGE });

          // A start that gave up too soon marked the home error; its runner's next report heals it.
          await app
            .get<ForgeDatabase>(APP_DATABASE)
            .update(agentHomes)
            .set({ lastError: 'gave up', state: 'error' })
            .where(eq(agentHomes.userId, world.alpha.owner.userId));
          expect((await status()).state).toBe('error');
          await report(token, 'authenticated');
          expect((await status()).state).toBe('connected');

          // A subscription run: a sandbox-tool-mode local run on the home's device.
          const created = await unsafe(http(app).post(runsPath()), [cookie()])
            .send({ prompt: 'edit the readme', subscription: { provider: 'claude' } })
            .expect(201);
          const run = runResponseSchema.parse(created.body);
          const runStart = JSON.parse((await runner.next('run.start')).data!) as Extract<
            CompanionCommand,
            { type: 'run.start' }
          >;
          expect(runStart).toMatchObject({ model: null, provider: 'claude', runId: run.id });
          expect(runStart.conversationKey).toMatch(/^[0-9a-f]{32}$/);
          expect(runStart.toolset.map((tool) => tool.name)).toEqual([
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
              .set(bearer(token))
              .send({ events, turn: 1 })
              .expect(204);
          const content = '# Demo\n\nEdited from the agent home.\n';
          await post([
            // The CLI's own view of the bridged call: dropped, the server's step is the record.
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
          const result = JSON.parse((await runner.next('tool.result')).data!) as Extract<
            CompanionCommand,
            { type: 'tool.result' }
          >;
          expect(result).toMatchObject({ callId: 'call-1', ok: true, runId: run.id });
          const readme = fake.workspace.get(`${fake.workDir}/README.md`);
          expect(readme?.kind === 'file' ? readme.content.toString() : undefined).toBe(content);
          await post([
            { data: { ok: true, summary: 'edited', toolId: 'cli-1' }, seq: 3, type: 'tool.end' },
            { data: { text: 'Edited.' }, seq: 4, type: 'text.delta' },
            { data: { status: 'completed' }, seq: 5, type: 'terminal' },
          ]);

          await until('awaiting_input', async () => {
            const read = await http(app).get(`${runsPath()}/${run.id}`).set('Cookie', cookie());
            return (read.body as { status?: string }).status === 'awaiting_input'
              ? true
              : undefined;
          });
          const events = runEventsResponseSchema.parse(
            (
              await http(app)
                .get(`${runsPath()}/${run.id}/events?after=0&limit=500`)
                .set('Cookie', cookie())
                .expect(200)
            ).body,
          ).events;
          expect(events.map((event) => event.type)).toEqual(
            expect.arrayContaining(['tool.start', 'tool.end', 'file.patch', 'checkpoint']),
          );
          const tools = events.filter((event) => event.type === 'tool.start');
          expect(tools).toHaveLength(1);
          expect(tools[0]).toMatchObject({ data: { tool: 'fs_edit' } });
          const checkpoints = checkpointListResponseSchema.parse(
            (
              await http(app)
                .get(
                  `/api/v1/orgs/${world.alpha.orgId}/projects/${world.alpha.projectId}/checkpoints`,
                )
                .set('Cookie', cookie())
                .expect(200)
            ).body,
          );
          expect(checkpoints.items[0]).toMatchObject({
            gitSha: git.head(),
            label: 'edit the readme',
          });

          // The retired "your computers" list (spec 040) is no longer served.
          await http(app).get('/api/v1/me/local-agents').set('Cookie', cookie()).expect(404);

          // Disconnect: logout in the home first, then the sandbox, the device and the row go.
          const disconnecting = unsafe(http(app).delete(`${SUBSCRIPTIONS}/claude`), [cookie()]);
          const gone = disconnecting.then((response) => response);
          await runner.next('auth', 'auth.logout');
          await report(token, 'unauthenticated');
          expect((await gone).status).toBe(204);
          expect(fake.sandboxes.has(homeId)).toBe(false);
          expect((await status()).state).toBe('disconnected');
          await http(app).post(`${COMPANION}/status`).set(bearer(token)).send({}).expect(401);
        },
        WAIT_MS * 4,
      );
    },
  );
});
