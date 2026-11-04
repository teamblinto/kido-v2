import { schema } from '@repo/db';
import { and, eq, gt } from 'drizzle-orm';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import {
  type ConnectorsHarness,
  startConnectorsHarness,
} from '../../../test/fixtures/connectors-harness';
import { MemoryObjectStore } from '../../common/object-store/memory-object-store';
import { OBJECT_STORE } from '../../common/object-store/object-store.port';
import { CheckpointService } from '../checkpoints/checkpoint.service';
import { mirrorKey } from '../checkpoints/repo-bundler';
import type { Envelope } from '../outbox/envelope';
import { type Readiness, SANDBOX_LIFECYCLE } from '../sandbox/sandbox-lifecycle';
import { type ExecResult, SANDBOX_PORT } from '../sandbox/sandbox.port';
import { SyncConsumer } from './push.consumer';
import { RepoLinkService } from './repo-link.service';
import { SyncService } from './sync.service';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

let gitOnPath = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  gitOnPath = false;
}

if (!postgres || !redis || !gitOnPath) {
  console.warn('SKIPPING pull.consumer.spec.ts: Postgres, Redis or git on PATH is missing');
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_DATE: '2026-09-17T10:00:00Z',
  GIT_AUTHOR_EMAIL: 'forge@example.test',
  GIT_AUTHOR_NAME: 'forge',
  GIT_COMMITTER_DATE: '2026-09-17T10:00:00Z',
  GIT_COMMITTER_EMAIL: 'forge@example.test',
  GIT_COMMITTER_NAME: 'forge',
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim();

/**
 * The sandbox side as a real git repository on disk: `exec` runs the pull's commands (each one
 * string of `git-commands.ts`, no quoting) in the workspace, `upload` writes the bundle there.
 * `failOn` makes one command fail — how the FR-028 cases cut the pull between two steps.
 */
class DiskSandbox {
  dir = '';
  failOn: string | null = null;
  readonly commands: string[] = [];

  exec(_ref: unknown, command: string): Promise<ExecResult> {
    this.commands.push(command);
    if (this.failOn !== null && command.startsWith(this.failOn)) {
      return Promise.resolve({
        exitCode: 128,
        output: 'fatal: cut here\n',
        timedOut: false,
        truncated: false,
      });
    }
    const [program, ...args] = command.split(' ') as [string, ...string[]];
    if (program === 'rm') {
      return rm(join(this.dir, args.at(-1)!), { force: true }).then(() => ({
        exitCode: 0,
        output: '',
        timedOut: false,
        truncated: false,
      }));
    }
    const ran = spawnSync(program, args, { cwd: this.dir, encoding: 'utf8', env: GIT_ENV });

    return Promise.resolve({
      exitCode: ran.status ?? 1,
      output: `${ran.stdout}${ran.stderr}`,
      timedOut: false,
      truncated: false,
    });
  }

  async upload(_ref: unknown, path: string, body: Buffer): Promise<void> {
    await writeFile(join(this.dir, path), body);
  }
}

/**
 * Spec 018 US3 against Postgres, the fixture GitHub and its `git http-backend`: the pull runner
 * driven through `SyncConsumer` by hand, the R5 bundle in the memory store labelled at the
 * project's head, the workspace a real repository on disk, and the remote a bare repository the
 * fixture serves only to the one-repository token.
 */
describe('SyncConsumer (pull)', () => {
  describe.skipIf(!postgres || !redis || !gitOnPath)('against the fixture GitHub over git', () => {
    let harness: ConnectorsHarness;
    let consumer: SyncConsumer;
    let checkpoints: CheckpointService;
    let links: RepoLinkService;
    let syncs: SyncService;
    let work: string;
    let remoteDir: string;
    let other: string;
    const store = new MemoryObjectStore();
    const sandbox = new DiskSandbox();
    const ensureReady = vi.fn((): Promise<Readiness> => Promise.resolve({ ready: true }));

    const ref = () => ({ orgId: harness.orgId, projectId: harness.projectId });

    /** `n` commits in the workspace; its head is bundled, mirrored and the head checkpoint. */
    async function commit(n: number): Promise<string> {
      for (let i = 0; i < n; i++) {
        await writeFile(join(work, `local-${randomUUID()}.txt`), 'ours\n');
        git(work, 'add', '-A');
        git(work, 'commit', '--quiet', '-m', `local ${String(i)}`);
      }
      const head = git(work, 'rev-parse', 'HEAD');
      git(work, 'bundle', 'create', join(work, '.git', 'forge-mirror.bundle'), '--all');
      await store.put(
        mirrorKey(harness.orgId, harness.projectId),
        await readFile(join(work, '.git', 'forge-mirror.bundle')),
        { head },
      );
      await harness.inTenant((tx) =>
        tx.insert(schema.checkpoints).values({
          files: [],
          gitSha: head,
          kind: 'baseline',
          label: `head ${head.slice(0, 7)}`,
          orgId: harness.orgId,
          projectId: harness.projectId,
        }),
      );

      return head;
    }

    /** `n` commits on the remote made by someone else, each adding a file; the new shas oldest first. */
    async function remoteCommits(n: number, ...pushArgs: string[]): Promise<string[]> {
      const before = git(other, 'rev-parse', 'HEAD');
      for (let i = 0; i < n; i++) {
        await writeFile(join(other, `theirs-${randomUUID()}.txt`), 'theirs\n');
        git(other, 'add', '-A');
        git(other, 'commit', '--quiet', '-m', `theirs ${String(i)}`);
      }
      git(other, 'push', '--quiet', ...pushArgs, 'origin', 'HEAD:main');

      return git(other, 'rev-list', '--reverse', `${before}..HEAD`).split('\n');
    }

    /** A retry (`attempt > 1`) is the same job on the same operation, as the queue replays it. */
    let last: { id: string } | undefined;
    /** `beforeEffect` runs between `handle` and `effect`: the window where another worker can move things. */
    async function pull(
      attempt = 1,
      between?: () => Promise<unknown>,
      beforeEffect?: () => Promise<unknown>,
    ) {
      const requested =
        attempt > 1
          ? last!
          : await harness.inTenant((tx) => syncs.request(tx, ref(), harness.userId, 'pull'));
      last = requested;
      await between?.();
      const event: Envelope<'sync.requested'> = {
        aggregate: 'sync-operation',
        aggregateId: requested.id,
        eventId: randomUUID(),
        occurredAt: new Date().toISOString(),
        orgId: harness.orgId,
        payload: {
          orgId: harness.orgId,
          projectId: harness.projectId,
          syncOperationId: requested.id,
        },
        traceId: null,
        type: 'sync.requested',
      };
      const job = await harness.inTenant((tx) => consumer.handle(event, tx));
      await beforeEffect?.();
      await consumer.effect(event, job, attempt);

      return harness.inTenant((tx) => syncs.byId(tx, ref(), requested.id));
    }

    /** Checkpoints are append-only: the pull rows of this test are the ones since it began. */
    let started: Date;
    const pullRows = () =>
      harness.inTenant((tx) =>
        tx
          .select({
            gitSha: schema.checkpoints.gitSha,
            syncOperationId: schema.checkpoints.syncOperationId,
          })
          .from(schema.checkpoints)
          .where(
            and(eq(schema.checkpoints.kind, 'pull'), gt(schema.checkpoints.createdAt, started)),
          ),
      );
    const workspaceHead = () => git(work, 'rev-parse', 'HEAD');
    const workspaceFiles = () => git(work, 'ls-files');

    beforeAll(async () => {
      harness = await startConnectorsHarness({
        git: true,
        override: (builder) =>
          builder
            .overrideProvider(OBJECT_STORE)
            .useValue(store)
            .overrideProvider(SANDBOX_PORT)
            .useValue(sandbox)
            .overrideProvider(SANDBOX_LIFECYCLE)
            .useValue({ ensureReady }),
      });
      consumer = harness.moduleRef.get(SyncConsumer, { strict: false });
      checkpoints = harness.moduleRef.get(CheckpointService, { strict: false });
      links = harness.moduleRef.get(RepoLinkService, { strict: false });
      syncs = harness.moduleRef.get(SyncService, { strict: false });
      // Ten minutes: the harness waits for the outbox suite lock behind every suite that relays.
    }, 600_000);

    afterAll(async () => {
      await harness.close();
      for (const dir of [work, other]) {
        if (dir !== undefined) await rm(dir, { force: true, recursive: true });
      }
    });

    beforeEach(async () => {
      await harness.reset();
      started = new Date();
      store.objects.clear();
      ensureReady.mockClear();
      ensureReady.mockResolvedValue({ ready: true });
      sandbox.failOn = null;
      sandbox.commands.length = 0;
      vi.restoreAllMocks();
      // Spec 044's first automatic push on link has its own suite; these drive operations by hand.
      vi.spyOn(
        harness.moduleRef.get(SyncService, { strict: false }),
        'requestAuto',
      ).mockResolvedValue(null);
      for (const dir of [work, other]) {
        if (dir !== undefined) await rm(dir, { force: true, recursive: true });
      }
      work = await mkdtemp(join(tmpdir(), 'forge-pull-spec-'));
      sandbox.dir = work;
      git(work, 'init', '--quiet', '--initial-branch=main');

      await harness.connect();
      await harness.inTenant((tx) =>
        links.link(tx, ref(), harness.userId, { create: { name: 'site', private: true } }),
      );
      remoteDir = await harness.fixture.initRepo({ full_name: 'acme/site' });
      // The workspace's head is on the remote (a previous push); "someone else" clones it.
      await commit(2);
      git(work, 'push', '--quiet', remoteDir, 'HEAD:refs/heads/main');
      other = join(await mkdtemp(join(tmpdir(), 'forge-pull-other-')), 'clone');
      git(tmpdir(), 'clone', '--quiet', remoteDir, other);
      git(other, 'checkout', '--quiet', 'main');
    });

    it('SC-007: five remote commits become five pull checkpoints with the remote shas, and the workspace is at the remote head', async () => {
      const head = workspaceHead();
      const theirs = await remoteCommits(5);

      const operation = await pull();

      expect(operation).toMatchObject({
        commits: 5,
        fromSha: head,
        reason: null,
        state: 'succeeded',
        toSha: theirs.at(-1),
      });
      const rows = await pullRows();
      expect(rows.map((row) => row.gitSha).sort()).toEqual([...theirs].sort());
      expect(rows.every((row) => row.syncOperationId === operation.id)).toBe(true);
      expect(workspaceHead()).toBe(theirs.at(-1));
      expect(workspaceFiles()).toBe(git(other, 'ls-files'));
      expect(await harness.inTenant((tx) => links.read(tx, ref()))).toMatchObject({
        position: 'level',
        remoteHeadSha: theirs.at(-1),
      });
      expect(await readFile(join(work, '.git', 'forge-pull.bundle')).catch(() => null)).toBeNull();
      expect(ensureReady).toHaveBeenCalledTimes(1);
    });

    it('SC-008: diverged histories are refused as diverged, with zero rows and the workspace unchanged', async () => {
      const [theirs] = await remoteCommits(1);
      const head = await commit(1);

      const operation = await pull();

      expect(operation).toMatchObject({ commits: 0, reason: 'diverged', state: 'failed' });
      expect(await pullRows()).toEqual([]);
      expect(workspaceHead()).toBe(head);
      expect(sandbox.commands).toEqual([]);
      expect(await harness.inTenant((tx) => links.read(tx, ref()))).toMatchObject({
        position: 'diverged',
        remoteHeadSha: theirs,
      });
    });

    it('a force-pushed remote that dropped our head is diverged', async () => {
      git(other, 'reset', '--quiet', '--hard', 'HEAD~1');
      await remoteCommits(1, '--force');

      const operation = await pull();

      expect(operation).toMatchObject({ reason: 'diverged', state: 'failed' });
      expect(await pullRows()).toEqual([]);
    });

    it('a remote at our head succeeds with commits: 0 and touches no sandbox', async () => {
      const head = workspaceHead();

      const operation = await pull();

      expect(operation).toMatchObject({ commits: 0, state: 'succeeded', toSha: head });
      expect(ensureReady).not.toHaveBeenCalled();
      expect(sandbox.commands).toEqual([]);
    });

    it('FR-028: a failure after the upload and before the merge leaves the workspace at its head with zero rows', async () => {
      const head = workspaceHead();
      await remoteCommits(3);
      sandbox.failOn = 'git merge';

      const operation = await pull();

      expect(operation).toMatchObject({ reason: 'git-failed', state: 'failed' });
      expect(workspaceHead()).toBe(head);
      expect(await pullRows()).toEqual([]);
    });

    it('a failure after the merge and before the rows: the retry lands the same rows once', async () => {
      const theirs = await remoteCommits(4);
      vi.spyOn(checkpoints, 'recordPulled').mockRejectedValueOnce(
        new Error('the connection dropped after the merge'),
      );

      await expect(pull()).rejects.toThrow('the connection dropped');
      expect(workspaceHead()).toBe(theirs.at(-1));
      expect(await pullRows()).toEqual([]);

      const operation = await pull(2);

      expect(operation).toMatchObject({ commits: 4, state: 'succeeded', toSha: theirs.at(-1) });
      expect((await pullRows()).map((row) => row.gitSha).sort()).toEqual([...theirs].sort());
    });

    it('a sandbox that is not ready retries, and closes as timed-out on the last attempt', async () => {
      await remoteCommits(1);
      ensureReady.mockResolvedValue({ because: 'resuming', ready: false });

      await expect(pull()).rejects.toMatchObject({ name: 'RetryableFailure', reason: 'timeout' });

      const operation = await pull(consumer.attempts);
      expect(operation).toMatchObject({ reason: 'timed-out', state: 'failed' });
      expect(await pullRows()).toEqual([]);
    });

    it('a run that started after the request refuses the pull as run-active before anything moves', async () => {
      await remoteCommits(1);

      const operation = await pull(1, () =>
        harness.inTenant((tx) =>
          tx.insert(schema.agentRuns).values({
            model: 'test',
            orgId: harness.orgId,
            projectId: harness.projectId,
            status: 'running',
            userId: harness.userId,
          }),
        ),
      );

      expect(operation).toMatchObject({ reason: 'run-active', state: 'failed' });
      expect(sandbox.commands).toEqual([]);
    });

    it('a run that starts between handle and the merge refuses the pull as run-active with the workspace at its head', async () => {
      const head = workspaceHead();
      await remoteCommits(2);

      const operation = await pull(1, undefined, () =>
        harness.inTenant((tx) =>
          tx.insert(schema.agentRuns).values({
            model: 'test',
            orgId: harness.orgId,
            projectId: harness.projectId,
            status: 'running',
            userId: harness.userId,
          }),
        ),
      );

      expect(operation).toMatchObject({ reason: 'run-active', state: 'failed' });
      expect(workspaceHead()).toBe(head);
      expect(await pullRows()).toEqual([]);
      expect(sandbox.commands.some((command) => command.startsWith('git merge'))).toBe(false);
    });

    it('FR-028: a failed bundle removal after the merge still yields the pull rows', async () => {
      const theirs = await remoteCommits(3);
      sandbox.failOn = 'rm';

      const operation = await pull();

      expect(operation).toMatchObject({ commits: 3, state: 'succeeded', toSha: theirs.at(-1) });
      expect((await pullRows()).map((row) => row.gitSha).sort()).toEqual([...theirs].sort());
      expect(workspaceHead()).toBe(theirs.at(-1));
    });

    it('a row the sweep closed as timed-out while the merge ran stays closed, and the link is left alone', async () => {
      const head = workspaceHead();
      await remoteCommits(2);
      const before = await harness.inTenant((tx) => links.read(tx, ref()));

      const operation = await pull(1, undefined, () =>
        harness.inTenant((tx) =>
          tx
            .update(schema.syncOperations)
            .set({ finishedAt: new Date(), reason: 'timed-out', state: 'failed' })
            .where(eq(schema.syncOperations.id, last!.id)),
        ),
      );

      expect(operation).toMatchObject({ reason: 'timed-out', state: 'failed' });
      expect(await harness.inTenant((tx) => links.read(tx, ref()))).toEqual(before);
      // The merge itself landed: the retry (if any) finds the workspace there, as FR-028 says.
      expect(workspaceHead()).not.toBe(head);
    });
  });
});
