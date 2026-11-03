import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeClock } from '../../common/clock/fake-clock';
import type { Environment } from '../../config/environment';
import { type FakeDaytona, startFakeDaytona } from '../../../test/support/fake-daytona';
import { DaytonaAdapter } from './daytona.adapter';
import { DEFAULT_DAYTONA_TIMINGS, type DaytonaTimings } from './sandbox.constants';
import { DaytonaError, SandboxGuardError } from './sandbox.errors';
import type { MutationContext } from './sandbox.port';

const START = '2026-09-15T10:00:00.000Z';
const CTX: MutationContext = { leaseEpoch: 3, operationId: 'run-1/step-2' };

/**
 * The wire, against the loopback fake (research R8): the real `fetch`, real multipart, real URL
 * joining. Every case ends by proving the deprecated `/api/toolbox/` prefix was never touched
 * (FR-015) — the fake answers it `599`, but a request log is the only thing that proves absence.
 */
describe('DaytonaAdapter', () => {
  let fake: FakeDaytona;
  let clock: FakeClock;

  beforeEach(async () => {
    fake = await startFakeDaytona();
    clock = new FakeClock(START);
  });

  afterEach(async () => {
    expect(fake.requests.filter((request) => request.path.startsWith('/api/toolbox/'))).toEqual([]);
    await fake.close();
  });

  function adapter(
    env: Partial<Record<'DAYTONA_API_KEY' | 'DAYTONA_API_KEY_FILE' | 'DAYTONA_API_URL', string>> = {
      DAYTONA_API_KEY: fake.apiKey,
      DAYTONA_API_URL: fake.apiUrl,
    },
    timings: Partial<DaytonaTimings> = {},
  ): DaytonaAdapter {
    return new DaytonaAdapter(
      { get: (key: keyof typeof env) => env[key] } as unknown as ConfigService<Environment, true>,
      { ...DEFAULT_DAYTONA_TIMINGS, ...timings },
      clock,
    );
  }

  const seed = (name: string, content: string) =>
    fake.workspace.set(`${fake.workDir}/${name}`, { content: Buffer.from(content), kind: 'file' });

  it('reads, lists, edits, runs and searches through lookup → proxy-url → toolbox, never /api/toolbox', async () => {
    seed('hello.txt', 'hello world\n');
    fake.onExecute(({ command }) => ({ exitCode: 0, result: `ran: ${command}\n` }));
    const daytona = adapter();
    const root = fake.workDir;

    expect(await daytona.workDir(fake.sandboxId)).toBe(root);
    expect(await daytona.list(fake.sandboxId, root)).toEqual([
      { isDir: false, name: 'hello.txt', size: 12 },
    ]);
    expect(await daytona.info(fake.sandboxId, `${root}/hello.txt`)).toEqual({
      isDir: false,
      name: 'hello.txt',
      size: 12,
    });
    expect((await daytona.download(fake.sandboxId, `${root}/hello.txt`)).toString()).toBe(
      'hello world\n',
    );
    await daytona.upload(fake.sandboxId, `${root}/new.txt`, Buffer.from('fresh\n'), CTX);
    expect(fake.workspace.get(`${root}/new.txt`)).toEqual({
      content: Buffer.from('fresh\n'),
      kind: 'file',
    });
    expect(await daytona.find(fake.sandboxId, root, 'world')).toEqual([
      { content: 'hello world', file: `${root}/hello.txt`, line: 1 },
    ]);
    expect(await daytona.search(fake.sandboxId, root, '*.txt')).toEqual([
      `${root}/hello.txt`,
      `${root}/new.txt`,
    ]);
    expect(
      await daytona.execute(fake.sandboxId, { command: 'ls', cwd: root, timeoutSeconds: 120 }, CTX),
    ).toEqual({ exitCode: 0, result: 'ran: ls\n', timedOut: false });
    expect(await daytona.realpath(fake.sandboxId, `${root}/hello.txt`)).toBe(`${root}/hello.txt`);
    expect(await daytona.realpath(fake.sandboxId, `${root}/missing`)).toBeUndefined();

    const toolbox = `/toolbox/${fake.sandboxId}`;
    expect(fake.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      `GET /api/sandbox/${fake.sandboxId}`,
      `GET ${toolbox}/work-dir`,
      `GET ${toolbox}/files`,
      `GET ${toolbox}/files/info`,
      `GET ${toolbox}/files/download`,
      `POST ${toolbox}/files/upload`,
      `GET ${toolbox}/files/find`,
      `GET ${toolbox}/files/search`,
      `POST ${toolbox}/process/execute`,
      `POST ${toolbox}/process/execute`,
      `POST ${toolbox}/process/execute`,
    ]);
    const execute = fake.requests.find((request) => request.path.endsWith('/process/execute'))!;
    expect(JSON.parse(execute.body)).toEqual({
      command: 'ls',
      cwd: root,
      envs: { LC_ALL: 'C' },
      timeout: 120,
    });
  });

  it('caches the lookup for lookupTtlMs and re-looks-up once on a proxy 404', async () => {
    const daytona = adapter(undefined, { lookupTtlMs: 30_000 });
    const lookups = () =>
      fake.requests.filter((request) => request.path === `/api/sandbox/${fake.sandboxId}`).length;

    await daytona.workDir(fake.sandboxId);
    await daytona.workDir(fake.sandboxId);
    expect(lookups()).toBe(1);

    clock.advance(30_001);
    await daytona.workDir(fake.sandboxId);
    expect(lookups()).toBe(2);

    fake.failNext({ status: 404 });
    expect(await daytona.workDir(fake.sandboxId)).toBe(fake.workDir);
    expect(lookups()).toBe(3);
    expect(fake.requests.slice(-3).map((request) => request.path)).toEqual([
      `/toolbox/${fake.sandboxId}/work-dir`,
      `/api/sandbox/${fake.sandboxId}`,
      `/toolbox/${fake.sandboxId}/work-dir`,
    ]);

    // A 404 on the lookup itself is the sandbox being gone; nothing to re-look-up.
    await expect(daytona.workDir('no-such-sandbox')).rejects.toMatchObject({
      kind: 'sandbox-not-found',
      retryable: false,
    });
  });

  it('sends the operation id and the lease epoch on every mutation', async () => {
    seed('hello.txt', 'hello world\n');
    fake.onExecute(({ command }) => ({ exitCode: 0, result: `${command}\n` }));
    const daytona = adapter();
    const root = fake.workDir;

    // A mutation: the upload, the execute, and the jail's own `realpath` all carry the context.
    await daytona.upload(fake.sandboxId, `${root}/new.txt`, Buffer.from('fresh\n'), CTX);
    await daytona.execute(fake.sandboxId, { command: 'ls', cwd: root, timeoutSeconds: 120 }, CTX);
    await daytona.realpath(fake.sandboxId, `${root}/hello.txt`, CTX);

    const forged = fake.requests.filter(
      (request) => request.path !== `/api/sandbox/${fake.sandboxId}`,
    );
    expect(forged.map((request) => request.path.split('/').slice(3).join('/'))).toEqual([
      'files/upload',
      'process/execute',
      'process/execute',
    ]);
    for (const request of forged) {
      expect(request.headers['x-forge-operation-id']).toBe('run-1/step-2');
      expect(request.headers['x-forge-lease-epoch']).toBe('3');
    }

    // A read given the context carries it too; one taking none sends neither header.
    fake.requests.length = 0;
    await daytona.info(fake.sandboxId, `${root}/hello.txt`, CTX);
    await daytona.download(fake.sandboxId, `${root}/hello.txt`);

    const [withCtx, withoutCtx] = fake.requests;
    expect(withCtx!.headers['x-forge-operation-id']).toBe('run-1/step-2');
    expect(withCtx!.headers['x-forge-lease-epoch']).toBe('3');
    expect(withoutCtx!.headers['x-forge-operation-id']).toBeUndefined();
    expect(withoutCtx!.headers['x-forge-lease-epoch']).toBeUndefined();
  });

  /**
   * The seven failure classes (spec 010 US5, SC-006, research R3). Each case is set up against a
   * fresh adapter, so the failing request is the lookup — the first call every operation makes.
   */
  describe('failure classes', () => {
    interface Case {
      readonly arrange: () => DaytonaAdapter;
      readonly kind: string;
      readonly label: string;
      readonly retryable: boolean;
    }

    const withFailure = (status: number): DaytonaAdapter => {
      fake.failNext({ status });
      return adapter();
    };

    const cases: Case[] = [
      {
        arrange: () => adapter({}),
        kind: 'not-configured',
        label: 'no DAYTONA_API_URL',
        retryable: false,
      },
      {
        arrange: () => {
          const daytona = adapter();
          void fake.close();
          return daytona;
        },
        kind: 'unreachable',
        label: 'a closed port',
        retryable: true,
      },
      {
        arrange: () => {
          fake.hang();
          return adapter(undefined, { requestTimeoutMs: 50 });
        },
        kind: 'unreachable',
        label: 'a request that is never answered',
        retryable: true,
      },
      { arrange: () => withFailure(401), kind: 'unauthorised', label: 'a 401', retryable: false },
      { arrange: () => withFailure(403), kind: 'unauthorised', label: 'a 403', retryable: false },
      {
        arrange: () => withFailure(404),
        kind: 'sandbox-not-found',
        label: 'a 404 on the lookup',
        retryable: false,
      },
      {
        arrange: () => {
          fake.sandboxState('stopped');
          return adapter();
        },
        kind: 'sandbox-not-running',
        label: 'a stopped sandbox',
        retryable: false,
      },
      { arrange: () => withFailure(500), kind: 'upstream', label: 'a 500', retryable: true },
      {
        arrange: () => {
          fake.malformed();
          return adapter();
        },
        kind: 'malformed',
        label: 'a body that fits no schema',
        retryable: false,
      },
    ];

    it.each(cases)('classifies $label as $kind', async ({ arrange, kind, retryable }) => {
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const daytona = arrange();

      await expect(daytona.workDir(fake.sandboxId)).rejects.toMatchObject({
        kind,
        name: 'DaytonaError',
        retryable,
      });
    });

    it('never builds a request when Daytona is not configured', async () => {
      await expect(adapter({}).workDir(fake.sandboxId)).rejects.toMatchObject({
        kind: 'not-configured',
      });
      // Not a failed call — no call at all: the constructor already knows there is no URL.
      expect(fake.requests).toEqual([]);
    });

    it('treats a daemon 404 on files/info as path-not-found and a 400 on download as not-a-file', async () => {
      fake.workspace.set(`${fake.workDir}/dir`, { kind: 'dir' });
      const daytona = adapter();

      // A guard result is the caller's answer, not a wire failure: a `SandboxGuardError`, and
      // no `warn` line, because nothing failed.
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      await expect(daytona.info(fake.sandboxId, `${fake.workDir}/missing`)).rejects.toMatchObject({
        kind: 'path-not-found',
      });
      await expect(daytona.download(fake.sandboxId, `${fake.workDir}/dir`)).rejects.toBeInstanceOf(
        SandboxGuardError,
      );
      expect(warn).not.toHaveBeenCalled();
    });
  });

  /**
   * The seven lifecycle calls of 014 (contracts/sandbox-lifecycle.md § 5, research R1/R2 "Landed
   * as"): the control plane under `{api}/sandbox`, never the proxy.
   */
  describe('lifecycle calls', () => {
    it('describe returns the dto in any state where lookup would refuse', async () => {
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      fake.sandboxState('stopped');
      const daytona = adapter();

      await expect(daytona.describe(fake.sandboxId)).resolves.toMatchObject({
        id: fake.sandboxId,
        labels: {},
        runnerId: fake.runnerId,
        state: 'stopped',
      });
      await expect(daytona.lookup(fake.sandboxId)).rejects.toMatchObject({
        kind: 'sandbox-not-running',
      });
      await expect(daytona.describe('no-such-sandbox')).rejects.toMatchObject({
        kind: 'sandbox-not-found',
      });
    });

    it('create posts snapshot, labels and both intervals at zero, and returns the creating dto', async () => {
      const daytona = adapter();
      const labels = { 'forge.kind': 'pool', 'forge.owner': 'forge-test' };

      const dto = await daytona.create({ labels, snapshot: 'daytonaio/sandbox:0.5.0-slim' });
      expect(dto).toMatchObject({ labels, state: 'creating' });
      expect(typeof dto.id).toBe('string');

      const request = fake.requests.at(-1)!;
      expect(`${request.method} ${request.path}`).toBe('POST /api/sandbox');
      expect(JSON.parse(request.body)).toEqual({
        autoArchiveInterval: 0,
        autoStopInterval: 0,
        labels,
        snapshot: 'daytonaio/sandbox:0.5.0-slim',
      });

      fake.settle(dto.id);
      expect((await daytona.describe(dto.id)).state).toBe('started');
    });

    it('stop and start check the status only and ignore the body', async () => {
      const daytona = adapter();

      await expect(daytona.stop(fake.sandboxId)).resolves.toBeUndefined();
      expect((await daytona.describe(fake.sandboxId)).state).toBe('stopping');
      fake.settle(fake.sandboxId);
      expect((await daytona.describe(fake.sandboxId)).state).toBe('stopped');

      // A bare 204 is as good as the dto: the adapter reads nothing from the body.
      fake.refuseNext('start', 204);
      await expect(daytona.start(fake.sandboxId)).resolves.toBeUndefined();
      await daytona.start(fake.sandboxId);
      expect((await daytona.describe(fake.sandboxId)).state).toBe('started');

      expect(
        fake.requests.filter((request) => request.method === 'POST').map((request) => request.path),
      ).toEqual([
        `/api/sandbox/${fake.sandboxId}/stop`,
        `/api/sandbox/${fake.sandboxId}/start`,
        `/api/sandbox/${fake.sandboxId}/start`,
      ]);
    });

    it('remove forces, treats 404 as already gone and 409 as retryable upstream', async () => {
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const daytona = adapter();

      fake.refuseNext('remove', 409);
      await expect(daytona.remove(fake.sandboxId)).rejects.toMatchObject({
        kind: 'upstream',
        retryable: true,
        status: 409,
      });

      await expect(daytona.remove(fake.sandboxId)).resolves.toBeUndefined();
      expect(fake.requests.at(-1)).toMatchObject({
        method: 'DELETE',
        path: `/api/sandbox/${fake.sandboxId}`,
        query: { force: 'true' },
      });

      // Gone: the second remove answers 404, which is success; describe says not-found.
      await expect(daytona.remove(fake.sandboxId)).resolves.toBeUndefined();
      await expect(daytona.describe(fake.sandboxId)).rejects.toMatchObject({
        kind: 'sandbox-not-found',
      });
    });

    it('setLabels PUTs { labels } and the map is replaced, not merged', async () => {
      const daytona = adapter();
      await daytona.setLabels(fake.sandboxId, { 'forge.owner': 'a', 'forge.project': 'p1' });
      await daytona.setLabels(fake.sandboxId, { 'forge.owner': 'a' });

      const request = fake.requests.at(-2)!;
      expect(`${request.method} ${request.path}`).toBe(`PUT /api/sandbox/${fake.sandboxId}/labels`);
      expect(JSON.parse(request.body)).toEqual({
        labels: { 'forge.owner': 'a', 'forge.project': 'p1' },
      });
      expect((await daytona.describe(fake.sandboxId)).labels).toEqual({ 'forge.owner': 'a' });
    });

    it('listByLabels URL-encodes the JSON filter and follows nextCursor to the end', async () => {
      fake.seedSandbox({ id: 'mine-1', labels: { 'forge.owner': 'me' } });
      fake.seedSandbox({ id: 'mine-2', labels: { 'forge.kind': 'pool', 'forge.owner': 'me' } });
      fake.seedSandbox({ id: 'mine-3', labels: { 'forge.owner': 'me' }, state: 'stopped' });
      fake.seedSandbox({ id: 'theirs', labels: { 'forge.owner': 'you' } });
      const daytona = adapter();

      const mine = await daytona.listByLabels({ 'forge.owner': 'me' });
      expect(mine.map((dto) => dto.id).sort()).toEqual(['mine-1', 'mine-2', 'mine-3']);
      expect(mine.find((dto) => dto.id === 'mine-3')).toMatchObject({ state: 'stopped' });
      expect(await daytona.listByLabels({ 'forge.owner': 'nobody' })).toEqual([]);

      const lists = fake.requests.filter((request) => request.path === '/api/sandbox');
      expect(lists.length).toBeGreaterThan(2); // the fake pages two at a time: the cursor was followed
      for (const request of lists) {
        expect(request.method).toBe('GET');
        expect(request.url).toContain('labels=%7B%22forge.owner%22%3A%22');
      }
      expect(lists.map((request) => request.query.labels)).toContain(
        JSON.stringify({ 'forge.owner': 'me' }),
      );
      expect(lists.some((request) => request.query.cursor !== undefined)).toBe(true);
    });

    it('snapshotSandbox posts { name }, ignores the sandbox dto and refuses a destroying sandbox', async () => {
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const daytona = adapter();

      await expect(daytona.snapshotSandbox(fake.sandboxId, 'forge-tpl-x')).resolves.toBeUndefined();
      expect(fake.requests.at(-1)).toMatchObject({
        body: JSON.stringify({ name: 'forge-tpl-x' }),
        method: 'POST',
        path: `/api/sandbox/${fake.sandboxId}/snapshot`,
      });
      expect(fake.snapshots.get('forge-tpl-x')).toEqual({
        errorReason: null,
        name: 'forge-tpl-x',
        state: 'pending',
      });

      fake.sandboxState('destroying');
      await expect(daytona.snapshotSandbox(fake.sandboxId, 'forge-tpl-y')).rejects.toMatchObject({
        kind: 'upstream',
        retryable: true,
        status: 409,
      });
    });

    it('describeSnapshot answers null on 404 and the dto through pending, active and build_failed', async () => {
      const daytona = adapter();

      await expect(daytona.describeSnapshot('forge-tpl-x')).resolves.toBeNull();

      await daytona.snapshotSandbox(fake.sandboxId, 'forge-tpl-x');
      await expect(daytona.describeSnapshot('forge-tpl-x')).resolves.toMatchObject({
        errorReason: null,
        state: 'pending',
      });
      fake.settleSnapshot('forge-tpl-x');
      await expect(daytona.describeSnapshot('forge-tpl-x')).resolves.toMatchObject({
        state: 'active',
      });
      fake.failSnapshot('forge-tpl-x', 'disk full');
      await expect(daytona.describeSnapshot('forge-tpl-x')).resolves.toMatchObject({
        errorReason: 'disk full',
        state: 'build_failed',
      });
      expect(fake.requests.at(-1)).toMatchObject({
        method: 'GET',
        path: '/api/snapshots/forge-tpl-x',
      });
    });

    it('removeSnapshot treats 404 as gone, 409 as retryable snapshot-busy and 403 as snapshot-forbidden', async () => {
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const daytona = adapter();
      await daytona.snapshotSandbox(fake.sandboxId, 'forge-tpl-x');

      fake.refuseNext('remove-snapshot', 409);
      await expect(daytona.removeSnapshot('forge-tpl-x')).rejects.toMatchObject({
        kind: 'snapshot-busy',
        retryable: true,
        status: 409,
      });

      // The bootstrap key without delete:snapshots (research R1 "Landed as"): not swallowed.
      fake.refuseNext('remove-snapshot', 403);
      await expect(daytona.removeSnapshot('forge-tpl-x')).rejects.toMatchObject({
        kind: 'snapshot-forbidden',
        message: expect.stringContaining('delete:snapshots') as string,
        retryable: false,
        status: 403,
      });
      expect(fake.snapshots.has('forge-tpl-x')).toBe(true);

      await expect(daytona.removeSnapshot('forge-tpl-x')).resolves.toBeUndefined();
      expect(fake.requests.at(-1)).toMatchObject({
        method: 'DELETE',
        path: '/api/snapshots/forge-tpl-x',
      });
      expect(fake.snapshots.has('forge-tpl-x')).toBe(false);

      // Gone: the second remove answers 404, which is success.
      await expect(daytona.removeSnapshot('forge-tpl-x')).resolves.toBeUndefined();
      await expect(daytona.describeSnapshot('forge-tpl-x')).resolves.toBeNull();
    });

    it('previewOrigin reads the signed per-port origin with the ttl, drops the echoes and refuses an unknown sandbox', async () => {
      const daytona = adapter();

      const origin = await daytona.previewOrigin(fake.sandboxId, 5173, 30);
      expect(origin.upstreamToken).toMatch(/^preview-5173-\d+$/);
      expect(origin.upstream).toBe(`http://5173-${origin.upstreamToken}.proxy.localhost:4000`);
      expect(Object.keys(origin).sort()).toEqual(['upstream', 'upstreamToken']);
      expect(fake.requests.at(-1)).toMatchObject({
        method: 'GET',
        path: `/api/sandbox/${fake.sandboxId}/ports/5173/signed-preview-url`,
        query: { expiresInSeconds: '30' },
      });
      // Never the unsigned route: its token is the sandbox-lifetime credential (research R19).
      expect(fake.requests.some((request) => request.path.endsWith('/preview-url'))).toBe(false);

      await expect(daytona.previewOrigin('no-such-sandbox', 5173, 30)).rejects.toMatchObject({
        kind: 'sandbox-not-found',
      });
    });

    it('none of the lifecycle calls goes through the toolbox proxy', async () => {
      const daytona = adapter();
      await daytona.describe(fake.sandboxId);
      await daytona.setLabels(fake.sandboxId, { 'forge.owner': 'a' });
      await daytona.listByLabels({ 'forge.owner': 'a' });
      await daytona.stop(fake.sandboxId);
      await daytona.start(fake.sandboxId);
      await daytona.snapshotSandbox(fake.sandboxId, 'forge-tpl-x');
      await daytona.describeSnapshot('forge-tpl-x');
      await daytona.removeSnapshot('forge-tpl-x');
      await daytona.remove(fake.sandboxId);
      expect(
        fake.requests.every((request) => /^\/api\/s(andbox|napshots)/.test(request.path)),
      ).toBe(true);
    });
  });

  it('sends Authorization: Bearer on every request and never logs the key', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const daytona = adapter();

    await daytona.workDir(fake.sandboxId);
    fake.failNext({ body: `leaked ${fake.apiKey}`, status: 500 });
    await expect(daytona.workDir(fake.sandboxId)).rejects.toBeInstanceOf(DaytonaError);

    expect(fake.requests.length).toBeGreaterThanOrEqual(3);
    for (const request of fake.requests) {
      expect(request.headers.authorization).toBe(`Bearer ${fake.apiKey}`);
      expect(request.path).not.toContain(fake.apiKey);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]![0]);
    expect(line).toContain('status=500');
    expect(line).toContain('kind=upstream');
    expect(line).not.toContain(fake.apiKey);
    expect(line).not.toContain('leaked');

    // A wrong key is `unauthorised`, and the line still says only the status and the class.
    const wrongKey = adapter({ DAYTONA_API_KEY: 'dtn_wrong', DAYTONA_API_URL: fake.apiUrl });
    await expect(wrongKey.workDir(fake.sandboxId)).rejects.toMatchObject({
      kind: 'unauthorised',
      retryable: false,
    });
    expect(String(warn.mock.calls.at(-1)![0])).not.toContain('dtn_wrong');
  });

  describe('DAYTONA_API_KEY_FILE', () => {
    it('reads the key from the file once, trimmed, and sends it as the bearer', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'daytona-key-'));
      const file = join(dir, 'key');
      writeFileSync(
        file,
        `${fake.apiKey}
`,
      );
      try {
        const daytona = adapter({ DAYTONA_API_KEY_FILE: file, DAYTONA_API_URL: fake.apiUrl });
        rmSync(file); // construction already read it
        expect(await daytona.workDir(fake.sandboxId)).toBe(fake.workDir);
      } finally {
        rmSync(dir, { force: true, recursive: true });
      }
    });

    it('fails at construction, naming the path, when the file is missing', () => {
      expect(() =>
        adapter({ DAYTONA_API_KEY_FILE: '/nonexistent/key', DAYTONA_API_URL: fake.apiUrl }),
      ).toThrow(/DAYTONA_API_KEY_FILE \/nonexistent\/key is missing or unreadable/);
    });
  });
});
