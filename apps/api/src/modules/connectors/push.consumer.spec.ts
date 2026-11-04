import { schema } from '@repo/db';
import { and, eq, inArray } from 'drizzle-orm';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import {
  type ConnectorsHarness,
  startConnectorsHarness,
} from '../../../test/fixtures/connectors-harness';
import { MemoryObjectStore } from '../../common/object-store/memory-object-store';
import { OBJECT_STORE } from '../../common/object-store/object-store.port';
import { mirrorKey } from '../checkpoints/repo-bundler';
import type { Envelope } from '../outbox/envelope';
import { SANDBOX_LIFECYCLE } from '../sandbox/sandbox-lifecycle';
import { CheckpointService } from '../checkpoints/checkpoint.service';
import { AutoSyncConsumer } from './autosync.consumer';
import { RepoLinkRepository } from './repo-link.repository';
import { RepoLinkService } from './repo-link.service';
import { SyncConsumer } from './push.consumer';
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
  console.warn('SKIPPING push.consumer.spec.ts: Postgres, Redis or git on PATH is missing');
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
 * Spec 018 US2 against Postgres, the fixture GitHub and its `git http-backend`: the push consumer
 * driven by hand (`handle` on a tenant transaction, then `effect`), the source a real bundle in
 * the memory store labelled at the project's head — the steady state of R5 — and the remote a bare
 * repository the fixture serves only to the one-repository token.
 */
describe('SyncConsumer (push)', () => {
  describe.skipIf(!postgres || !redis || !gitOnPath)('against the fixture GitHub over git', () => {
    let harness: ConnectorsHarness;
    let consumer: SyncConsumer;
    let links: RepoLinkService;
    let syncs: SyncService;
    let work: string;
    let remoteDir: string;
    const store = new MemoryObjectStore();
    const ensureReady = vi.fn(() => Promise.reject(new Error('the sandbox was asked')));

    const ref = () => ({ orgId: harness.orgId, projectId: harness.projectId });

    /** `n` more commits on the working repository; the head is bundled, mirrored and checkpointed. */
    async function commit(n: number): Promise<string> {
      for (let i = 0; i < n; i++) {
        execFileSync('git', ['commit', '--quiet', '--allow-empty', '-m', `c${randomUUID()}`], {
          cwd: work,
          env: GIT_ENV,
        });
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

    /** `beforeEffect` runs between `handle` and `effect`, where another worker can move the row. */
    async function push(attempt = 1, beforeEffect?: () => Promise<unknown>) {
      const requested = await harness.inTenant((tx) =>
        syncs.request(tx, ref(), harness.userId, 'push'),
      );
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

    const remoteHead = () => git(remoteDir, 'rev-parse', 'refs/heads/main');
    const remoteBytes = () =>
      git(remoteDir, 'cat-file', '--batch-all-objects', '--batch-check', '--unordered');

    // Spec 044's first automatic push on link has its own suite; these drive operations by hand.
    // In `beforeEach`: the config's `restoreMocks` undoes a spy set once.
    beforeEach(() => {
      vi.spyOn(
        harness.moduleRef.get(SyncService, { strict: false }),
        'requestAuto',
      ).mockResolvedValue(null);
    });

    beforeAll(async () => {
      harness = await startConnectorsHarness({
        git: true,
        override: (builder) =>
          builder
            .overrideProvider(OBJECT_STORE)
            .useValue(store)
            .overrideProvider(SANDBOX_LIFECYCLE)
            .useValue({ ensureReady }),
      });
      consumer = harness.moduleRef.get(SyncConsumer, { strict: false });
      links = harness.moduleRef.get(RepoLinkService, { strict: false });
      syncs = harness.moduleRef.get(SyncService, { strict: false });
      // Ten minutes: the harness waits for the outbox suite lock behind every suite that relays.
    }, 600_000);

    afterAll(async () => {
      await harness.close();
      if (work !== undefined) await rm(work, { force: true, recursive: true });
    });

    beforeEach(async () => {
      await harness.reset();
      store.objects.clear();
      ensureReady.mockClear();
      // Checkpoints are append-only; each test's rows are newer, so the head is always its own.
      if (work !== undefined) await rm(work, { force: true, recursive: true });
      work = await mkdtemp(join(tmpdir(), 'forge-push-spec-'));
      git(work, 'init', '--quiet', '--initial-branch=main');

      await harness.connect();
      const link = await harness.inTenant((tx) =>
        links.link(tx, ref(), harness.userId, { create: { name: 'site', private: true } }),
      );
      expect(link.branch).toBe('main');
      remoteDir = await harness.fixture.initRepo({ full_name: 'acme/site' });
    });

    it('SC-004: fifty commits land on the remote with identical shas, under the one-repository token', async () => {
      const head = await commit(50);

      const operation = await push();

      expect(operation).toMatchObject({
        commits: 50,
        fromSha: null,
        reason: null,
        state: 'succeeded',
        toSha: head,
      });
      expect(remoteHead()).toBe(head);
      expect(git(remoteDir, 'rev-list', 'refs/heads/main')).toBe(git(work, 'rev-list', 'HEAD'));

      // The credential git carried is a token minted for this repository alone (R3), never argv.
      const gitRequests = harness.fixture.requests.filter((r) =>
        r.path.startsWith('/acme/site.git/'),
      );
      expect(gitRequests.length).toBeGreaterThan(0);
      const basic = gitRequests[0]!.authorization!.replace(/^Basic /, '');
      const [user, token] = Buffer.from(basic, 'base64').toString('utf8').split(':');
      expect(user).toBe('x-access-token');
      expect(harness.fixture.tokens.get(token!)?.repositoryIds).toEqual([link().repoId]);

      const stored = await harness.inTenant((tx) => links.read(tx, ref()));
      expect(stored).toMatchObject({ position: 'level', remoteHeadSha: head });
    });

    describe('spec 044: every turn lands on GitHub', () => {
      const autoSync = () => harness.moduleRef.get(AutoSyncConsumer, { strict: false });

      /** What the outbox delivers for the head checkpoint; ours inserts rows directly. */
      async function checkpointCreated(): Promise<void> {
        const head = await harness.inTenant((tx) =>
          harness.moduleRef.get(CheckpointService, { strict: false }).head(tx, ref()),
        );
        const event: Envelope<'checkpoint.created'> = {
          aggregate: 'checkpoint',
          aggregateId: head!.id,
          eventId: randomUUID(),
          occurredAt: new Date().toISOString(),
          orgId: harness.orgId,
          payload: { checkpointId: head!.id, orgId: harness.orgId, projectId: harness.projectId },
          traceId: null,
          type: 'checkpoint.created',
        };

        await harness.inTenant((tx) => autoSync().handle(event, tx));
      }

      const open = () =>
        harness.inTenant((tx) =>
          tx
            .select()
            .from(schema.syncOperations)
            .where(
              and(
                eq(schema.syncOperations.orgId, harness.orgId),
                inArray(schema.syncOperations.state, ['queued', 'running']),
              ),
            ),
        );

      function requested(id: string): Envelope<'sync.requested'> {
        return {
          aggregate: 'sync-operation',
          aggregateId: id,
          eventId: randomUUID(),
          occurredAt: new Date().toISOString(),
          orgId: harness.orgId,
          payload: {
            orgId: harness.orgId,
            projectId: harness.projectId,
            syncOperationId: id,
          },
          traceId: null,
          type: 'sync.requested',
        };
      }

      async function drain(id: string): Promise<void> {
        const event = requested(id);
        const job = await harness.inTenant((tx) => consumer.handle(event, tx));

        await consumer.effect(event, job, 1);
      }

      beforeEach(() => {
        vi.spyOn(syncs, 'requestAuto').mockRestore();
      });

      it('a finished turn reaches GitHub with no click, marked automatic', async () => {
        const head = await commit(1);

        await checkpointCreated();

        const [operation] = await open();

        expect(operation).toMatchObject({ kind: 'push', trigger: 'auto' });
        await drain(operation!.id);

        expect(remoteHead()).toBe(head);
        await expect(
          harness.inTenant((tx) => syncs.byId(tx, ref(), operation!.id)),
        ).resolves.toMatchObject({ state: 'succeeded', targetBranch: 'main', toSha: head });
        expect(await open()).toEqual([]);
      });

      it('two turns during one push: the slot holds, and both reach GitHub', async () => {
        await commit(1);
        await checkpointCreated();

        const [first] = await open();
        const event = requested(first!.id);
        const job = await harness.inTenant((tx) => consumer.handle(event, tx));

        // The second turn lands while the first push is running.
        const second = await commit(1);

        await checkpointCreated();
        expect(await open()).toHaveLength(1);

        await consumer.effect(event, job, 1);

        // The trailing edge queued exactly one more, and it ends the chain.
        const [trailing] = await open();

        expect(trailing).toMatchObject({ trigger: 'auto' });
        expect(trailing!.id).not.toBe(first!.id);
        await drain(trailing!.id);
        expect(remoteHead()).toBe(second);
        expect(await open()).toEqual([]);
      });

      it('a deferred delivery of our own earlier push is recognised as behind', async () => {
        const repository = harness.moduleRef.get(RepoLinkRepository, { strict: false });
        const behind = (sha: string) =>
          harness.inTenant((tx) =>
            repository.isBehindPushed(tx, harness.orgId, harness.projectId, sha),
          );

        const first = await commit(1);

        await checkpointCreated();
        await drain((await open())[0]!.id);

        const second = await commit(1);

        await checkpointCreated();
        await drain((await open())[0]!.id);

        await expect(behind(first)).resolves.toBe(true);
        await expect(behind(second)).resolves.toBe(false);
        // A commit someone made on GitHub is not ours to discount.
        await expect(behind('f'.repeat(40))).resolves.toBe(false);
      });

      it('a checkpoint on a link with auto-sync off asks for nothing', async () => {
        await commit(1);
        await harness.inTenant((tx) =>
          tx
            .update(schema.repoLinks)
            .set({ autoSync: false })
            .where(eq(schema.repoLinks.orgId, harness.orgId)),
        );

        await checkpointCreated();

        expect(await open()).toEqual([]);
      });
    });

    it('two more commits after a push: the second push carries commits: 2', async () => {
      const first = await commit(3);
      await push();
      const second = await commit(2);

      const operation = await push();

      expect(operation).toMatchObject({
        commits: 2,
        fromSha: first,
        state: 'succeeded',
        toSha: second,
      });
      expect(remoteHead()).toBe(second);
    });

    it('SC-012: a relinked level project pushes succeeded with commits 0 and the remote unchanged', async () => {
      const head = await commit(3);
      await push();
      const before = remoteBytes();

      await harness.inTenant((tx) => links.unlink(tx, ref(), harness.userId));
      const relinked = await harness.inTenant((tx) =>
        links.link(tx, ref(), harness.userId, { existing: { branch: 'main', ...link() } }),
      );
      expect(relinked).toMatchObject({ position: 'level', remoteHeadSha: head });
      expect(relinked.lastPushedCheckpointId).not.toBeNull();

      const operation = await push();

      expect(operation).toMatchObject({
        commits: 0,
        fromSha: head,
        reason: null,
        state: 'succeeded',
        toSha: head,
      });
      expect(remoteHead()).toBe(head);
      expect(remoteBytes()).toBe(before);
      expect(git(remoteDir, 'rev-list', '--count', 'refs/heads/main')).toBe('3');
    });

    it('SC-005: a remote that moved ahead is refused as remote-ahead and left byte-for-byte unchanged', async () => {
      // Spec 044: this is the refusal a person gets with auto-sync off; on, the head goes to the side.
      await harness.inTenant((tx) =>
        tx
          .update(schema.repoLinks)
          .set({ autoSync: false })
          .where(eq(schema.repoLinks.orgId, harness.orgId)),
      );
      await commit(2);
      await push();
      // Someone else pushes to the remote; our head is now behind it.
      const other = await mkdtemp(join(tmpdir(), 'forge-push-other-'));
      git(other, 'clone', '--quiet', remoteDir, 'clone');
      execFileSync('git', ['commit', '--quiet', '--allow-empty', '-m', 'theirs'], {
        cwd: join(other, 'clone'),
        env: GIT_ENV,
      });
      git(join(other, 'clone'), 'push', '--quiet', 'origin', 'HEAD:main');
      await rm(other, { force: true, recursive: true });
      const theirs = remoteHead();
      const before = remoteBytes();
      await commit(1);

      const operation = await push();

      expect(operation).toMatchObject({ commits: 0, reason: 'remote-ahead', state: 'failed' });
      expect(remoteHead()).toBe(theirs);
      expect(remoteBytes()).toBe(before);
      expect(await harness.inTenant((tx) => links.read(tx, ref()))).toMatchObject({
        position: 'diverged',
        remoteHeadSha: theirs,
      });
    });

    it('SC-006: a hibernated project with a current mirror pushes without waking the sandbox', async () => {
      await commit(1);

      const operation = await push();

      expect(operation.state).toBe('succeeded');
      expect(ensureReady).not.toHaveBeenCalled();
    });

    it('an unauthorized mint closes the operation as needs-reauth, moves health and audits it', async () => {
      await commit(1);
      harness.fixture.installations.clear();

      const operation = await push();

      expect(operation).toMatchObject({ reason: 'needs-reauth', state: 'failed' });
      const [connection] = await harness.inTenant((tx) => tx.select().from(schema.connections));
      expect(connection?.health).toBe('needs_reauth');
      expect(await harness.auditActions()).toContain('connector.health-changed');
      expect(git(remoteDir, 'rev-list', '--all', '--count')).toBe('0');
    });

    it('a transient failure retries, and closes as provider-unavailable on the last attempt', async () => {
      await commit(1);
      harness.fixture.override.status = 503;
      await expect(push()).rejects.toMatchObject({ name: 'RetryableFailure' });

      await harness.reset();
      await harness.connect();
      await harness.inTenant((tx) =>
        links.link(tx, ref(), harness.userId, { create: { name: 'site', private: true } }),
      );
      harness.fixture.override.status = 503;
      const operation = await push(consumer.attempts);

      expect(operation).toMatchObject({ reason: 'provider-unavailable', state: 'failed' });
    });

    it('a row the sweep closed as timed-out while the push ran stays closed, and the link is left alone', async () => {
      await commit(2);
      const before = await harness.inTenant((tx) => links.read(tx, ref()));

      const operation = await push(1, () =>
        harness.inTenant((tx) =>
          tx
            .update(schema.syncOperations)
            .set({ finishedAt: new Date(), reason: 'timed-out', state: 'failed' })
            .where(eq(schema.syncOperations.orgId, harness.orgId)),
        ),
      );

      expect(operation).toMatchObject({ reason: 'timed-out', state: 'failed' });
      expect(await harness.inTenant((tx) => links.read(tx, ref()))).toEqual(before);
    });

    function link(): { repoId: number } {
      const repository = [...harness.fixture.repositories.values()].find(
        (candidate) => candidate.full_name === 'acme/site',
      );

      return { repoId: repository!.id };
    }
  });
});
