import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { type RunResponse, runResponseSchema } from '@repo/contracts';
import { schema } from '@repo/db';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { TenantTransactionRunner } from '../src/database/tenant-transaction';
import {
  AGENT_TIMINGS,
  type AgentTimings,
  LLM_PROVIDER,
  MAP_BUDGET_BYTES,
} from '../src/modules/agent/agent.constants';
import { renderMap } from '../src/modules/agent/context/repo-map';
import type { ModelRequest } from '../src/modules/agent/llm-provider.port';
import { estimateTokens, SYSTEM_PROMPT } from '../src/modules/agent/prompt';
import { RetryableFailure } from '../src/modules/outbox/consumer';
import { SandboxService } from '../src/modules/sandbox/sandbox.service';
import { unsafe } from './support/csrf-client';
import { type FakeDaytona, startFakeDaytona } from './support/fake-daytona';
import { type FakeGit, fakeGit } from './support/fake-git';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';
import { seedProviderKey } from './support/seed-provider-key';
import { ScriptedProvider, type ScriptedStep } from './support/scripted-provider';
import {
  createTwoTenantWorld,
  destroyTwoTenantWorld,
  http,
  type TwoTenantWorld,
} from './support/two-tenant-fixture';

/** Before any import: `ConfigModule.forRoot` reads the environment when `AppModule` loads. */
const FAKE = vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
  process.env.RUN_PROFILES = 'api,agent,events';
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

const ORGS = '/api/v1/orgs';
const LOCKED_BOOT_TIMEOUT_MS = 600_000;
const RUN_TIMEOUT_MS = 15_000;
/** Its own fake sandbox id, so a stale tenant left by another suite never collides at `register`. */
const SANDBOX_ID = 'sandbox-fake-context-0001';
const TIMINGS: AgentTimings = {
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

/**
 * Spec 021: the real executor and `ContextAssembler` over the real queue, `ScriptedProvider` under
 * `LLM_PROVIDER` and a fake Daytona. One world for the whole file; each story appends `it`s and
 * drives them through `completeRun`.
 */
describe('Context assembly (e2e)', () => {
  describe.skipIf(!postgres || !redis)(
    'against Postgres, the queue and stream Redis roles and a fake Daytona',
    () => {
      let app: INestApplication;
      let fake: FakeDaytona;
      let world: TwoTenantWorld;
      let transactions: TenantTransactionRunner;
      let suiteLock: { release: () => Promise<void> } | undefined;
      let provider: ScriptedProvider;
      let git: FakeGit;

      function runsPath(): string {
        return `${ORGS}/${world.alpha.orgId}/projects/${world.alpha.projectId}/runs`;
      }

      async function read(runId: string): Promise<RunResponse> {
        const response = await http(app)
          .get(`${runsPath()}/${runId}`)
          .set('Cookie', world.alpha.owner.cookie)
          .expect(200);

        return runResponseSchema.parse(response.body);
      }

      /**
       * Scripts the provider, creates a run the product's way and waits for it to settle. Answers
       * the final read and exactly the model requests this run made, in order.
       */
      async function completeRun(
        steps: readonly ScriptedStep[],
        options: { prompt?: string; status?: RunResponse['status']; timeoutMs?: number } = {},
      ): Promise<{ run: RunResponse; requests: ModelRequest[] }> {
        const first = provider.calls.length;
        provider.script(...steps);
        const response = await unsafe(http(app).post(runsPath()), [world.alpha.owner.cookie])
          .send({ prompt: options.prompt ?? 'Say hello' })
          .expect(201);
        const created = runResponseSchema.parse(response.body);
        const wanted = options.status ?? 'succeeded';
        const deadline = Date.now() + (options.timeoutMs ?? RUN_TIMEOUT_MS);

        for (;;) {
          const run = await read(created.id);

          if (run.status === wanted) {
            return { requests: provider.calls.slice(first).map((call) => call.request), run };
          }
          if (Date.now() > deadline) {
            throw new Error(`timed out waiting for ${wanted}; run is ${run.status}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }

      /** The work dir holds exactly these files (`.git/` kept); every other test's leftovers go. */
      function seed(files: Record<string, string>): void {
        for (const key of [...fake.workspace.keys()]) {
          const path = key.slice(`${fake.workDir}/`.length);
          if (key.startsWith(`${fake.workDir}/`) && path !== '.git' && !path.startsWith('.git/')) {
            fake.workspace.delete(key);
          }
        }
        for (const [path, content] of Object.entries(files)) {
          fake.workspace.set(`${fake.workDir}/${path}`, {
            content: Buffer.from(content),
            kind: 'file',
          });
        }
      }

      const statusCalls = (): number =>
        git.commands.filter((command) => command === 'git status --porcelain').length;

      const SCAFFOLD = {
        '.gitignore': 'node_modules/\ndist/\n',
        'README.md': '# Demo\n',
        'dist/index.js': 'built',
        'node_modules/dep/index.js': 'module.exports = {};',
        'package.json': '{ "name": "demo" }\n',
        'src/index.ts': 'export const greet = () => 1;\nexport function main() {}\n',
        'src/util.js': 'export default helper;\nexport { a as b };\n',
      };
      const SCAFFOLD_MAP = [
        '.gitignore',
        'README.md',
        'package.json',
        'src/',
        '  index.ts  · exports: greet, main',
        '  util.js  · exports: b, helper',
      ].join('\n');

      /** The durable events of one type, in `seq` order. */
      async function eventsOf(runId: string, type: string) {
        const rows = await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
          tx
            .select({ data: schema.runEvents.data, type: schema.runEvents.type })
            .from(schema.runEvents)
            .where(eq(schema.runEvents.runId, runId))
            .orderBy(asc(schema.runEvents.seq)),
        );

        return rows.filter((row) => row.type === type).map((row) => row.data);
      }

      beforeAll(async () => {
        suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
        fake = await startFakeDaytona({ port: FAKE.port, sandboxId: SANDBOX_ID });
        git = fakeGit(fake, (request) => {
          // SC-007's exec-only tree change (010's allowlist takes one program, no `&&`): a
          // `touch` lands an empty file; `mkdir` needs nothing, the fake's dirs are implicit.
          const touch = /^touch (\S+)$/.exec(request.command);
          if (touch) {
            fake.workspace.set(`${fake.workDir}/${touch[1]!}`, {
              content: Buffer.alloc(0),
              kind: 'file',
            });
          }
          return { exitCode: 0, result: `ran: ${request.command}\n` };
        });
        provider = new ScriptedProvider();

        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
          .overrideProvider(LLM_PROVIDER)
          .useValue(provider)
          .overrideProvider(AGENT_TIMINGS)
          .useValue(TIMINGS)
          .compile();

        app = moduleRef.createNestApplication();
        configureApplication(app);
        await app.init();

        transactions = app.get(TenantTransactionRunner);
        world = await createTwoTenantWorld(app);
        // Run create resolves a credential: the organisation's own key (platform credits are
        // retired), which only the scripted provider ever receives.
        await seedProviderKey(app, world.alpha);

        const { orgId, projectId } = world.alpha;
        await transactions.runInTenantScope({ orgId, userId: null }, (tx) =>
          app.get(SandboxService).register(tx, { daytonaId: fake.sandboxId, orgId, projectId }),
        );
      }, LOCKED_BOOT_TIMEOUT_MS);

      beforeEach(() => {
        fake.requests.splice(0);
        fake.workspace.set(`${fake.workDir}/README.md`, {
          content: Buffer.from('# Demo\n'),
          kind: 'file',
        });
      });

      afterAll(async () => {
        if (world) await destroyTwoTenantWorld(app, world);
        await app?.close();
        await fake?.close();
        await suiteLock?.release();
      });

      describe('US1 — the agent knows the shape of the project before it reads a file', () => {
        it('SC-001: the first request carries a map naming every non-excluded scaffold file and the exports of every parseable source file within 6144 bytes', async () => {
          seed(SCAFFOLD);
          const { requests } = await completeRun([{ text: 'hello' }]);

          expect(requests).toHaveLength(1);
          expect(requests[0]!.context!.map).toBe(SCAFFOLD_MAP);
          expect(Buffer.byteLength(requests[0]!.context!.map)).toBeLessThanOrEqual(6144);
        });

        it("SC-002: a turn that creates src/hello.ts puts it in the next turn's map; an unchanged tree keeps the map byte-identical", async () => {
          seed(SCAFFOLD);
          const before = await completeRun([{ text: 'hello' }]);
          const writing = await completeRun([
            {
              toolCalls: [
                {
                  id: 'call-1',
                  input: { content: 'export const hello = 1;\n', path: 'src/hello.ts' },
                  name: 'fs_edit',
                },
              ],
            },
            { text: 'done' },
          ]);
          const after = await completeRun([{ text: 'hello again' }]);

          expect(before.requests[0]!.context!.map).toBe(SCAFFOLD_MAP);
          expect(writing.requests).toHaveLength(2);
          expect(writing.requests[0]!.context!.map).toBe(SCAFFOLD_MAP);
          expect(writing.requests[1]!.context!.map).toBe(
            SCAFFOLD_MAP.replace('src/\n', 'src/\n  hello.ts  · exports: hello\n'),
          );
          expect(after.requests[0]!.context!.map).toBe(writing.requests[1]!.context!.map);
        });

        it("SC-007: an exec-only mkdir+touch changes the next turn's map and a read-only turn issues no git status", async () => {
          seed(SCAFFOLD);
          const making = await completeRun([
            {
              toolCalls: [
                { id: 'call-1', input: { command: 'mkdir -p tools' }, name: 'exec' },
                { id: 'call-2', input: { command: 'touch tools/.keep' }, name: 'exec' },
              ],
            },
            { text: 'done' },
          ]);

          expect(making.requests).toHaveLength(2);
          expect(making.requests[0]!.context!.map).toBe(SCAFFOLD_MAP);
          expect(making.requests[1]!.context!.map).toBe(`${SCAFFOLD_MAP}\ntools/\n  .keep`);

          // A read-only turn adds no `git status` over a run with no tool turn at all.
          const plainStart = statusCalls();
          await completeRun([{ text: 'hello' }]);
          const perPlainRun = statusCalls() - plainStart;
          const readStart = statusCalls();
          const reading = await completeRun([
            { toolCalls: [{ id: 'call-3', input: { path: 'README.md' }, name: 'fs_read' }] },
            { text: 'done' },
          ]);

          expect(reading.requests).toHaveLength(2);
          expect(reading.requests[1]!.context!.map).toBe(reading.requests[0]!.context!.map);
          expect(statusCalls() - readStart).toBe(perPlainRun);
        });

        it('US1 scenario 4: a 400-file tree trims deterministically and says so', async () => {
          const paths = Array.from(
            { length: 400 },
            (_, i) =>
              `packages/area-${String(i % 8)}/module-${String(i % 40)}/file-number-${String(i)}.txt`,
          );
          seed(Object.fromEntries(paths.map((path) => [path, ''])));
          const { requests } = await completeRun([{ text: 'hello' }]);
          const map = requests[0]!.context!.map;

          expect(Buffer.byteLength(map)).toBeLessThanOrEqual(MAP_BUDGET_BYTES);
          expect(map.endsWith('\n[trimmed]')).toBe(true);
          expect(map).toMatch(/^ {4}module-\d+\/ \(\d+ files\)$/m);
          expect(map).toBe(renderMap(paths.map((path) => ({ exports: [], path }))));
        });
      });

      /**
       * US2: 40 turns of one 12,200-byte read each. The chars/4 estimate crosses 60k tokens once
       * 20 results are in (turn 21's request); the cut keeps 6 turns, so the second crossing is
       * 20 results past the first marker (turn 35's request) and nothing crosses a third time.
       */
      describe('US2 — a long run keeps its history and sends a summary in its place', () => {
        const CHEAP_MODEL = 'claude-haiku-4-5';
        const BIG = 'x'.repeat(12_200);
        const SUMMARY_HEADER = 'Summary of the conversation so far:\n';
        const readTurn = (i: number): ScriptedStep => ({
          toolCalls: [{ id: `call-${String(i)}`, input: { path: 'big.txt' }, name: 'fs_read' }],
        });
        const turns = (count: number): ScriptedStep[] => [
          ...Array.from({ length: count - 1 }, (_, i) => readTurn(i + 1)),
          { text: 'done' },
        ];
        const modelCalls = (from: number) =>
          provider.calls.slice(from).filter((call) => call.model !== CHEAP_MODEL);
        const summaryCalls = (from: number) =>
          provider.calls.slice(from).filter((call) => call.model === CHEAP_MODEL);
        const assistantsIn = (request: ModelRequest) =>
          request.messages.filter((m) => m.role === 'assistant').length;

        async function row(runId: string) {
          const [found] = await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
            tx.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId)),
          );
          return found!;
        }

        async function messageRows(runId: string) {
          return transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
            tx
              .select({ id: schema.runMessages.id, role: schema.runMessages.role })
              .from(schema.runMessages)
              .where(eq(schema.runMessages.runId, runId)),
          );
        }

        beforeEach(() => {
          seed({ ...SCAFFOLD, 'big.txt': BIG });
        });

        it('SC-004: a 40-turn scripted run sends summary + 6 turns from the crossing, keeps every run_messages row, and a resumed attempt sends the same summary', async () => {
          const first = provider.calls.length;
          provider.scriptModel(CHEAP_MODEL, { text: 'FIRST SUMMARY' }, { text: 'SECOND SUMMARY' });
          // Turn 21's model call — right after the first summary is stored — crashes the attempt;
          // the queue re-delivers the run and the next attempt resumes from the rows.
          const steps = turns(40);
          steps.splice(20, 0, { throw: new RetryableFailure('timeout') });
          const { run } = await completeRun(steps, { timeoutMs: 60_000 });
          const calls = modelCalls(first);

          // Up to the crossing every message goes verbatim; at it, the summary and six turns.
          expect(assistantsIn(calls[19]!.request)).toBe(19);
          expect(calls[20]!.request.messages[0]).toEqual({
            content: `${SUMMARY_HEADER}FIRST SUMMARY`,
            role: 'user',
          });
          expect(assistantsIn(calls[20]!.request)).toBe(6);
          expect(calls[20]!.request.messages).toHaveLength(13);
          // The resumed attempt (epoch 2) repeats the crashed request byte for byte.
          expect(calls[21]!.request.messages).toEqual(calls[20]!.request.messages);
          expect(calls[21]!.request.system).toBe(calls[20]!.request.system);
          expect(calls).toHaveLength(41);
          expect(await row(run.id)).toMatchObject({ leaseEpoch: 2, summary: 'SECOND SUMMARY' });

          // Every row of the 40 turns is kept: the prompt, 39 call+result pairs, the last answer.
          const rows = await messageRows(run.id);
          expect(rows).toHaveLength(80);
          expect(rows.filter((r) => r.role === 'assistant')).toHaveLength(40);
          expect(await eventsOf(run.id, 'usage')).toHaveLength(42);
        }, 70_000);

        it('SC-005: a failing summary call fails no run and lands a summary skip on the row', async () => {
          const first = provider.calls.length;
          provider.scriptModel(CHEAP_MODEL, { fail: 'unavailable' });
          const { run } = await completeRun(turns(21), { timeoutMs: 60_000 });
          const calls = modelCalls(first);

          expect(run.status).toBe('succeeded');
          expect(summaryCalls(first)).toHaveLength(1);
          // Turn 21's request went out verbatim.
          expect(calls).toHaveLength(21);
          expect(assistantsIn(calls[20]!.request)).toBe(20);
          expect(calls[20]!.request.messages[0]).toEqual({ content: 'Say hello', role: 'user' });
          expect(run.contextSkips).toEqual([{ kind: 'summary', reason: 'unavailable', turn: 21 }]);
          expect(await row(run.id)).toMatchObject({ summary: null, summaryThroughMessageId: null });
        }, 70_000);

        it("SC-006: every summary call is on the row's tokens and the per-turn input count after the second crossing is below the first crossing's", async () => {
          const first = provider.calls.length;
          const usage = (inputTokens: number) => ({
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            inputTokens,
            outputTokens: 1,
          });
          provider.scriptModel(
            CHEAP_MODEL,
            { text: 'FIRST SUMMARY', usage: usage(1_000) },
            { text: 'SECOND SUMMARY', usage: usage(2_000) },
          );
          // The model's own input count is the estimate of what it was sent.
          const steps = turns(40);
          const { run } = await completeRun(steps, { timeoutMs: 60_000 });
          const calls = modelCalls(first);
          const summaries = summaryCalls(first);

          expect(summaries).toHaveLength(2);
          expect(summaries[0]!.credential).toEqual(calls[0]!.credential);
          const usages = await eventsOf(run.id, 'usage');
          const fromSummary = usages.filter((u) => (u as { source?: string }).source === 'summary');
          expect(fromSummary).toEqual([
            expect.objectContaining({ inputTokens: 1_000, source: 'summary' }),
            expect.objectContaining({ inputTokens: 2_000, source: 'summary' }),
          ]);
          expect(run.inputTokens).toBe(3_000);
          expect(run.outputTokens).toBe(2);

          // What each model turn was sent: the request just before the first crossing carries 19
          // verbatim turns; every request after the second crossing is smaller than that.
          const sent = (request: ModelRequest) => estimateTokens(request.messages);
          const beforeFirst = sent(calls[19]!.request);
          expect(sent(calls[20]!.request)).toBeLessThan(beforeFirst);
          expect(calls[34]!.request.messages[0]).toEqual({
            content: `${SUMMARY_HEADER}SECOND SUMMARY`,
            role: 'user',
          });
          for (const call of calls.slice(34)) expect(sent(call.request)).toBeLessThan(beforeFirst);
          expect(Math.max(...calls.slice(34).map((c) => sent(c.request)))).toBeLessThan(
            sent(calls[33]!.request),
          );
        }, 70_000);
      });

      describe('US3 — every block sits where the cache can find it', () => {
        it('SC-002 (layout): two runs on an unchanged project send byte-identical system and context.map', async () => {
          const first = await completeRun([{ text: 'hello' }], { prompt: 'First run' });
          const second = await completeRun([{ text: 'hello again' }], { prompt: 'Second run' });

          expect(first.requests).toHaveLength(1);
          expect(second.requests).toHaveLength(1);
          const [a] = first.requests;
          const [b] = second.requests;

          expect(a!.system).toBe(SYSTEM_PROMPT);
          expect(b!.system).toBe(a!.system);
          expect(a!.context).toBeDefined();
          expect(b!.context!.map).toBe(a!.context!.map);
          expect(b!.context!.excerpts).toBe('');
          // Nothing run-specific sits before the conversation.
          for (const run of [first.run, second.run]) {
            expect(a!.system + a!.context!.map).not.toContain(run.id);
          }
          // The conversation differs — it is the only block that may.
          expect(b!.messages).not.toEqual(a!.messages);
        });

        it('FR-014: the usage event and the run row carry cache read and write tokens', async () => {
          const usage = {
            cacheReadTokens: 40,
            cacheWriteTokens: 60,
            inputTokens: 100,
            outputTokens: 10,
          };
          const { run } = await completeRun([{ text: 'hello', usage }]);

          expect(await eventsOf(run.id, 'usage')).toEqual([
            expect.objectContaining({ cacheReadTokens: 40, cacheWriteTokens: 60 }),
          ]);
          expect(run.cacheReadTokens).toBe(40);
          expect(run.cacheWriteTokens).toBe(60);
        });
      });
    },
  );
});
