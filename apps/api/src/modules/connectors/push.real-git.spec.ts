import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConfigService } from '@nestjs/config';
import type { Checkpoint } from '@repo/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeClock } from '../../common/clock/fake-clock';
import { plaintext } from '../../common/crypto/branded';
import type { Environment } from '../../config/environment';
import type { TenantTransaction } from '../../database/database.types';
import type { TenantTransactionRunner } from '../../database/tenant-transaction';
import type { CheckpointService } from '../checkpoints/checkpoint.service';
import type { RepoBundler } from '../checkpoints/repo-bundler';
import { RetryableFailure } from '../outbox/consumer';
import type { Envelope } from '../outbox/envelope';
import type { OutboxWriter } from '../outbox/outbox-writer';
import type { ConnectionService } from './connection.service';
import { syncConflict } from './connectors.errors';
import { GithubApiError, type GithubAppClient } from './github-app.client';
import { LocalGit, type RunOptions, type RunResult } from './local-git';
import { type PullRunner, SyncConsumer } from './push.consumer';
import type { RepoLinkRecord, RepoLinkRepository } from './repo-link.repository';
import { SIDE_BRANCH } from './sync-guards';
import type { SyncRecord, SyncRepository } from './sync.repository';
import { SyncService } from './sync.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const USER = '66666666-6666-4666-8666-666666666666';
const REF = { orgId: ORG, projectId: PROJECT };
const TX = { execute: () => Promise.resolve() } as unknown as TenantTransaction;
const COMMIT = ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty'];

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });

    return true;
  } catch {
    console.log('SKIPPING push.real-git: no git on PATH');

    return false;
  }
}

/** The real thing, its remote a bare repository on disk, every argv kept. */
class RecordingGit extends LocalGit {
  readonly argv: string[][] = [];
  /** What lands between the check and the push: runs once, before the next `git push`. */
  beforePush: (() => void) | undefined;
  remotes: { name: string; owner: string }[] = [];

  constructor(private readonly bare: string) {
    super({ get: () => 'https://github.com/' } as unknown as ConfigService<Environment, true>, {
      now: () => new Date(),
    });
  }

  override remoteUrl(owner: string, name: string): string {
    this.remotes.push({ name, owner });

    return this.bare;
  }

  override run(args: readonly string[], options: RunOptions): Promise<RunResult> {
    this.argv.push([...args]);

    if (args[0] === 'push' && this.beforePush !== undefined) {
      const hook = this.beforePush;

      this.beforePush = undefined;
      hook();
    }

    return super.run(args, options);
  }
}

/**
 * Spec 044 decisions 3, 4 and 10, with no mock of git: the real `SyncConsumer` and `SyncService`
 * over real `LocalGit` against a bare repository, the source a real bundle; only the rows are in
 * memory, because what is on trial is what lands on the remote.
 */
describe.skipIf(!hasGit())('SyncConsumer (real git)', () => {
  let scratch: string;
  let bare: string;
  let work: string;
  let other: string;
  let localGit: RecordingGit;
  let consumer: SyncConsumer;
  let syncs: SyncService;
  let link: RepoLinkRecord;
  let rows: SyncRecord[];
  let checkpoints: Checkpoint[];
  let repository: () => Promise<unknown>;
  let token: () => Promise<unknown>;

  const head = () => checkpoints.at(-1)!;

  /** One more commit in the project, and its checkpoint. */
  function checkpoint(): string {
    git(work, ...COMMIT, '-m', `c${String(checkpoints.length)}`);
    const gitSha = git(work, 'rev-parse', 'HEAD');

    checkpoints.push({ gitSha, id: `cp-${gitSha}` } as Checkpoint);

    return gitSha;
  }

  /** Someone else's commit, straight onto a branch of the remote. */
  function remoteCommit(branch: string): string {
    git(other, 'fetch', '-q', 'origin');
    git(other, 'checkout', '-q', '-B', branch, `origin/${branch}`);
    git(other, ...COMMIT, '-m', 'from github');
    git(other, 'push', '-q', 'origin', branch);

    return git(other, 'rev-parse', 'HEAD');
  }

  const remote = (ref: string): string | null => {
    try {
      return git(bare, 'rev-parse', '--verify', '-q', `refs/heads/${ref}`);
    } catch {
      return null;
    }
  };

  function eventFor(id: string): Envelope<'sync.requested'> {
    return {
      payload: { orgId: ORG, projectId: PROJECT, syncOperationId: id },
    } as Envelope<'sync.requested'>;
  }

  async function drive(id: string, attempt = 1): Promise<SyncRecord> {
    const event = eventFor(id);

    await consumer.effect(event, await consumer.handle(event, TX), attempt);

    return rows.find((row) => row.id === id)!;
  }

  /** The operation the request made, carried through to its close. */
  async function push(trigger: 'auto' | 'manual' = 'auto'): Promise<SyncRecord> {
    const requested = await syncs.requestPush(TX, REF, { actorId: USER, trigger });

    return drive(requested!.id);
  }

  /** A protected branch as GitHub spells it, from a real `pre-receive`. */
  function protect(branch: string): void {
    const hook = join(bare, 'hooks', 'pre-receive');

    writeFileSync(
      hook,
      [
        '#!/bin/sh',
        'while read old new ref; do',
        `  if [ "$ref" = "refs/heads/${branch}" ]; then`,
        '    echo "error: GH006: Protected branch update failed for $ref." >&2',
        '    echo "error: Changes must be made through a pull request." >&2',
        '    exit 1',
        '  fi',
        'done',
        '',
      ].join('\n'),
    );
    chmodSync(hook, 0o755);
  }

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'push-real-git-'));
    bare = join(scratch, 'remote.git');
    work = join(scratch, 'work');
    other = join(scratch, 'other');
    git(scratch, 'init', '-q', '--bare', '-b', 'main', bare);
    git(scratch, 'init', '-q', '-b', 'main', work);
    git(scratch, 'clone', '-q', bare, other);

    localGit = new RecordingGit(bare);
    rows = [];
    checkpoints = [];
    repository = () => Promise.resolve({ name: 'site', owner: 'acme' });
    token = () => Promise.resolve(plaintext('ghs_test'));
    link = {
      autoSync: true,
      branch: 'main',
      id: 'link-1',
      lastPushedCheckpointId: null,
      linkedBy: USER,
      name: 'site',
      orgId: ORG,
      owner: 'acme',
      projectId: PROJECT,
      remoteHeadSha: null,
      repoId: 501,
      sideBranch: null,
      state: 'linked',
    } as RepoLinkRecord;

    const operations = {
      byId: (_tx: unknown, _org: string, id: string) =>
        Promise.resolve(rows.find((row) => row.id === id)),
      insertQueuedIfFree: (_tx: unknown, draft: Partial<SyncRecord>) => {
        if (rows.some((row) => row.state === 'queued' || row.state === 'running')) {
          return Promise.resolve(undefined);
        }

        const row = {
          commits: 0,
          createdAt: new Date(0),
          finishedAt: null,
          fromSha: null,
          id: `op-${String(rows.length + 1)}`,
          reason: null,
          requestedByName: 'owner@example.test',
          startedAt: null,
          state: 'queued',
          targetBranch: null,
          toSha: null,
          ...draft,
        } as SyncRecord;

        rows.push(row);

        return Promise.resolve(row);
      },
      latest: (_tx: unknown, _ref: unknown, _link: string, state?: string) =>
        Promise.resolve(rows.filter((row) => state === undefined || row.state === state).at(-1)),
      markDone: (_tx: unknown, _org: string, id: string, outcome: Partial<SyncRecord>) => {
        const index = rows.findIndex((row) => row.id === id && row.state === 'running');

        if (index === -1) return Promise.resolve(0);
        rows[index] = { ...rows[index]!, ...outcome };

        return Promise.resolve(1);
      },
      markRunning: (_tx: unknown, _org: string, id: string) => {
        const index = rows.findIndex((row) => row.id === id);

        rows[index] = { ...rows[index]!, state: 'running' };

        return Promise.resolve();
      },
    } as unknown as SyncRepository;
    const links = {
      forProject: () => Promise.resolve(link),
      setPushed: (_tx: unknown, _org: string, _id: string, id: string, remoteHeadSha: string) => {
        link = { ...link, lastPushedCheckpointId: id, remoteHeadSha };

        return Promise.resolve();
      },
      setRemoteHead: (_tx: unknown, _org: string, _id: string, remoteHeadSha: string | null) => {
        link = { ...link, remoteHeadSha };

        return Promise.resolve();
      },
      setRepository: (
        _tx: unknown,
        _org: string,
        _id: string,
        named: { name: string; owner: string },
      ) => {
        link = { ...link, name: named.name, owner: named.owner };

        return Promise.resolve();
      },
      setSideBranch: (_tx: unknown, _org: string, _id: string, sideBranch: string | null) => {
        link = { ...link, sideBranch };

        return Promise.resolve();
      },
    } as unknown as RepoLinkRepository;
    const checkpointService = {
      head: () => Promise.resolve(checkpoints.at(-1) ?? null),
      lockProject: () => Promise.resolve(),
    } as unknown as CheckpointService;
    const bundler = {
      current: () => {
        const path = join(scratch, `${String(Math.random()).slice(2)}.bundle`);

        git(work, 'bundle', 'create', '-q', path, '--all');

        return Promise.resolve({ body: readFileSync(path), head: head().gitSha });
      },
    } as unknown as RepoBundler;
    const connections = {
      ensureUsable: () => Promise.resolve(),
      repositoryToken: () => token(),
    } as unknown as ConnectionService;
    const github = { repository: () => repository() } as unknown as GithubAppClient;
    const transactions = {
      runInTenantScope: (_scope: unknown, fn: (tx: TenantTransaction) => Promise<unknown>) =>
        fn(TX),
      runInTenantTransaction: (_org: string, fn: (tx: TenantTransaction) => Promise<unknown>) =>
        fn(TX),
    } as unknown as TenantTransactionRunner;
    const outbox = { append: vi.fn(() => Promise.resolve()) } as unknown as OutboxWriter;

    syncs = new SyncService(
      operations,
      links,
      connections,
      checkpointService,
      outbox,
      transactions,
    );
    consumer = new SyncConsumer(
      operations,
      links,
      checkpointService,
      bundler,
      connections,
      localGit,
      transactions,
      new FakeClock('2026-11-04T10:00:00.000Z'),
      {} as PullRunner,
      {} as PullRunner,
      github,
      syncs,
    );
  });

  afterEach(() => {
    // Nothing in this suite, whichever arm it took, ever asked git to overwrite: SC "never force".
    const pushes = localGit.argv.filter((args) => args[0] === 'push');

    expect(localGit.argv.flat().filter((arg) => /^(--force|-f$|--mirror)/.test(arg))).toEqual([]);
    expect(pushes.flat().filter((arg) => arg.startsWith('+'))).toEqual([]);
    rmSync(scratch, { force: true, recursive: true });
  });

  it('first push: an empty remote takes the head on the linked branch', async () => {
    const sha = checkpoint();

    const row = await push();

    expect(row).toMatchObject({
      fromSha: null,
      reason: null,
      state: 'succeeded',
      targetBranch: 'main',
      toSha: sha,
      trigger: 'auto',
    });
    expect(remote('main')).toBe(sha);
    expect(link).toMatchObject({ lastPushedCheckpointId: `cp-${sha}`, remoteHeadSha: sha });
  });

  it('fast-forward: two more commits land on top, counted', async () => {
    const first = checkpoint();
    await push();
    checkpoint();
    const sha = checkpoint();

    const row = await push();

    expect(row).toMatchObject({ commits: 2, fromSha: first, state: 'succeeded', toSha: sha });
    expect(remote('main')).toBe(sha);
  });

  it('auto with the remote ahead: the linked branch is untouched, the head is on kido-sync', async () => {
    checkpoint();
    await push();
    const theirs = remoteCommit('main');
    const sha = checkpoint();

    const row = await push();

    expect(row).toMatchObject({
      commits: 1,
      fromSha: null,
      reason: null,
      state: 'succeeded',
      targetBranch: SIDE_BRANCH,
      toSha: sha,
    });
    expect(remote('main')).toBe(theirs);
    expect(remote(SIDE_BRANCH)).toBe(sha);
    // The link's pointer stays where the linked branch took it; only the side branch moved.
    expect(link).toMatchObject({
      lastPushedCheckpointId: expect.not.stringContaining(sha) as string,
      remoteHeadSha: theirs,
      sideBranch: SIDE_BRANCH,
    });
  });

  it('a later auto push fast-forwards the side branch, and a pushable linked branch clears it', async () => {
    checkpoint();
    await push();
    remoteCommit('main');
    const first = checkpoint();
    await push();
    const second = checkpoint();

    expect(await push()).toMatchObject({ commits: 1, fromSha: first, toSha: second });
    expect(remote(SIDE_BRANCH)).toBe(second);

    // GitHub's commit went back: `main` is an ancestor of the head again.
    const pushed = checkpoints[0]!.gitSha;

    git(bare, 'update-ref', 'refs/heads/main', pushed);
    const third = checkpoint();

    expect(await push()).toMatchObject({ state: 'succeeded', targetBranch: 'main', toSha: third });
    expect(link).toMatchObject({ lastPushedCheckpointId: `cp-${third}`, sideBranch: null });
  });

  it('a side branch that moved is diverged, and nothing is overwritten', async () => {
    checkpoint();
    await push();
    const main = remoteCommit('main');
    git(bare, 'update-ref', `refs/heads/${SIDE_BRANCH}`, main);
    const side = remoteCommit(SIDE_BRANCH);
    checkpoint();

    const row = await push();

    expect(row).toMatchObject({ reason: 'diverged', state: 'failed', targetBranch: null });
    expect(remote(SIDE_BRANCH)).toBe(side);
    expect(remote('main')).toBe(main);
    expect(link.sideBranch).toBeNull();
  });

  it('a commit landing between the check and the push: rejected, then the side branch', async () => {
    checkpoint();
    await push();
    const sha = checkpoint();
    let theirs: string | undefined;
    localGit.beforePush = () => {
      theirs = remoteCommit('main');
    };

    const row = await push();

    expect(row).toMatchObject({ state: 'succeeded', targetBranch: SIDE_BRANCH, toSha: sha });
    expect(remote('main')).toBe(theirs);
    expect(remote(SIDE_BRANCH)).toBe(sha);
    expect(link.remoteHeadSha).toBe(theirs);
  });

  it('protected branch: the GH006 refusal sends an auto push to the side branch', async () => {
    const first = checkpoint();
    await push();
    protect('main');
    const sha = checkpoint();

    const row = await push();

    expect(row).toMatchObject({ state: 'succeeded', targetBranch: SIDE_BRANCH, toSha: sha });
    expect(remote('main')).toBe(first);
    expect(remote(SIDE_BRANCH)).toBe(sha);
    expect(link.remoteHeadSha).toBe(first);
  });

  it('with auto-sync off a manual push keeps the refusal: remote-ahead and branch-protected, no side branch', async () => {
    link = { ...link, autoSync: false };

    const first = checkpoint();
    await push('manual');
    const theirs = remoteCommit('main');
    checkpoint();

    expect(await push('manual')).toMatchObject({ reason: 'remote-ahead', state: 'failed' });
    expect(remote('main')).toBe(theirs);

    git(bare, 'update-ref', 'refs/heads/main', first);
    protect('main');
    expect(await push('manual')).toMatchObject({ reason: 'branch-protected', state: 'failed' });
    expect(remote(SIDE_BRANCH)).toBeNull();
  });

  it('linked to kido-sync itself: no side push, the row closes with the reason', async () => {
    link = { ...link, branch: SIDE_BRANCH };
    checkpoint();
    await push();
    const theirs = remoteCommit(SIDE_BRANCH);
    checkpoint();

    expect(await push()).toMatchObject({ reason: 'remote-ahead', state: 'failed' });
    expect(remote(SIDE_BRANCH)).toBe(theirs);
    expect(localGit.argv.filter((args) => args[0] === 'push')).toHaveLength(1);
  });

  it('with auto-sync on, a person pushing into a conflict is as safe as a turn: it goes to the side', async () => {
    checkpoint();
    await push('manual');
    const theirs = remoteCommit('main');
    const head = checkpoint();

    expect(await push('manual')).toMatchObject({
      reason: null,
      state: 'succeeded',
      targetBranch: 'kido-sync',
      trigger: 'manual',
    });
    expect(remote('main')).toBe(theirs);
    expect(remote('kido-sync')).toBe(head);
  });

  it('decision 3: a head that moved during a push gets one follow-up, and then it stops', async () => {
    const first = checkpoint();
    let moved: string | undefined;
    localGit.beforePush = () => {
      moved = checkpoint();
    };

    const row = await push();

    expect(row).toMatchObject({ state: 'succeeded', toSha: first });
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ requestedBy: USER, state: 'queued', trigger: 'auto' });

    await drive(rows[1]!.id);

    expect(remote('main')).toBe(moved);
    // The chain ended by itself: its job found the head where it started.
    expect(rows).toHaveLength(2);
    expect(rows.every((operation) => operation.state === 'succeeded')).toBe(true);
  });

  it('no loop: a failed push with no newer checkpoint asks for nothing', async () => {
    checkpoint();
    await push();
    remoteCommit('main');
    git(bare, 'update-ref', `refs/heads/${SIDE_BRANCH}`, remote('main')!);
    remoteCommit(SIDE_BRANCH);
    checkpoint();

    expect(await push()).toMatchObject({ reason: 'diverged' });
    expect(rows).toHaveLength(2);
  });

  it('decision 3: a failure that repeats until a person acts stops the chain', async () => {
    checkpoint();
    const row = await syncs.requestPush(TX, REF, { actorId: USER, trigger: 'auto' });
    token = () => {
      checkpoint();

      return Promise.reject(syncConflict('needs-reauth', 'reconnect'));
    };

    expect(await drive(row!.id)).toMatchObject({ reason: 'needs-reauth', state: 'failed' });
    expect(rows).toHaveLength(1);
  });

  it('a manual link with auto-sync off: the settle asks for nothing', async () => {
    link = { ...link, autoSync: false };
    checkpoint();
    localGit.beforePush = () => {
      checkpoint();
    };

    await push('manual');

    expect(rows).toHaveLength(1);
  });

  it('decision 10: a renamed repository updates the link and pushes to the new name', async () => {
    const sha = checkpoint();
    repository = () => Promise.resolve({ name: 'renamed', owner: 'new-owner' });

    await push();

    expect(link).toMatchObject({ name: 'renamed', owner: 'new-owner' });
    expect(localGit.remotes).toEqual([{ name: 'renamed', owner: 'new-owner' }]);
    expect(remote('main')).toBe(sha);
  });

  it('decision 10: a 404 by id closes the row repo-gone with git never run', async () => {
    checkpoint();
    repository = () => Promise.reject(new GithubApiError('not-found', 404));

    expect(await push()).toMatchObject({ reason: 'repo-gone', state: 'failed' });
    expect(localGit.argv).toEqual([]);
  });

  it('a repository the mint itself cannot reach closes repo-gone', async () => {
    checkpoint();
    token = () => Promise.reject(syncConflict('repo-gone', 'gone'));

    expect(await push()).toMatchObject({ reason: 'repo-gone', state: 'failed' });
  });

  it.each([
    ['rate-limited', 429, 'throttled'],
    ['unavailable', 503, 'upstream-5xx'],
  ] as const)(
    'a %s resolve retries, then closes provider-unavailable',
    async (category, status, reason) => {
      checkpoint();
      repository = () => Promise.reject(new GithubApiError(category, status));
      const row = await syncs.requestPush(TX, REF, { actorId: USER, trigger: 'auto' });

      await expect(drive(row!.id, 1)).rejects.toMatchObject({ reason });
      await expect(drive(row!.id, 2)).rejects.toBeInstanceOf(RetryableFailure);
      expect(await drive(row!.id, 3)).toMatchObject({
        reason: 'provider-unavailable',
        state: 'failed',
      });
    },
  );
});
