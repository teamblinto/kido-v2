import type { Checkpoint, NewCheckpoint } from '@repo/db';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExecuteHandler, WorkspaceEntry } from '../../../test/support/fake-daytona';
import { fakeGit, type FakeGit } from '../../../test/support/fake-git';
import { FakeClock } from '../../common/clock/fake-clock';
import { DomainError } from '../../common/errors/domain-error';
import type { TenantTransaction } from '../../database/database.types';
import type { AuditEntry, AuditService } from '../audit/audit.service';
import type { OutboxWriter } from '../outbox/outbox-writer';
import { DaytonaError } from '../sandbox/sandbox.errors';
import type { MutationContext, SandboxPort } from '../sandbox/sandbox.port';
import type { SandboxLifecycle } from '../sandbox/sandbox-lifecycle';
import type { CheckpointRepository } from './checkpoint.repository';
import { CheckpointService } from './checkpoint.service';
import {
  gitAdd,
  gitCommit,
  gitDiffQuiet,
  gitDiffTree,
  gitGitDir,
  gitInit,
  gitLogSubject,
  gitLsTree,
  gitReadTree,
  gitRevParse,
  gitStatus,
} from './git-commands';

const WORK_DIR = '/home/daytona';
const CTX: MutationContext = { leaseEpoch: 1, operationId: 'run-1/step-1' };
const orgId = randomUUID();
const projectId = randomUUID();
const ref = { orgId, projectId };
const tx = {} as TenantTransaction;

/**
 * The service over `fake-git` (the real sequence, the real parsers) and an in-memory stand-in for
 * the repository — what `checkpoint.repository.spec.ts` proves against Postgres is assumed here.
 */
describe('CheckpointService', () => {
  let git: FakeGit;
  let workspace: Map<string, WorkspaceEntry>;
  let rows: Checkpoint[];
  let events: unknown[];
  /** The order of the lock, the row reads and the git steps: the lock must come first. */
  let trace: string[];
  let audits: AuditEntry[];
  /** Every path `port.read` was asked for, and every edit `port.edit` applied. */
  let portReads: string[];
  let portEdits: { content: string; path: string }[];
  let activeRun: boolean;
  let execFailure: Error | undefined;
  let truncateAt: number | undefined;
  let insertFailure: Error | undefined;
  let readiness: Awaited<ReturnType<SandboxLifecycle['ensureReady']>>;
  let template: { snapshot: string | null; template: string | null } | null;
  let service: CheckpointService;
  let handler: ExecuteHandler;
  let ensureReady: ReturnType<typeof vi.fn>;
  const clock = new FakeClock('2026-09-17T10:00:00.000Z');

  const fileAt = (path: string): string | undefined => {
    const entry = workspace.get(`${WORK_DIR}/${path}`);
    return entry?.kind === 'file' ? entry.content.toString('utf8') : undefined;
  };
  const write = (path: string, content: string) =>
    workspace.set(`${WORK_DIR}/${path}`, { kind: 'file', content: Buffer.from(content) });

  beforeEach(() => {
    handler = () => ({ exitCode: 127, result: '' });
    workspace = new Map([[WORK_DIR, { kind: 'dir' }]]);
    git = fakeGit({ onExecute: (next) => (handler = next), workDir: WORK_DIR, workspace });
    rows = [];
    events = [];
    trace = [];
    audits = [];
    portReads = [];
    portEdits = [];
    activeRun = false;
    execFailure = undefined;
    truncateAt = undefined;
    insertFailure = undefined;
    readiness = { ready: true };
    template = { snapshot: 'forge-tpl-2026-09-01', template: 'vite-react' };

    const port = {
      read: vi.fn((_ref, path: string) => {
        portReads.push(path);
        const content = fileAt(path);
        return content === undefined
          ? Promise.reject(new Error('no file'))
          : Promise.resolve(content);
      }),
      edit: vi.fn((_ref, edit: { path: string; content: string }) => {
        portEdits.push({ content: edit.content, path: edit.path });
        write(edit.path, edit.content);
        return Promise.resolve({ bytes: edit.content.length, diff: '' });
      }),
      list: vi.fn(() =>
        Promise.resolve(
          [...workspace.keys()]
            .filter(
              (key) =>
                key.startsWith(`${WORK_DIR}/`) && !key.slice(WORK_DIR.length + 1).includes('/'),
            )
            .map((key) => ({ kind: 'file', name: key.slice(WORK_DIR.length + 1), size: 0 })),
        ),
      ),
      exec: vi.fn((_ref, command: string) => {
        trace.push('exec');
        if (execFailure) return Promise.reject(execFailure);
        const outcome = handler({ command });
        if ('status' in outcome) throw new Error('unexpected status');
        const truncated = truncateAt !== undefined && outcome.result.length > truncateAt;
        return Promise.resolve({
          exitCode: outcome.exitCode,
          output: truncated ? outcome.result.slice(0, truncateAt) : outcome.result,
          timedOut: false,
          truncated,
        });
      }),
    } as unknown as SandboxPort;
    const lifecycle = {
      ensureReady: (ensureReady = vi.fn(() => Promise.resolve(readiness))),
    } as unknown as SandboxLifecycle;
    const repository = {
      activeRunExists: () => {
        // Traced, not silent: R4's whole argument is that the lock is taken *before* this read,
        // and an untraced fake would make a check-then-lock refactor invisible to the order case.
        trace.push('activeRun');
        return Promise.resolve(activeRun);
      },
      byId: (_tx: unknown, org: string, id: string) => {
        trace.push('byId');
        return Promise.resolve(rows.find((row) => row.orgId === org && row.id === id) ?? null);
      },
      head: () => {
        trace.push('head');
        return Promise.resolve(rows.at(-1) ?? null);
      },
      insertOrGetBySha: (_tx: unknown, row: NewCheckpoint) => {
        if (insertFailure) return Promise.reject(insertFailure);
        const existing = rows.find((r) => r.gitSha === row.gitSha);
        if (existing) return Promise.resolve(existing);
        const inserted = {
          actorId: null,
          mirroredAt: null,
          revertsId: null,
          runId: null,
          turn: null,
          ...row,
          id: randomUUID(),
          updatedAt: row.createdAt,
        } as Checkpoint;
        rows.push(inserted);
        return Promise.resolve(inserted);
      },
      list: () => Promise.resolve({ items: [...rows].reverse(), nextCursor: null }),
      lockProject: (_tx: unknown, project: string) => {
        trace.push(`lock:${project === projectId ? 'project' : project}`);
        return Promise.resolve();
      },
      projectTemplate: () => Promise.resolve(template),
    } as unknown as CheckpointRepository;
    const outbox = {
      append: vi.fn((_tx: unknown, event: unknown) => {
        events.push(event);
        return Promise.resolve({ eventId: randomUUID() });
      }),
    } as unknown as OutboxWriter;

    const audit = {
      record: vi.fn((_tx: unknown, entry: AuditEntry) => {
        audits.push(entry);
        return Promise.resolve();
      }),
    } as unknown as AuditService;

    service = new CheckpointService(port, lifecycle, repository, outbox, audit, clock);

    // The baseline `ensureRepository` will make: init, an empty-ish scaffold, one row.
    handler({ command: 'git init -q' });
    write('README.md', 'hello\n');
    handler({ command: gitAdd() });
    handler({ command: gitCommit('Baseline') });
    rows.push({
      actorId: null,
      createdAt: clock.now(),
      files: [{ bytes: 6, path: 'README.md', status: 'A' }],
      gitSha: git.head()!,
      id: randomUUID(),
      kind: 'baseline',
      label: 'Baseline',
      mirroredAt: null,
      orgId,
      parentId: null,
      projectId,
      revertsId: null,
      runId: null,
      turn: null,
      syncOperationId: null,
      updatedAt: clock.now(),
    });
    git.commands.length = 0;
  });

  describe('ensureRepository (US4, R10)', () => {
    /** The fixture's baseline undone: a workspace as the sandbox claim delivered it. */
    const fresh = () => {
      workspace.clear();
      workspace.set(WORK_DIR, { kind: 'dir' });
      git = fakeGit({ onExecute: (next) => (handler = next), workDir: WORK_DIR, workspace });
      rows.length = 0;
    };
    const BASELINE_CTX: MutationContext = { leaseEpoch: 1, operationId: 'run-1/baseline' };

    it('inits, writes the default .gitignore, commits the scaffold and inserts the baseline row', async () => {
      fresh();
      write('README.md', 'hello\n');
      write('.env', 'SECRET=1\n');
      write('node_modules/x/index.js', 'x');

      await service.ensureRepository(ref, BASELINE_CTX, tx);

      const sha = git.head()!;
      expect(git.commands).toEqual([
        gitGitDir(),
        gitInit(),
        gitStatus(),
        gitAdd(),
        gitCommit('Baseline: vite-react forge-tpl-2026-09-01'),
        gitRevParse(),
        gitDiffTree(null, sha),
        gitLsTree(sha),
      ]);
      expect(fileAt('.gitignore')).toBe(
        'node_modules/\ndist/\n.next/\n__pycache__/\n.venv/\n.env*\n',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        createdAt: clock.now(),
        files: [
          { path: '.gitignore', status: 'A' },
          { bytes: 6, path: 'README.md', status: 'A' },
        ],
        gitSha: sha,
        kind: 'baseline',
        label: 'Baseline: vite-react forge-tpl-2026-09-01',
        parentId: null,
        runId: null,
        turn: null,
      });
      // FR-026: the environment file the ignore rules mark is in neither the commit nor the summary.
      expect(rows[0]!.files.map((file) => file.path)).not.toContain('.env');
      expect(git.commits.get(sha)!.tree.has('.env')).toBe(false);
      expect(events).toEqual([
        {
          aggregateId: rows[0]!.id,
          orgId,
          payload: { checkpointId: rows[0]!.id, orgId, projectId },
          type: 'checkpoint.created',
        },
      ]);
    });

    it("appends the default rules a scaffold's own .gitignore lacks (FR-026)", async () => {
      fresh();
      write('.gitignore', 'dist/\n');
      write('README.md', 'hello\n');
      write('.env', 'SECRET=1\n');

      await service.ensureRepository(ref, BASELINE_CTX, tx);

      expect(fileAt('.gitignore')).toBe(
        'dist/\nnode_modules/\n.next/\n__pycache__/\n.venv/\n.env*\n',
      );
      expect(rows[0]!.files.map((file) => file.path)).not.toContain('.env');
      expect(git.commits.get(rows[0]!.gitSha)!.tree.has('.env')).toBe(false);
    });

    it("leaves a scaffold's .gitignore alone when it already has every default rule", async () => {
      fresh();
      write('.gitignore', '.env*\nnode_modules/\ndist/\n.next/\n__pycache__/\n.venv/\n');

      await service.ensureRepository(ref, BASELINE_CTX, tx);

      expect(fileAt('.gitignore')).toBe(
        '.env*\nnode_modules/\ndist/\n.next/\n__pycache__/\n.venv/\n',
      );
    });

    it('takes the project writer lock before the head read and the first git step (one writer)', async () => {
      rows.length = 0;

      await service.ensureRepository(ref, BASELINE_CTX, tx);

      expect(trace[0]).toBe('lock:project');
      expect(trace).toContain('head');
    });

    it('is a no-op when .git and a row exist', async () => {
      await service.ensureRepository(ref, BASELINE_CTX, tx);

      expect(git.commands).toEqual([gitGitDir()]);
      expect(rows).toHaveLength(1);
      expect(events).toEqual([]);
    });

    it('commits the workspace as found when .git exists but no row does (pre-feature workspace)', async () => {
      rows.length = 0;
      write('src/app.ts', 'x');

      await service.ensureRepository(ref, BASELINE_CTX, tx);

      expect(git.commands.slice(0, 4)).toEqual([
        gitGitDir(),
        gitStatus(),
        gitAdd(),
        gitCommit('Baseline: workspace as found'),
      ]);
      expect(rows[0]).toMatchObject({
        kind: 'baseline',
        label: 'Baseline: workspace as found',
        parentId: null,
      });
      expect(rows[0]!.files.map((file) => file.path)).toEqual(['README.md', 'src/app.ts']);
    });

    it('reuses HEAD as the baseline when .git exists, no row does, and the tree is clean', async () => {
      rows.length = 0;
      const head = git.head()!;

      await service.ensureRepository(ref, BASELINE_CTX, tx);

      expect(git.commands).toEqual([
        gitGitDir(),
        gitStatus(),
        gitRevParse(),
        gitDiffTree(null, head),
        gitLsTree(head),
      ]);
      expect(git.commits.size).toBe(1);
      expect(rows[0]).toMatchObject({
        gitSha: head,
        kind: 'baseline',
        label: 'Baseline: workspace as found',
        parentId: null,
      });
    });

    it('reuses HEAD when a concurrent first run commits the baseline between status and commit', async () => {
      rows.length = 0;
      write('src/app.ts', 'x');
      // The other run's commit lands after this one's `status` said dirty: git answers exit 1.
      const inner = handler;
      handler = (request) => {
        if (request.command === gitAdd()) {
          inner(request);
          inner({ command: gitCommit('Baseline: workspace as found') });
        }
        return inner(request);
      };

      const before = git.commits.size;

      await service.ensureRepository(ref, BASELINE_CTX, tx);

      // The other run's commit and no second one; the row names it.
      expect(git.commits.size).toBe(before + 1);
      expect(rows[0]).toMatchObject({ gitSha: git.head(), kind: 'baseline', parentId: null });
    });

    it('labels the baseline as found when the project has no template', async () => {
      fresh();
      template = { snapshot: null, template: null };
      write('README.md', 'hello\n');

      await service.ensureRepository(ref, BASELINE_CTX, tx);

      expect(rows[0]!.label).toBe('Baseline: workspace as found');
    });
  });

  describe('commitTurn', () => {
    it('commits a dirty tree, inserts the row under the head, and answers its id and label (FR-004)', async () => {
      const runId = randomUUID();
      write('src/app.ts', 'export const a = 1;\n');
      write('README.md', 'hello world\n');

      const result = await service.commitTurn(ref, CTX, { runId, turn: 3 }, tx);

      const sha = git.head()!;
      expect(git.commands).toEqual([
        gitStatus(),
        gitAdd(),
        gitCommit('Turn 3'),
        gitRevParse(),
        gitDiffTree(rows[0]!.gitSha, sha),
        gitLsTree(sha),
      ]);
      expect(result).toEqual({ id: rows[1]!.id, label: 'Turn 3' });
      expect(rows[1]).toMatchObject({
        createdAt: clock.now(),
        files: [
          { bytes: 12, path: 'README.md', status: 'M' },
          { bytes: 20, path: 'src/app.ts', status: 'A' },
        ],
        gitSha: sha,
        kind: 'turn',
        parentId: rows[0]!.id,
        runId,
        turn: 3,
      });
      expect(events).toEqual([
        {
          aggregateId: rows[1]!.id,
          orgId,
          payload: { checkpointId: rows[1]!.id, orgId, projectId },
          type: 'checkpoint.created',
        },
      ]);
    });

    it('takes the project writer lock before the head read and the first git step (one writer)', async () => {
      write('a.txt', 'a');

      await service.commitTurn(ref, CTX, { runId: randomUUID(), turn: 1 }, tx);

      expect(trace.slice(0, 3)).toEqual(['lock:project', 'head', 'exec']);
    });

    it('records a deletion with 0 bytes', async () => {
      workspace.delete(`${WORK_DIR}/README.md`);

      await service.commitTurn(ref, CTX, { runId: randomUUID(), turn: 1 }, tx);

      expect(rows[1]!.files).toEqual([{ bytes: 0, path: 'README.md', status: 'D' }]);
    });

    it('commits nothing on a clean tree and answers the head (FR-005)', async () => {
      const result = await service.commitTurn(ref, CTX, { runId: randomUUID(), turn: 1 }, tx);

      expect(git.commands).toEqual([gitStatus()]);
      expect(result).toEqual({ id: rows[0]!.id, label: 'Baseline' });
      expect(rows).toHaveLength(1);
      expect(events).toEqual([]);
    });

    it('answers the existing row when a resumed attempt finds the tree clean (R5 via the FR-005 early return)', async () => {
      write('a.txt', 'a');
      const first = await service.commitTurn(ref, CTX, { runId: randomUUID(), turn: 1 }, tx);
      // The resumed attempt: git already holds the commit, the tree reads clean.
      const second = await service.commitTurn(ref, CTX, { runId: randomUUID(), turn: 1 }, tx);

      expect(second.id).toBe(first.id);
      expect(rows).toHaveLength(2);
      expect(git.commits.size).toBe(2);
    });

    it('propagates a failed insert; the next checkpoint spans the orphan commit (SC-007)', async () => {
      write('a.txt', 'a');
      insertFailure = new Error('connection reset');

      await expect(
        service.commitTurn(ref, CTX, { runId: randomUUID(), turn: 1 }, tx),
      ).rejects.toThrow('connection reset');
      expect(rows).toHaveLength(1);
      expect(events).toEqual([]);

      insertFailure = undefined;
      write('b.txt', 'b');
      await service.commitTurn(ref, CTX, { runId: randomUUID(), turn: 2 }, tx);

      expect(git.commits.size).toBe(3);
      expect(rows[1]).toMatchObject({
        files: [
          { bytes: 1, path: 'a.txt', status: 'A' },
          { bytes: 1, path: 'b.txt', status: 'A' },
        ],
        parentId: rows[0]!.id,
      });
    });

    it('rethrows a DaytonaError from exec unchanged', async () => {
      execFailure = new DaytonaError('unreachable', 'daytona unreachable');

      await expect(service.commitTurn(ref, CTX, { runId: randomUUID(), turn: 1 }, tx)).rejects.toBe(
        execFailure,
      );
      expect(rows).toHaveLength(1);
    });

    it('fails the step when a summary command is clipped, and persists nothing', async () => {
      write('a.txt', 'a');
      truncateAt = 60;

      await expect(
        service.commitTurn(ref, CTX, { runId: randomUUID(), turn: 1 }, tx),
      ).rejects.toThrow(/ls-tree.*truncated/);
      expect(rows).toHaveLength(1);
    });
  });

  describe('recordPulled (018 US3, R6/R7)', () => {
    const actorId = randomUUID();
    const syncOperationId = randomUUID();
    /** Commits landed "from the remote": each one over the last, as a fast-forward merge leaves them. */
    const land = (label: string, path: string, content: string): string => {
      write(path, content);
      handler({ command: gitAdd() });
      handler({ command: gitCommit(label) });
      return git.head()!;
    };

    it('records five pulled commits as five pull rows chained by parentId, each with its subject', async () => {
      const shas = [1, 2, 3, 4, 5].map((n) =>
        land(`Remote ${String(n)}`, `f${String(n)}.txt`, 'x'.repeat(n)),
      );
      git.commands.length = 0;

      const recorded = await service.recordPulled(ref, CTX, actorId, syncOperationId, shas, tx);

      expect(recorded.map((row) => row.gitSha)).toEqual(shas);
      expect(rows).toHaveLength(6);
      shas.forEach((sha, i) => {
        expect(rows[i + 1]).toMatchObject({
          actorId,
          files: [{ bytes: i + 1, path: `f${String(i + 1)}.txt`, status: 'A' }],
          gitSha: sha,
          kind: 'pull',
          label: `Remote ${String(i + 1)}`,
          parentId: rows[i]!.id,
          syncOperationId,
        });
      });
      expect(events.map((event) => (event as { type: string }).type)).toEqual(
        Array<string>(5).fill('checkpoint.created'),
      );
      expect(git.commands.slice(0, 3)).toEqual([
        gitDiffTree(rows[0]!.gitSha, shas[0]!),
        gitLsTree(shas[0]!),
        gitLogSubject(shas[0]!),
      ]);
      expect(trace[0]).toBe('lock:project');
    });

    it('finds a sha already recorded instead of duplicating it, and chains the next under it', async () => {
      const first = land('Remote 1', 'a.txt', 'a');
      const second = land('Remote 2', 'b.txt', 'b');
      await service.recordPulled(ref, CTX, actorId, syncOperationId, [first], tx);
      events.length = 0;

      const recorded = await service.recordPulled(
        ref,
        CTX,
        actorId,
        syncOperationId,
        [first, second],
        tx,
      );

      expect(rows).toHaveLength(3);
      expect(recorded[0]!.id).toBe(rows[1]!.id);
      expect(rows[2]).toMatchObject({ gitSha: second, kind: 'pull', parentId: rows[1]!.id });
      expect(events).toHaveLength(2);
    });

    it('cuts a subject to 200 characters', async () => {
      const sha = land('s'.repeat(300), 'a.txt', 'a');

      const [row] = await service.recordPulled(ref, CTX, actorId, syncOperationId, [sha], tx);

      expect(row!.label).toHaveLength(200);
    });
  });

  describe('list', () => {
    it('answers not-found for a project that does not exist, as a foreign org would', async () => {
      template = null;
      await expect(service.list(tx, ref, { limit: 10 })).rejects.toMatchObject({
        type: 'not-found',
      });
    });
  });

  describe('byId', () => {
    it('answers not-found for a row of another project', async () => {
      await expect(
        service.byId(tx, { orgId, projectId: randomUUID() }, rows[0]!.id),
      ).rejects.toMatchObject({
        type: 'not-found',
      });
      await expect(service.byId(tx, ref, rows[0]!.id)).resolves.toBe(rows[0]);
    });
  });

  describe('diff', () => {
    it('runs git diff against the parent and joins bytes onto binary rows', async () => {
      write('logo.png', '\0\0PNG');
      write('README.md', 'hello world\n');
      const { id } = await service.commitTurn(ref, CTX, { runId: randomUUID(), turn: 1 }, tx);
      git.commands.length = 0;

      const diff = await service.diff(tx, ref, id);

      expect(git.commands).toEqual([
        `git diff ${rows[0]!.gitSha} ${rows[1]!.gitSha}`,
        gitLsTree(rows[1]!.gitSha),
      ]);
      expect(diff).toEqual({
        checkpointId: id,
        files: [
          {
            binary: false,
            path: 'README.md',
            patch: expect.stringContaining('+hello world') as string,
            status: 'M',
            truncated: false,
          },
          { binary: true, bytes: 5, path: 'logo.png', status: 'A' },
        ],
        parentId: rows[0]!.id,
      });
    });

    it('diffs the baseline against the empty tree', async () => {
      const diff = await service.diff(tx, ref, rows[0]!.id);

      expect(git.commands[0]).toBe(
        `git diff 4b825dc642cb6eb9a060e54bf8d69288fbee4904 ${rows[0]!.gitSha}`,
      );
      expect(diff.parentId).toBeNull();
      expect(diff.files).toMatchObject([{ path: 'README.md', status: 'A' }]);
      expect(ensureReady).toHaveBeenCalledWith(tx, ref, {
        leaseEpoch: 0,
        operationId: `diff/${rows[0]!.id}`,
      });
    });

    it('marks the last file truncated when git diff is clipped, and drops its partial hunk', async () => {
      write('a.txt', 'a'.repeat(200));
      write('b.txt', 'b'.repeat(200));
      const { id } = await service.commitTurn(ref, CTX, { runId: randomUUID(), turn: 1 }, tx);
      truncateAt = 400;

      const diff = await service.diff(tx, ref, id);

      expect(diff.files).toMatchObject([
        { path: 'a.txt', truncated: false },
        { path: 'b.txt', truncated: true },
      ]);
      expect(diff.files[1]).toMatchObject({ patch: expect.not.stringContaining('@@') as string });
    });

    it('answers service-unavailable with Retry-After 5 while the sandbox wakes (R7)', async () => {
      readiness = { because: 'resuming', ready: false };

      const failure = await service.diff(tx, ref, rows[0]!.id).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(DomainError);
      expect(failure).toMatchObject({ retryAfterSeconds: 5, type: 'service-unavailable' });
      expect(git.commands).toEqual([]);
    });
  });

  describe('revert (US2, R3, R4)', () => {
    const actorId = randomUUID();
    /** A turn that edits README and adds a file: rows[1], the head. */
    const turn = async (n: number, edits: Record<string, string | null>) => {
      for (const [path, content] of Object.entries(edits)) {
        if (content === null) workspace.delete(`${WORK_DIR}/${path}`);
        else write(path, content);
      }
      return service.commitTurn(ref, CTX, { runId: randomUUID(), turn: n }, tx);
    };

    it('restores the target tree, commits over the head, and records the revert row with its audit entry', async () => {
      await turn(1, { 'README.md': 'hello world\n', 'src/app.ts': 'x' });
      const [baseline, head] = rows as [Checkpoint, Checkpoint];
      git.commands.length = 0;
      events.length = 0;

      const row = await service.revert(ref, actorId, baseline.id, tx);

      const sha = git.head()!;
      expect(git.commands).toEqual([
        gitStatus(),
        gitRevParse(),
        gitDiffQuiet(baseline.gitSha, head.gitSha),
        gitReadTree(baseline.gitSha),
        gitCommit('Revert to Baseline'),
        gitRevParse(),
        gitDiffTree(head.gitSha, sha),
        gitLsTree(sha),
      ]);
      expect(fileAt('README.md')).toBe('hello\n');
      expect(fileAt('src/app.ts')).toBeUndefined();
      expect(git.commits.get(sha)!.parent).toBe(head.gitSha);
      expect(row).toBe(rows[2]);
      expect(row).toMatchObject({
        actorId,
        createdAt: clock.now(),
        files: [
          { bytes: 6, path: 'README.md', status: 'M' },
          { bytes: 0, path: 'src/app.ts', status: 'D' },
        ],
        gitSha: sha,
        kind: 'revert',
        label: 'Revert to Baseline',
        parentId: head.id,
        revertsId: baseline.id,
        runId: null,
        turn: null,
      });
      expect(ensureReady).toHaveBeenCalledWith(tx, ref, {
        leaseEpoch: 0,
        operationId: `revert/${baseline.id}`,
      });
      expect(audits).toEqual([
        {
          action: 'checkpoint.reverted',
          actorId,
          metadata: { projectId, revertsId: baseline.id },
          orgId,
          target: row.id,
        },
      ]);
      expect(events).toEqual([
        {
          aggregateId: row.id,
          orgId,
          payload: { checkpointId: row.id, orgId, projectId },
          type: 'checkpoint.created',
        },
      ]);
    });

    it('reverts a revert back to the earlier tree, byte for byte (SC-003, FR-014)', async () => {
      await turn(1, { 'README.md': 'hello world\n', 'logo.png': '\0\0PNG' });
      const [baseline, b] = rows as [Checkpoint, Checkpoint];

      const c = await service.revert(ref, actorId, baseline.id, tx);
      const d = await service.revert(ref, actorId, b.id, tx);

      expect(c).toMatchObject({ parentId: b.id, revertsId: baseline.id });
      expect(d).toMatchObject({ label: 'Revert to Turn 1', parentId: c.id, revertsId: b.id });
      expect(git.commits.get(d.gitSha)!.tree).toEqual(git.commits.get(b.gitSha)!.tree);
      expect(rows.map((row) => row.kind)).toEqual(['baseline', 'turn', 'revert', 'revert']);
    });

    /** A member's hand edit over the current head: 024 US1's row, as the target of a revert. */
    const save = (path: string, content: string) =>
      service.save(ref, actorId, { baseCheckpointId: rows.at(-1)!.id, content, path }, tx);

    it('accepts an edit row as its target and produces the same shape of revert row a turn does (FR-012, FR-026)', async () => {
      const [baseline] = rows as [Checkpoint];
      await save('README.md', 'edited by hand\n');
      const edit = rows[1]!;
      await turn(1, { 'src/app.ts': 'x' });
      const runTurn = rows[2]!;
      // Back to the baseline first, so neither the turn nor the edit is the tree HEAD already has.
      const undo = await service.revert(ref, actorId, baseline.id, tx);

      const ofTurn = await service.revert(ref, actorId, runTurn.id, tx);
      const ofEdit = await service.revert(ref, actorId, edit.id, tx);

      // The same row, field for field: only the target it names and the label it takes from that
      // target differ. `revert` reads `gitSha`, `kind` and `label` off its target and nothing else,
      // which is why an `edit` row needs no branch of its own.
      expect(Object.keys(ofEdit).sort()).toEqual(Object.keys(ofTurn).sort());
      expect(ofTurn).toMatchObject({
        actorId,
        kind: 'revert',
        label: 'Revert to Turn 1',
        parentId: undo.id,
        revertsId: runTurn.id,
        runId: null,
        turn: null,
      });
      expect(ofEdit).toMatchObject({
        actorId,
        createdAt: clock.now(),
        kind: 'revert',
        label: 'Revert to Edit README.md',
        parentId: ofTurn.id,
        revertsId: edit.id,
        runId: null,
        turn: null,
      });
      // The tree is the edit's, and the summary is the shared `summary()` shape the turn's revert
      // has — the same keys, against the head the revert was taken over.
      expect(git.commits.get(ofEdit.gitSha)!.tree).toEqual(git.commits.get(edit.gitSha)!.tree);
      expect(fileAt('README.md')).toBe('edited by hand\n');
      // Against the head it was taken over (the turn's tree restored), the edit's tree differs by
      // the one file the turn added — the same `{ path, status, bytes }` rows a turn's revert has.
      expect(ofEdit.files).toEqual([{ bytes: 0, path: 'src/app.ts', status: 'D' }]);
      expect(ofTurn.files).toEqual([
        { bytes: 15, path: 'README.md', status: 'M' },
        { bytes: 1, path: 'src/app.ts', status: 'A' },
      ]);
      const keysOf = (files: Checkpoint['files']) => [
        ...new Set(files.map((file) => Object.keys(file).sort().join(','))),
      ];
      expect(keysOf(ofEdit.files)).toEqual(keysOf(ofTurn.files));
      // And the same audit entry, naming the edit row as any other target would be named.
      expect(audits.at(-1)).toEqual({
        action: 'checkpoint.reverted',
        actorId,
        metadata: { projectId, revertsId: edit.id },
        orgId,
        target: ofEdit.id,
      });
      expect(events.at(-1)).toEqual({
        aggregateId: ofEdit.id,
        orgId,
        payload: { checkpointId: ofEdit.id, orgId, projectId },
        type: 'checkpoint.created',
      });
    });

    it('reverts the revert of a hand edit back to the edit, deleting nothing on the way (FR-013)', async () => {
      const [baseline] = rows as [Checkpoint];
      await save('README.md', 'edited by hand\n');
      const edit = rows[1]!;
      const after = { edit: [...rows] };

      // Undo the hand edit, then undo that undo: history only ever grows.
      const undo = await service.revert(ref, actorId, baseline.id, tx);
      const afterUndo = [...rows];
      expect(fileAt('README.md')).toBe('hello\n');

      const redo = await service.revert(ref, actorId, edit.id, tx);

      // The edit's bytes are back, from its tree, not from a string this test kept.
      expect(fileAt('README.md')).toBe('edited by hand\n');
      expect(git.commits.get(redo.gitSha)!.tree).toEqual(git.commits.get(edit.gitSha)!.tree);
      expect(redo).toMatchObject({
        kind: 'revert',
        label: 'Revert to Edit README.md',
        parentId: undo.id,
        revertsId: edit.id,
      });
      // Nothing deleted at any step: every earlier row is still there, unchanged and in order, and
      // each step only appended. The edit row in particular survives being undone.
      expect(rows.slice(0, after.edit.length)).toEqual(after.edit);
      expect(rows.slice(0, afterUndo.length)).toEqual(afterUndo);
      expect(rows).toEqual([...afterUndo, redo]);
      expect(rows.map((row) => row.kind)).toEqual(['baseline', 'edit', 'revert', 'revert']);
      expect(rows[1]).toBe(edit);
      expect(rows[1]).toMatchObject({ gitSha: edit.gitSha, label: 'Edit README.md' });
      // And the history the surface lists still holds all four, newest first.
      const listed = await service.list(tx, ref, { limit: 10 });
      expect(listed.items.map((row) => row.id)).toEqual([...rows].reverse().map((row) => row.id));
    });

    it('takes the project writer lock before the target and head reads (one writer)', async () => {
      await turn(1, { 'a.txt': 'a' });
      trace.length = 0;

      await service.revert(ref, actorId, rows[0]!.id, tx);

      expect(trace.slice(0, 3)).toEqual(['lock:project', 'byId', 'head']);
    });

    it('a revert of a revert row carries the label that row has, never nesting (label ≤ 200)', async () => {
      await turn(1, { 'a.txt': 'a' });
      const [baseline, b] = rows as [Checkpoint, Checkpoint];

      const c = await service.revert(ref, actorId, baseline.id, tx);
      const d = await service.revert(ref, actorId, b.id, tx);
      const e = await service.revert(ref, actorId, c.id, tx);

      expect(c.label).toBe('Revert to Baseline');
      expect(d.label).toBe('Revert to Turn 1');
      expect(e).toMatchObject({ label: 'Revert to Baseline', parentId: d.id, revertsId: c.id });
    });

    it('restores a dirty workspace to a target whose tree HEAD already has, without a new commit', async () => {
      await turn(1, { 'a.txt': 'a' });
      const [baseline] = rows as [Checkpoint];
      const c = await service.revert(ref, actorId, baseline.id, tx);
      // HEAD is c, whose tree is the baseline's; the target is the baseline, another sha.
      write('README.md', 'half-done');
      git.commands.length = 0;
      const commits = git.commits.size;

      const row = await service.revert(ref, actorId, baseline.id, tx);

      expect(git.commands).toEqual([
        gitStatus(),
        gitRevParse(),
        gitReadTree(baseline.gitSha),
        gitCommit('Revert to Baseline'),
        gitRevParse(),
      ]);
      expect(fileAt('README.md')).toBe('hello\n');
      expect(git.commits.size).toBe(commits);
      expect(row).toBe(c);
      expect(rows).toHaveLength(3);
    });

    it('refuses the checkpoint the workspace is already at, and records nothing (FR-012)', async () => {
      const failure = await service.revert(ref, actorId, rows[0]!.id, tx).catch((e: unknown) => e);

      expect(failure).toMatchObject({ detail: 'Already at this checkpoint.', type: 'conflict' });
      expect(git.commands).toEqual([
        gitStatus(),
        gitRevParse(),
        gitDiffQuiet(rows[0]!.gitSha, rows[0]!.gitSha),
      ]);
      expect(rows).toHaveLength(1);
      expect(audits).toEqual([]);
    });

    it('compares against git HEAD, not the head row: an orphan commit (SC-007) does not block a revert to the row', async () => {
      // Turn 1 committed but its insert failed: git HEAD is past the head row.
      write('a.txt', 'a');
      insertFailure = new Error('connection reset');
      await service
        .commitTurn(ref, CTX, { runId: randomUUID(), turn: 1 }, tx)
        .catch(() => undefined);
      insertFailure = undefined;
      const orphan = git.head()!;
      git.commands.length = 0;

      const row = await service.revert(ref, actorId, rows[0]!.id, tx);

      expect(git.commands.slice(0, 4)).toEqual([
        gitStatus(),
        gitRevParse(),
        gitDiffQuiet(rows[0]!.gitSha, orphan),
        gitReadTree(rows[0]!.gitSha),
      ]);
      expect(fileAt('a.txt')).toBeUndefined();
      expect(git.commits.get(row.gitSha)!.parent).toBe(orphan);
      expect(row).toMatchObject({ kind: 'revert', parentId: rows[0]!.id, revertsId: rows[0]!.id });
      // `files` is row-to-row (R7): the baseline row to a baseline tree is no change.
      expect(row.files).toEqual([]);
    });

    it('restores a dirty workspace to the head checkpoint without a new commit (a failed run left edits)', async () => {
      write('README.md', 'half-done');
      write('junk.txt', 'x');

      const row = await service.revert(ref, actorId, rows[0]!.id, tx);

      expect(git.commands).toEqual([gitStatus(), gitRevParse(), gitReadTree(rows[0]!.gitSha)]);
      expect(fileAt('README.md')).toBe('hello\n');
      expect(fileAt('junk.txt')).toBeUndefined();
      expect(git.commits.size).toBe(1);
      expect(rows).toHaveLength(1);
      expect(row).toBe(rows[0]);
      expect(audits).toMatchObject([{ action: 'checkpoint.reverted', target: rows[0]!.id }]);
    });

    it('refuses while a run is active, before touching the sandbox (FR-012, SC-004)', async () => {
      await turn(1, { 'a.txt': 'a' });
      activeRun = true;
      git.commands.length = 0;

      const failure = await service.revert(ref, actorId, rows[0]!.id, tx).catch((e: unknown) => e);

      expect(failure).toMatchObject({ detail: 'A run is active.', type: 'conflict' });
      expect(ensureReady).not.toHaveBeenCalled();
      expect(git.commands).toEqual([]);
      expect(rows).toHaveLength(2);
    });

    it('answers not-found for a target of another project', async () => {
      await expect(
        service.revert({ orgId, projectId: randomUUID() }, actorId, rows[0]!.id, tx),
      ).rejects.toMatchObject({ type: 'not-found' });
      expect(git.commands).toEqual([]);
    });

    it('answers service-unavailable with Retry-After 5 while the sandbox wakes', async () => {
      await turn(1, { 'a.txt': 'a' });
      readiness = { because: 'resuming', ready: false };
      git.commands.length = 0;

      const failure = await service.revert(ref, actorId, rows[0]!.id, tx).catch((e: unknown) => e);

      expect(failure).toMatchObject({ retryAfterSeconds: 5, type: 'service-unavailable' });
      expect(git.commands).toEqual([]);
    });
  });

  describe('save (US1, R7)', () => {
    const actorId = randomUUID();
    /** What `files.service.ts` answers a read with when the project has no checkpoint yet. */
    const NIL_UUID = '00000000-0000-0000-0000-000000000000';
    const input = (path: string, content: string) => ({
      baseCheckpointId: rows.at(-1)!.id,
      content,
      path,
    });

    it('writes the file, commits over the head and records an edit row naming its author (FR-007, FR-008)', async () => {
      const [baseline] = rows as [Checkpoint];
      git.commands.length = 0;
      events.length = 0;

      const result = await service.save(ref, actorId, input('README.md', 'hello again\n'), tx);

      const sha = git.head()!;
      expect(git.commands).toEqual([
        gitStatus(),
        gitAdd(),
        gitCommit('Edit README.md'),
        gitRevParse(),
        gitDiffTree(baseline.gitSha, sha),
        gitLsTree(sha),
      ]);
      expect(fileAt('README.md')).toBe('hello again\n');
      expect(git.commits.get(sha)!.parent).toBe(baseline.gitSha);
      expect(result.saved).toBe(true);
      expect(result.checkpoint).toBe(rows[1]);
      expect(result.checkpoint).toMatchObject({
        actorId,
        createdAt: clock.now(),
        gitSha: sha,
        kind: 'edit',
        label: 'Edit README.md',
        parentId: baseline.id,
        revertsId: null,
        runId: null,
        turn: null,
      });
      expect(audits).toEqual([
        {
          action: 'checkpoint.edited',
          actorId,
          metadata: { path: 'README.md', projectId },
          orgId,
          target: result.checkpoint.id,
        },
      ]);
    });

    it('takes the project writer lock before reading the head (one writer)', async () => {
      trace.length = 0;

      await service.save(ref, actorId, input('README.md', 'hello again\n'), tx);

      expect(trace.slice(0, 3)).toEqual(['lock:project', 'activeRun', 'head']);
    });

    /**
     * T033, research R4: the order itself is the requirement, not an implementation detail. A
     * refactor that reads `activeRunExists` first and only then takes the lock would still refuse
     * every save this suite's behavioural cases try, because nothing else is writing to an
     * in-memory fake; it would only lose the race against a run that starts in between. This is
     * the one case that fails on that refactor, which is why the fake repository traces the read.
     */
    it('takes the project writer lock before it asks whether a run is active (R4, FR-015)', async () => {
      trace.length = 0;

      await service.save(ref, actorId, input('README.md', 'hello again\n'), tx);

      expect(trace).toContain('activeRun');
      expect(trace.indexOf('lock:project')).toBeLessThan(trace.indexOf('activeRun'));
      // Spelled out as a sequence too: check-then-lock would read `['activeRun', 'lock:project']`.
      expect(trace.slice(0, 2)).toEqual(['lock:project', 'activeRun']);
    });

    it('refuses while a run is active, writing nothing and recording nothing (FR-014, FR-015)', async () => {
      const [baseline] = rows as [Checkpoint];
      activeRun = true;
      git.commands.length = 0;
      events.length = 0;
      audits.length = 0;
      portEdits.length = 0;
      portReads.length = 0;
      ensureReady.mockClear();
      trace.length = 0;

      const failure = await service
        .save(ref, actorId, input('README.md', 'hello again\n'), tx)
        .catch((e: unknown) => e);

      expect(failure).toBeInstanceOf(DomainError);
      // `ConflictError`'s extensions are not spread onto the error: the reason is the web
      // client's branch between "wait for the run" and "reload the file" (contracts § 4).
      expect(failure).toMatchObject({ extensions: { reason: 'run-active' }, type: 'conflict' });
      // Under the lock, and before the base check or anything that could reach the sandbox.
      expect(trace).toEqual(['lock:project', 'activeRun']);
      expect(ensureReady).not.toHaveBeenCalled();
      // The workspace is untouched: the run's half-written tree is not written over (FR-015).
      expect(portEdits).toEqual([]);
      expect(portReads).toEqual([]);
      expect(fileAt('README.md')).toBe('hello\n');
      expect(git.commands).toEqual([]);
      // No row, no event, no audit entry.
      expect(rows).toEqual([baseline]);
      expect(events).toEqual([]);
      expect(audits).toEqual([]);
    });

    it('carries a member’s mutation context, not a run’s lease (FR-007)', async () => {
      const [baseline] = rows as [Checkpoint];

      await service.save(ref, actorId, input('README.md', 'hello again\n'), tx);

      expect(ensureReady).toHaveBeenCalledWith(tx, ref, {
        leaseEpoch: 0,
        operationId: `edit/${baseline.id}`,
      });
    });

    it('records nothing and answers the current head when git says the tree is clean (FR-005)', async () => {
      const [baseline] = rows as [Checkpoint];
      git.commands.length = 0;
      events.length = 0;

      const result = await service.save(ref, actorId, input('README.md', 'hello\n'), tx);

      // The write happened; `git status` — not a string comparison — is what says there is
      // nothing to record, so the old content is never read back (R7).
      expect(fileAt('README.md')).toBe('hello\n');
      expect(portReads).toEqual([]);
      expect(git.commands).toEqual([gitStatus()]);
      expect(result).toEqual({ checkpoint: baseline, saved: false });
      expect(rows).toHaveLength(1);
      expect(events).toEqual([]);
      expect(audits).toEqual([]);
    });

    it('answers service-unavailable with Retry-After 5 while the sandbox wakes, writing nothing', async () => {
      readiness = { because: 'resuming', ready: false };
      git.commands.length = 0;

      const failure = await service
        .save(ref, actorId, input('README.md', 'hello again\n'), tx)
        .catch((e: unknown) => e);

      expect(failure).toBeInstanceOf(DomainError);
      expect(failure).toMatchObject({ retryAfterSeconds: 5, type: 'service-unavailable' });
      expect(portEdits).toEqual([]);
      expect(git.commands).toEqual([]);
      expect(rows).toHaveLength(1);
    });

    it('refuses a project with no checkpoint at all: a hand edit never roots a history', async () => {
      const base = rows[0]!.id;
      rows.length = 0;
      git.commands.length = 0;

      const failure = await service
        .save(ref, actorId, { baseCheckpointId: base, content: 'x\n', path: 'README.md' }, tx)
        .catch((e: unknown) => e);

      expect(failure).toMatchObject({ extensions: { reason: 'base-moved' }, type: 'conflict' });
      expect(ensureReady).not.toHaveBeenCalled();
      expect(portEdits).toEqual([]);
      expect(git.commands).toEqual([]);
      expect(rows).toEqual([]);
      expect(events).toEqual([]);
    });

    it('refuses a base that is no longer the head, touching neither workspace nor history (FR-018, FR-020)', async () => {
      // Someone else's save moves the head; the first person's editor still holds the old base.
      const [baseline] = rows as [Checkpoint];
      await service.save(ref, actorId, input('README.md', 'hello again\n'), tx);
      const headRow = rows.at(-1)!;
      expect(headRow.id).not.toBe(baseline.id);
      git.commands.length = 0;
      events.length = 0;
      audits.length = 0;
      portEdits.length = 0;
      portReads.length = 0;
      ensureReady.mockClear();
      trace.length = 0;

      const failure = await service
        .save(
          ref,
          actorId,
          { baseCheckpointId: baseline.id, content: 'a third thing\n', path: 'README.md' },
          tx,
        )
        .catch((e: unknown) => e);

      expect(failure).toBeInstanceOf(DomainError);
      expect(failure).toMatchObject({ extensions: { reason: 'base-moved' }, type: 'conflict' });
      // Under the lock, and before anything could reach the sandbox (FR-020).
      expect(trace).toEqual(['lock:project', 'activeRun', 'head']);
      expect(ensureReady).not.toHaveBeenCalled();
      // The workspace is untouched: nothing written, nothing read back.
      expect(portEdits).toEqual([]);
      expect(portReads).toEqual([]);
      expect(fileAt('README.md')).toBe('hello again\n');
      expect(git.commands).toEqual([]);
      expect(git.head()).toBe(headRow.gitSha);
      // The history is untouched: no row, no event, no audit entry.
      expect(rows).toEqual([baseline, headRow]);
      expect(events).toEqual([]);
      expect(audits).toEqual([]);
    });

    it('refuses a base naming another project’s checkpoint, or nothing at all, without looking it up (FR-021)', async () => {
      const [baseline] = rows as [Checkpoint];
      for (const baseCheckpointId of [randomUUID(), NIL_UUID]) {
        git.commands.length = 0;
        events.length = 0;
        audits.length = 0;
        portEdits.length = 0;
        portReads.length = 0;
        ensureReady.mockClear();
        trace.length = 0;

        const failure = await service
          .save(ref, actorId, { baseCheckpointId, content: 'x\n', path: 'README.md' }, tx)
          .catch((e: unknown) => e);

        expect(failure).toMatchObject({ extensions: { reason: 'base-moved' }, type: 'conflict' });
        // The head is the only thing consulted: an id that is not it is stale, whoever owns it.
        // No `byId` — a stranger's id is never fetched — and no reconstruction of what it named.
        expect(trace).toEqual(['lock:project', 'activeRun', 'head']);
        expect(ensureReady).not.toHaveBeenCalled();
        expect(portEdits).toEqual([]);
        expect(portReads).toEqual([]);
        expect(git.commands).toEqual([]);
        expect(rows).toEqual([baseline]);
        expect(events).toEqual([]);
        expect(audits).toEqual([]);
      }
    });

    it('summarises the change and emits `checkpoint.created` exactly as a revert does (FR-010, FR-011)', async () => {
      events.length = 0;

      const result = await service.save(
        ref,
        actorId,
        input('src/app.ts', 'export const a = 1;\n'),
        tx,
      );

      expect(result.checkpoint.files).toEqual([{ bytes: 20, path: 'src/app.ts', status: 'A' }]);
      expect(events).toEqual([
        {
          aggregateId: result.checkpoint.id,
          orgId,
          payload: { checkpointId: result.checkpoint.id, orgId, projectId },
          type: 'checkpoint.created',
        },
      ]);
      // The same `{ path, status, bytes }` shape, from the same `summary()`, that the revert of
      // this edit produces — which is why the mirror and the diff need no new code.
      const reverted = await service.revert(ref, actorId, rows[0]!.id, tx);
      expect(reverted.files).toEqual([{ bytes: 0, path: 'src/app.ts', status: 'D' }]);
    });
  });
});
