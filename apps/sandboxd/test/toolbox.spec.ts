import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Config } from '../src/config.ts';
import type { ExecOpts, ExecOutcome } from '../src/docker.ts';
import { router } from '../src/http.ts';
import { Store } from '../src/store.ts';
import { registerToolboxRoutes } from '../src/toolbox.ts';
import { FakeDocker } from './fake-docker.ts';

let dir: string;
let store: Store;
let docker: FakeDocker;
let server: Server;
let base: string;

const out = (s: string | Buffer, exitCode = 0): ExecOutcome => ({
  timedOut: false,
  exitCode,
  output: Buffer.from(s),
  truncated: false,
});
const execs = () =>
  docker.calls.filter((c) => c.method === 'exec').map((c) => c.args[1] as ExecOpts);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sbxd-'));
  store = new Store(dir);
  docker = new FakeDocker();
  docker.containers.set('c1', { spec: {} as never, status: 'running' });
  docker.containers.set('c2', { spec: {} as never, status: 'exited' });
  const row = {
    image: 'i',
    class: 'project',
    labels: {},
    networkAllow: null,
    networkBlockAll: false,
    createdAt: 'x',
    queuedAt: null,
  } as const;
  store.insert({ ...row, id: 's1', containerId: 'c1', desired: 'started' });
  store.insert({ ...row, id: 's2', containerId: 'c2', desired: 'stopped' });
  const api = router('key');
  registerToolboxRoutes(api, { cfg: {} as Config, store, docker });
  server = createServer(api.handle);
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/toolbox`;
});
afterEach(() => {
  server.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = (method: string, path: string, body?: unknown, id = 's1') =>
  fetch(`${base}/${id}/${path}`, {
    method,
    headers: { authorization: 'Bearer key' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('toolbox', () => {
  it('work-dir', async () => {
    expect(await (await call('GET', 'work-dir')).json()).toEqual({ dir: '/home/daytona' });
  });

  it('passes a hostile path as one argv element', async () => {
    docker.execHandler = () => out('');
    await call('GET', `files/info?path=${encodeURIComponent('/x; rm -rf /')}`);
    expect(execs()[0]!.argv).toContain('/x; rm -rf /');
  });

  it('rejects bad paths and session ids', async () => {
    expect((await call('GET', 'files?path=rel')).status).toBe(400);
    expect((await call('GET', 'files')).status).toBe(400);
    expect((await call('GET', 'files?path=%2Fa%00b')).status).toBe(400);
    expect((await call('POST', 'process/session', { sessionId: 'a b' })).status).toBe(400);
    expect((await call('DELETE', 'process/session/a%20b')).status).toBe(400);
  });

  it('404s on a stopped or unknown sandbox, and requires auth', async () => {
    expect((await call('GET', 'work-dir', undefined, 's2')).status).toBe(404);
    expect((await call('GET', 'work-dir', undefined, 'nope')).status).toBe(404);
    expect((await fetch(`${base}/s1/work-dir`)).status).toBe(401);
  });

  it('list maps %Y d to isDir and skips unresolvable entries', async () => {
    docker.execHandler = () => out('d\t4096\tsub\0f\t12\ta.txt\0N\t0\tdangling\0');
    const res = await call('GET', 'files?path=/home/daytona');
    expect(await res.json()).toEqual([
      { name: 'sub', isDir: true, size: 4096 },
      { name: 'a.txt', isDir: false, size: 12 },
    ]);
  });

  it('maps guard exit codes to 404 and 400', async () => {
    docker.execHandler = () => out('', 44);
    expect((await call('GET', 'files?path=/x')).status).toBe(404);
    docker.execHandler = () => out('', 45);
    expect((await call('GET', 'files?path=/x')).status).toBe(400);
    expect((await call('GET', 'files/download?path=/x')).status).toBe(400);
    docker.execHandler = () => out('', 1);
    expect((await call('GET', 'files/info?path=/x')).status).toBe(404);
  });

  it('info parses stat output', async () => {
    docker.execHandler = () => out('regular file\t7\n');
    expect(await (await call('GET', 'files/info?path=/a/b.txt')).json()).toEqual({
      name: 'b.txt',
      isDir: false,
      size: 7,
    });
  });

  it('upload sends the file as stdin', async () => {
    docker.execHandler = () => out('');
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array([0, 1, 2, 255])]), 'x');
    const res = await fetch(`${base}/s1/files/upload?path=/home/daytona/a/b.bin`, {
      method: 'POST',
      headers: { authorization: 'Bearer key' },
      body: form,
    });
    expect(res.status).toBe(200);
    expect([...execs()[0]!.stdin!]).toEqual([0, 1, 2, 255]);
    expect(execs()[0]!.argv).toContain('/home/daytona/a/b.bin');
  });

  it('find parses rg --json and search splits NUL paths', async () => {
    const m = (p: string, n: number, t: string) =>
      JSON.stringify({
        type: 'match',
        data: { path: { text: p }, lines: { text: t }, line_number: n },
      });
    docker.execHandler = () =>
      out(`${JSON.stringify({ type: 'begin' })}\n${m('/a/x.ts', 3, 'hi there\n')}\n`);
    expect(await (await call('GET', 'files/find?path=/a&pattern=hi')).json()).toEqual([
      { file: '/a/x.ts', line: 3, content: 'hi there' },
    ]);
    docker.execHandler = () => out('/a/x.ts\0/a/y.ts\0');
    expect(await (await call('GET', 'files/search?path=/a&pattern=*.ts')).json()).toEqual({
      files: ['/a/x.ts', '/a/y.ts'],
    });
  });

  it('execute: result, timeout 408, output cap, validation', async () => {
    docker.execHandler = () => out('C\n', 3);
    const res = await call('POST', 'process/execute', {
      command: 'x',
      cwd: '/w',
      envs: { A: 'b' },
      timeout: 5,
    });
    expect(await res.json()).toEqual({ exitCode: 3, result: 'C\n' });
    expect(execs()[0]).toMatchObject({
      argv: ['sh', '-c', 'x'],
      cwd: '/w',
      env: { A: 'b' },
      timeoutMs: 5000,
      maxOutputBytes: 1 << 20,
    });
    docker.execHandler = () => ({ timedOut: true });
    expect((await call('POST', 'process/execute', { command: 'x', timeout: 1 })).status).toBe(408);
    docker.execHandler = () => out('a'.repeat(2 << 20));
    const big = (await (
      await call('POST', 'process/execute', { command: 'x', timeout: 1 })
    ).json()) as { result: string };
    expect(big.result.length).toBeLessThanOrEqual(1 << 20);
    expect((await call('POST', 'process/execute', { command: 'x', timeout: 3601 })).status).toBe(
      400,
    );
    expect((await call('POST', 'process/execute', { timeout: 5 })).status).toBe(400);
  });

  it('sessions: create, exec detached, delete, unknown 404', async () => {
    expect(
      (await call('POST', 'process/session/s/exec', { command: 'x', runAsync: true })).status,
    ).toBe(404);
    expect((await call('POST', 'process/session', { sessionId: 's' })).status).toBe(200);
    expect(store.hasSession('s1', 's')).toBe(true);
    expect(
      (await call('POST', 'process/session/s/exec', { command: 'sleep 9', runAsync: true })).status,
    ).toBe(200);
    const d = docker.calls.find((c) => c.method === 'execDetached')!.args[1] as ExecOpts;
    expect(d.argv.at(-1)).toBe('sleep 9');
    expect(d.argv.join(' ')).toContain('/tmp/.sbx-session-s');
    docker.execHandler = () => out('');
    expect((await call('DELETE', 'process/session/s')).status).toBe(200);
    expect(store.hasSession('s1', 's')).toBe(false);
    expect(execs().at(-1)!.argv).toContain('s');
    expect((await call('DELETE', 'process/session/s')).status).toBe(404);
  });
});
