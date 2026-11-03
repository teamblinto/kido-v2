import { schema } from '@repo/db';
import { eq } from 'drizzle-orm';
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
