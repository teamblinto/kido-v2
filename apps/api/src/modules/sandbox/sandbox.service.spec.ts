import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Sandbox } from '@repo/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeClock } from '../../common/clock/fake-clock';
import { NotFoundError } from '../../common/errors/domain-error';
import type { Environment } from '../../config/environment';
import type { TenantContext } from '../../database/tenant-context';
import type { TenantTransaction } from '../../database/database.types';
import type { AuditService } from '../audit/audit.service';
import { type FakeDaytona, startFakeDaytona } from '../../../test/support/fake-daytona';
import type { ProjectService } from '../tenancy/services/project.service';
import { DaytonaAdapter } from './daytona.adapter';
import { DEFAULT_DAYTONA_TIMINGS, type DaytonaTimings } from './sandbox.constants';
import { DaytonaError, SandboxGuardError } from './sandbox.errors';
import type { MutationContext, SandboxRef } from './sandbox.port';
import { SandboxService } from './sandbox.service';
import type { SandboxLifecycleService } from './sandbox-lifecycle';
import { TemplateCatalogue } from './template-catalogue';

const START = '2026-09-15T10:00:00.000Z';
const REF: SandboxRef = {
  orgId: 'c1000000-0000-4000-8000-000000000001',
  projectId: 'c1000000-0000-4000-8000-000000000002',
};
const CTX: MutationContext = { leaseEpoch: 3, operationId: 'run-1/step-2' };
/** The broker's clock, as 017's callback stamps it into `sandboxes.ports` (023 data-model § 2). */
const OBSERVED = '2026-09-22T14:03:11.492Z';

/**
 * The port over the real adapter and the loopback fake, with the `sandboxes` row read stubbed:
 * the row is what `sandbox-registration.e2e-spec.ts` proves under RLS, and what this suite needs
 * from it is one object. `ProjectService.read` is stubbed the same way `run.service.spec.ts` does.
 */
describe('SandboxService', () => {
  let fake: FakeDaytona;
  let rows: { findFirst: ReturnType<typeof vi.fn> };
  let projectRows: { findFirst: ReturnType<typeof vi.fn> };
  let projects: { read: ReturnType<typeof vi.fn> };
  let lifecycle: { touch: ReturnType<typeof vi.fn> };
  let service: SandboxService;

  function row(): Sandbox {
    return {
      createdAt: new Date(START),
      daytonaId: fake.sandboxId,
      failureReason: null,
      hibernatedAt: null,
      id: 'c1000000-0000-4000-8000-000000000009',
      lastSeenAt: null,
      lostAt: null,
      node: fake.runnerId,
      orgId: REF.orgId,
      ports: {},
      projectId: REF.projectId,
      snapshotKey: null,
      state: 'active',
      stateEnteredAt: new Date(START),
      templateSnapshot: null,
      transition: null,
      transitionSince: null,
      updatedAt: new Date(START),
      workspaceRoot: fake.workDir,
    };
  }

  function build(timings: Partial<DaytonaTimings> = {}): SandboxService {
    const env = { DAYTONA_API_KEY: fake.apiKey, DAYTONA_API_URL: fake.apiUrl };
    const all = { ...DEFAULT_DAYTONA_TIMINGS, ...timings };
    const adapter = new DaytonaAdapter(
      { get: (key: keyof typeof env) => env[key] } as unknown as ConfigService<Environment, true>,
      all,
      new FakeClock(START),
    );

    return new SandboxService(
      { tx: { query: { projects: projectRows, sandboxes: rows } } } as unknown as TenantContext,
      projects as unknown as ProjectService,
      { record: vi.fn() } as unknown as AuditService,
      adapter,
      all,
      new FakeClock(START),
      lifecycle as unknown as SandboxLifecycleService,
      // The shipped catalogue, not a stub: `previewStatus` answers the port the manifests declare.
      new TemplateCatalogue(),
    );
  }

  beforeEach(async () => {
    fake = await startFakeDaytona();
    rows = { findFirst: vi.fn(() => Promise.resolve(row())) };
    projectRows = { findFirst: vi.fn(() => Promise.resolve({ template: 'vite-react' })) };
    projects = {
      read: vi.fn(() => Promise.resolve({ createdAt: START, id: REF.projectId, name: 'P' })),
    };
    lifecycle = { touch: vi.fn(() => Promise.resolve()) };
    service = build();
  });

  afterEach(async () => {
    expect(fake.requests.filter((request) => request.path.startsWith('/api/toolbox/'))).toEqual([]);
    await fake.close();
  });

  const seed = (name: string, content: string) =>
    fake.workspace.set(`${fake.workDir}/${name}`, { content: Buffer.from(content), kind: 'file' });

  it("answers every port operation for a registered project in the port's own types", async () => {
    seed('real.txt', 'hello\nworld\n');
    fake.workspace.set(`${fake.workDir}/sub`, { kind: 'dir' });
    fake.workspace.set(`${fake.workDir}/link`, { kind: 'link', target: './real.txt' });
    fake.onExecute(() => ({ exitCode: 0, result: 'total 0\n' }));

    expect(await service.read(REF, 'real.txt')).toBe('hello\nworld\n');

    expect(await service.list(REF, '.')).toEqual([
      { kind: 'link', name: 'link', size: 12 },
      { kind: 'file', name: 'real.txt', size: 12 },
      { kind: 'directory', name: 'sub', size: 4096 },
    ]);

    expect(
      await service.edit(REF, { path: 'real.txt', replace: 'there', search: 'world' }, CTX),
    ).toEqual({
      bytes: 12,
      diff: '--- a/real.txt\n+++ b/real.txt\n@@ -1,2 +1,2 @@\n hello\n-world\n+there\n',
    });
    expect(fake.workspace.get(`${fake.workDir}/real.txt`)).toEqual({
      content: Buffer.from('hello\nthere\n'),
      kind: 'file',
    });

    expect(await service.edit(REF, { content: '# hi\n', path: 'sub/new.md' }, CTX)).toEqual({
      bytes: 5,
      diff: '--- /dev/null\n+++ b/sub/new.md\n@@ -0,0 +1 @@\n+# hi\n',
    });

    expect(await service.exec(REF, 'ls -la', CTX)).toEqual({
      exitCode: 0,
      output: 'total 0\n',
      timedOut: false,
      truncated: false,
    });
    const execute = fake.requests.filter((request) => request.path.endsWith('/process/execute'));
    expect(JSON.parse(execute.at(-1)!.body)).toMatchObject({
      command: 'ls -la',
      cwd: fake.workDir,
      timeout: DEFAULT_DAYTONA_TIMINGS.execWallClockMs / 1000,
    });

    expect(await service.search(REF, { text: 'hello' })).toEqual([
      { line: 1, path: 'link', text: 'hello' },
      { line: 1, path: 'real.txt', text: 'hello' },
    ]);
    expect(await service.find(REF, { glob: '*.txt' })).toEqual(['real.txt']);
    expect(await service.find(REF, { glob: '*.md', path: 'sub' })).toEqual(['sub/new.md']);

    expect(projects.read).toHaveBeenCalledWith(REF.orgId, REF.projectId);
    expect(rows.findFirst).toHaveBeenCalledTimes(8);
  });

  it('register stamps state_entered_at, last_seen_at and the node from the lookup (014 FR-011)', async () => {
    const values = vi.fn(() => ({ returning: () => Promise.resolve([{ id: 'row-1' }]) }));
    const tx = { insert: () => ({ values }) } as unknown as TenantTransaction;

    const registered = await service.register(tx, {
      daytonaId: fake.sandboxId,
      orgId: REF.orgId,
      projectId: REF.projectId,
    });

    expect(registered).toEqual({ id: 'row-1', node: fake.runnerId, workspaceRoot: fake.workDir });
    expect(values).toHaveBeenCalledWith({
      daytonaId: fake.sandboxId,
      lastSeenAt: new Date(START),
      node: fake.runnerId,
      orgId: REF.orgId,
      projectId: REF.projectId,
      stateEnteredAt: new Date(START),
      workspaceRoot: fake.workDir,
    });
  });

  it('answers no-sandbox for a project with no row', async () => {
    rows.findFirst.mockResolvedValue(undefined);

    await expect(service.read(REF, 'real.txt')).rejects.toMatchObject({ kind: 'no-sandbox' });
    await expect(service.read(REF, 'real.txt')).rejects.toBeInstanceOf(SandboxGuardError);
    expect(fake.requests).toEqual([]);
  });

  it('answers sandbox-not-ready for a row whose workspace_root is still null', async () => {
    rows.findFirst.mockResolvedValue({ ...row(), workspaceRoot: null });

    await expect(service.read(REF, 'real.txt')).rejects.toMatchObject({
      kind: 'sandbox-not-ready',
    });
    expect(fake.requests).toEqual([]);
  });

  /** Spec 014 contract § 1: every port call is a sign of use, and the row must be settled. */
  describe('the lifecycle on resolve (014)', () => {
    it('touches the row on the tenant transaction before every call is served', async () => {
      seed('real.txt', 'x');

      await service.read(REF, 'real.txt');

      expect(lifecycle.touch).toHaveBeenCalledTimes(1);
      expect(lifecycle.touch).toHaveBeenCalledWith(
        { query: { projects: projectRows, sandboxes: rows } },
        REF,
      );
      expect(lifecycle.touch.mock.invocationCallOrder[0]).toBeLessThan(
        rows.findFirst.mock.invocationCallOrder[0]!,
      );
    });

    it('refuses a row in transition and a hibernated row as sandbox-not-ready, naming the state', async () => {
      rows.findFirst.mockResolvedValue({
        ...row(),
        transition: 'hibernating',
        transitionSince: new Date(START),
      });
      await expect(service.read(REF, 'real.txt')).rejects.toMatchObject({
        extensions: { transition: 'hibernating' },
        kind: 'sandbox-not-ready',
      });

      rows.findFirst.mockResolvedValue({
        ...row(),
        hibernatedAt: new Date(START),
        state: 'hibernated',
      });
      await expect(service.read(REF, 'real.txt')).rejects.toMatchObject({
        extensions: { state: 'hibernated' },
        kind: 'sandbox-not-ready',
      });
      expect(fake.requests).toEqual([]);
    });

    it('refuses a lost row as not ready, so the caller offers the wake that replaces it', async () => {
      rows.findFirst.mockResolvedValue({ ...row(), lostAt: new Date(START) });

      await expect(service.read(REF, 'real.txt')).rejects.toMatchObject({
        kind: 'sandbox-not-ready',
      });
      expect(fake.requests).toEqual([]);
    });
  });

  /** Spec 023 US4, contracts/preview-status-tool.md § 2: three shapes, because there are three truths. */
  describe('previewStatus (023)', () => {
    it('answers no port at all for a project whose template declares none', async () => {
      projectRows.findFirst.mockResolvedValue({ template: 'python' });

      expect(await service.previewStatus(REF)).toEqual({ port: null });
      // Nothing to look up: with no declared port the row has no entry that could answer.
      expect(rows.findFirst).not.toHaveBeenCalled();
      expect(fake.requests).toEqual([]);
    });

    it('answers a declared port that has never been observed as not observed, never as failed', async () => {
      rows.findFirst.mockResolvedValue({ ...row(), ports: {} });

      expect(await service.previewStatus(REF)).toEqual({ observed: null, port: 3000 });
      expect(fake.requests).toEqual([]);
    });

    it('answers the observed state and its timestamp for a hibernated sandbox, with no Daytona call', async () => {
      rows.findFirst.mockResolvedValue({
        ...row(),
        hibernatedAt: new Date(START),
        ports: { '3000': { observedAt: OBSERVED, state: 'listening' } },
        state: 'hibernated',
      });

      expect(await service.previewStatus(REF, CTX)).toEqual({
        observed: { at: OBSERVED, state: 'listening' },
        port: 3000,
      });
      // Neither of the two things `resolve` does to a row: no touch, and no refusal of a sleeper.
      expect(lifecycle.touch).not.toHaveBeenCalled();
      expect(fake.requests).toEqual([]);

      // The same row, asked the way every other method asks, is `sandbox-not-ready`.
      await expect(service.read(REF, 'real.txt')).rejects.toMatchObject({
        kind: 'sandbox-not-ready',
      });
    });
  });

  it('answers no-sandbox for an archived project', async () => {
    projects.read.mockRejectedValue(new NotFoundError('No such project.'));

    await expect(service.exec(REF, 'ls', CTX)).rejects.toMatchObject({ kind: 'no-sandbox' });
    expect(rows.findFirst).not.toHaveBeenCalled();
    expect(fake.requests).toEqual([]);
  });

  it('refuses every call as not configured when DAYTONA_API_URL is unset', async () => {
    // The module boots with neither variable — the env schema's "neither" case (spec 010 US5).
    const unconfigured = new SandboxService(
      { tx: { query: { projects: projectRows, sandboxes: rows } } } as unknown as TenantContext,
      projects as unknown as ProjectService,
      { record: vi.fn() } as unknown as AuditService,
      new DaytonaAdapter(
        { get: () => undefined } as unknown as ConfigService<Environment, true>,
        DEFAULT_DAYTONA_TIMINGS,
        new FakeClock(START),
      ),
      DEFAULT_DAYTONA_TIMINGS,
      new FakeClock(START),
      lifecycle as unknown as SandboxLifecycleService,
      new TemplateCatalogue(),
    );

    await expect(unconfigured.read(REF, 'a.txt')).rejects.toMatchObject({
      kind: 'not-configured',
      retryable: false,
    });
    await expect(unconfigured.read(REF, 'a.txt')).rejects.toBeInstanceOf(DaytonaError);
    expect(fake.requests).toEqual([]);
  });

  /** Every mutation names its run, its step and the epoch its lease was on (spec 010 US4, SC-003). */
  describe('mutation context', () => {
    const bad: [string, MutationContext | undefined][] = [
      ['missing', undefined],
      [
        'an operation id with no step',
        { leaseEpoch: 3, operationId: 'run-1' as `${string}/${string}` },
      ],
      ['an empty run', { leaseEpoch: 3, operationId: '/step-2' }],
      ['an empty step', { leaseEpoch: 3, operationId: 'run-1/' }],
      ['a non-integer epoch', { leaseEpoch: 1.5, operationId: 'run-1/step-2' }],
      ['a negative epoch', { leaseEpoch: -1, operationId: 'run-1/step-2' }],
    ];

    it.each(bad)('refuses a mutation with %s before any request is built', async (_label, ctx) => {
      seed('a.txt', 'hello\n');

      await expect(service.edit(REF, { content: 'x', path: 'a.txt' }, ctx!)).rejects.toMatchObject({
        kind: 'missing-mutation-context',
      });
      await expect(service.exec(REF, 'ls', ctx!)).rejects.toBeInstanceOf(SandboxGuardError);

      expect(fake.requests).toEqual([]);
      expect(rows.findFirst).not.toHaveBeenCalled();
    });

    it('carries the operation id and the epoch on every request of the operation', async () => {
      seed('a.txt', 'hello\n');
      fake.onExecute(() => ({ exitCode: 0, result: 'ok\n' }));

      await service.edit(REF, { path: 'a.txt', replace: 'there', search: 'hello' }, CTX);
      await service.exec(REF, 'ls', CTX);

      const toolbox = fake.requests.filter((request) => request.path.startsWith('/toolbox/'));
      // The jail's `realpath`, the `info`, the `download`, the `upload` and the `execute`.
      expect(toolbox.length).toBeGreaterThanOrEqual(5);
      for (const request of toolbox) {
        expect(request.headers['x-forge-operation-id']).toBe(CTX.operationId);
        expect(request.headers['x-forge-lease-epoch']).toBe(String(CTX.leaseEpoch));
      }
    });

    it('logs the sandbox id, the operation id and the epoch and never the key, file contents or command output', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      seed('a.txt', 'SECRET-FILE-BODY\n');
      fake.onExecute(() => ({ exitCode: 0, result: 'SECRET-OUTPUT\n' }));

      // One good call first, so the lookup is cached and the failure is the contextful execute.
      await service.exec(REF, 'ls', CTX);
      fake.failNext({ body: 'SECRET-OUTPUT', status: 500 });
      await expect(service.exec(REF, 'ls', CTX)).rejects.toBeInstanceOf(DaytonaError);

      expect(warn).toHaveBeenCalled();
      const line = String(warn.mock.calls.at(-1)![0]);
      expect(line).toContain(`daytonaId=${fake.sandboxId}`);
      expect(line).toContain(`operationId=${CTX.operationId}`);
      expect(line).toContain(`leaseEpoch=${CTX.leaseEpoch}`);
      for (const secret of [fake.apiKey, 'SECRET-FILE-BODY', 'SECRET-OUTPUT']) {
        expect(line).not.toContain(secret);
      }
    });
  });

  /** Every §04 guard against the fake (spec 010 US2, SC-002): a refusal leaves no mutating request. */
  describe('guards', () => {
    const requestsTo = (suffix: string) =>
      fake.requests.filter((request) => request.path.endsWith(suffix));
    const jailChecks = () =>
      requestsTo('/process/execute').filter((request) => request.body.includes('realpath -e'));

    it('refuses a path whose sandbox-side resolution leaves the root, and allows one that stays', async () => {
      seed('real.txt', 'hello\n');
      fake.workspace.set(`${fake.workDir}/escape`, { kind: 'link', target: '/etc/hostname' });
      fake.workspace.set(`${fake.workDir}/inside`, { kind: 'link', target: './real.txt' });

      await expect(service.read(REF, 'escape')).rejects.toMatchObject({ kind: 'path-escape' });
      expect(jailChecks()).toHaveLength(1);
      expect(fake.requests.filter((request) => request.path.includes('/files'))).toEqual([]);

      expect(await service.read(REF, 'inside')).toBe('hello\n');
      // Every call after the check names the resolved path, so a swapped link cannot redirect it.
      expect(requestsTo('/files/download').at(-1)!.query.path).toBe(`${fake.workDir}/real.txt`);
    });

    it('refuses a path that climbs out lexically before any request', async () => {
      await expect(service.read(REF, '../etc/hostname')).rejects.toMatchObject({
        kind: 'path-escape',
      });
      await expect(service.list(REF, '/etc')).rejects.toMatchObject({ kind: 'path-escape' });
      expect(fake.requests).toEqual([]);
    });

    it('resolves the parent for a new file and refuses when the parent escapes', async () => {
      fake.workspace.set(`${fake.workDir}/sub`, { kind: 'dir' });
      fake.workspace.set(`${fake.workDir}/out`, { kind: 'link', target: '/etc' });

      await expect(
        service.edit(REF, { content: 'x', path: 'out/new.txt' }, CTX),
      ).rejects.toMatchObject({ kind: 'path-escape' });
      expect(requestsTo('/files/upload')).toEqual([]);

      expect(await service.edit(REF, { content: 'x', path: 'sub/new.txt' }, CTX)).toMatchObject({
        bytes: 1,
      });
      expect(requestsTo('/files/upload').at(-1)!.query.path).toBe(`${fake.workDir}/sub/new.txt`);

      // A new file under directories that do not exist yet: the nearest existing ancestor is what
      // is jailed, so a missing level under an escaping link is still refused.
      await expect(
        service.edit(REF, { content: 'x', path: 'out/deeper/new.txt' }, CTX),
      ).rejects.toMatchObject({ kind: 'path-escape' });
      expect(requestsTo('/files/upload')).toHaveLength(1);
      expect(
        await service.edit(REF, { content: 'y', path: 'fresh/dir/new.txt' }, CTX),
      ).toMatchObject({ bytes: 1 });
      expect(requestsTo('/files/upload').at(-1)!.query.path).toBe(
        `${fake.workDir}/fresh/dir/new.txt`,
      );

      // An anchored edit needs a file to anchor in.
      await expect(
        service.edit(REF, { path: 'sub/missing.txt', replace: 'b', search: 'a' }, CTX),
      ).rejects.toMatchObject({ kind: 'path-not-found' });
      expect(requestsTo('/files/upload')).toHaveLength(2);
    });

    it('refuses a new file when not even the workspace root resolves', async () => {
      fake.workspace.clear();

      await expect(
        service.edit(REF, { content: 'x', path: 'a/b/new.txt' }, CTX),
      ).rejects.toMatchObject({ kind: 'path-not-found' });
      expect(requestsTo('/files/upload')).toEqual([]);
    });

    it('refuses an edit whose current or resulting file exceeds 2 MB', async () => {
      service = build({ fileCapBytes: 16 });
      seed('big.txt', 'x'.repeat(17));
      seed('small.txt', 'x');

      await expect(
        service.edit(REF, { path: 'big.txt', replace: 'y', search: 'x' }, CTX),
      ).rejects.toMatchObject({ kind: 'file-too-large' });
      await expect(
        service.edit(REF, { content: 'y'.repeat(17), path: 'small.txt' }, CTX),
      ).rejects.toMatchObject({ kind: 'file-too-large' });
      await expect(
        service.edit(REF, { path: 'small.txt', replace: 'y'.repeat(17), search: 'x' }, CTX),
      ).rejects.toMatchObject({ kind: 'file-too-large' });
      expect(requestsTo('/files/upload')).toEqual([]);
      expect(fake.workspace.get(`${fake.workDir}/small.txt`)).toEqual({
        content: Buffer.from('x'),
        kind: 'file',
      });
    });

    it('refuses a read over 2 MB', async () => {
      service = build({ fileCapBytes: 16 });
      seed('big.txt', 'x'.repeat(17));
      fake.workspace.set(`${fake.workDir}/dir`, { kind: 'dir' });

      await expect(service.read(REF, 'big.txt')).rejects.toMatchObject({ kind: 'file-too-large' });
      await expect(service.read(REF, 'dir')).rejects.toMatchObject({ kind: 'not-a-file' });
      await expect(service.read(REF, 'nope')).rejects.toMatchObject({ kind: 'path-not-found' });
      expect(requestsTo('/files/download')).toEqual([]);
    });

    it('downloads bytes under the bundle cap, jailed and fenced like read (016)', async () => {
      service = build({ bundleCapBytes: 16, fileCapBytes: 4 });
      seed('bundle.bin', 'x'.repeat(16));
      seed('big.bin', 'x'.repeat(17));

      expect(await service.download(REF, 'bundle.bin', CTX)).toEqual(Buffer.from('x'.repeat(16)));
      await expect(service.download(REF, 'big.bin', CTX)).rejects.toMatchObject({
        kind: 'file-too-large',
      });
      await expect(service.download(REF, '../etc/passwd', CTX)).rejects.toMatchObject({
        kind: 'path-escape',
      });
      await expect(
        service.download(REF, 'bundle.bin', undefined as unknown as MutationContext),
      ).rejects.toMatchObject({ kind: 'missing-mutation-context' });
      expect(requestsTo('/files/download')).toHaveLength(1);
    });

    it('uploads a bundle under `.git/` and the cap, jailed like download (018)', async () => {
      service = build({ bundleCapBytes: 16 });
      fake.workspace.set(`${fake.workDir}/.git`, { kind: 'dir' });

      await expect(
        service.upload(REF, 'forge-pull.bundle', Buffer.from('x'), CTX),
      ).rejects.toMatchObject({ kind: 'path-outside-git' });
      await expect(
        service.upload(REF, '.git/../x.bundle', Buffer.from('x'), CTX),
      ).rejects.toMatchObject({ kind: 'path-outside-git' });
      await expect(
        service.upload(REF, '.git/forge-pull.bundle', Buffer.from('x'.repeat(17)), CTX),
      ).rejects.toMatchObject({ kind: 'bundle-too-large' });
      await expect(
        service.upload(
          REF,
          '.git/forge-pull.bundle',
          Buffer.from('x'),
          undefined as unknown as MutationContext,
        ),
      ).rejects.toMatchObject({ kind: 'missing-mutation-context' });
      expect(requestsTo('/files/upload')).toEqual([]);

      await service.upload(REF, '.git/forge-pull.bundle', Buffer.from('x'.repeat(16)), CTX);
      expect(requestsTo('/files/upload').at(-1)!.query.path).toBe(
        `${fake.workDir}/.git/forge-pull.bundle`,
      );
    });

    it('refuses an anchor that matches nowhere and one that matches twice, naming which', async () => {
      seed('a.txt', 'one two one\n');

      await expect(
        service.edit(REF, { path: 'a.txt', replace: 'x', search: 'three' }, CTX),
      ).rejects.toMatchObject({ kind: 'anchor-not-found' });
      await expect(
        service.edit(REF, { path: 'a.txt', replace: 'x', search: 'one' }, CTX),
      ).rejects.toMatchObject({ extensions: { kind: 'anchor-ambiguous', matches: 2 } });
      expect(requestsTo('/files/upload')).toEqual([]);
    });

    it('refuses a program off the allowlist and a command carrying a shell operator', async () => {
      await expect(service.exec(REF, 'curl http://x', CTX)).rejects.toMatchObject({
        kind: 'command-not-allowed',
      });
      await expect(service.exec(REF, 'ls; rm -rf /', CTX)).rejects.toMatchObject({
        kind: 'command-not-allowed',
      });
      expect(requestsTo('/process/execute')).toEqual([]);
    });

    it('stops waiting at the wall clock and reports a timeout with no output', async () => {
      service = build({ execWallClockMs: 2_000 });
      fake.onExecute(() => ({ status: 408 }));

      expect(await service.exec(REF, 'node slow.js', CTX)).toEqual({
        output: '',
        timedOut: true,
        truncated: false,
      });
      expect(JSON.parse(requestsTo('/process/execute').at(-1)!.body)).toMatchObject({
        command: 'node slow.js',
        cwd: fake.workDir,
        timeout: 2,
      });
    });

    it('keeps head and tail of an output over 64 KB with a marker naming the dropped bytes', async () => {
      service = build({ outputCapBytes: 8 });
      fake.onExecute(() => ({ exitCode: 0, result: '0123456789' }));

      expect(await service.exec(REF, 'cat big', CTX)).toEqual({
        exitCode: 0,
        output: '0123\n…[2 bytes dropped]…\n6789',
        timedOut: false,
        truncated: true,
      });
    });

    it('caps search results and excludes node_modules, .git, dist and binaries', async () => {
      service = build({ searchCap: 5 });
      for (let index = 0; index < 8; index += 1) seed(`src/f${index}.ts`, 'needle\n');
      seed('node_modules/dep/index.js', 'needle\n');
      seed('.git/HEAD', 'needle\n');
      seed('dist/out.js', 'needle\n');
      seed('src/blob.bin', 'needle\0\n');

      const matches = await service.search(REF, { text: 'needle' });
      expect(matches).toHaveLength(5);
      expect(matches.map((match) => match.path)).toEqual(
        ['f0', 'f1', 'f2', 'f3', 'f4'].map((name) => `src/${name}.ts`),
      );

      const names = await service.find(REF, { glob: '*' });
      expect(names).toHaveLength(5);
      expect(names.every((name) => name.startsWith('src/'))).toBe(true);
    });
  });
});
