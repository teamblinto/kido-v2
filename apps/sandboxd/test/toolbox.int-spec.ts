import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Admission } from '../src/admission.ts';
import type { Config } from '../src/config.ts';
import { DockerodePort } from '../src/docker.ts';
import { router } from '../src/http.ts';
import { registerSandboxRoutes } from '../src/sandboxes.ts';
import { Store } from '../src/store.ts';
import { registerToolboxRoutes } from '../src/toolbox.ts';

const docker = new DockerodePort();
const up = await docker.ping();
if (!up) console.error('SANDBOXD-DOCKER-SKIP: docker not reachable, skipping integration tests');

describe.skipIf(!up)('toolbox on real docker', () => {
  const cfg = {
    nodeId: 'int',
    publicUrl: 'http://127.0.0.1:1',
    maxRunning: 5,
    minMemAvailableBytes: 0,
    imageAllow: ['forge/sandbox-base:1'],
    runtimeProject: 'runc',
    egressListen: { host: '172.30.0.1', port: 3988 },
    storageQuota: false,
  } as Config;
  let dir: string;
  let store: Store;
  let server: Server;
  let base: string;
  let id: string;

  const api = (method: string, path: string, body?: BodyInit | object) =>
    fetch(base + path, {
      method,
      headers: { authorization: 'Bearer key' },
      body: body === undefined || body instanceof FormData ? body : JSON.stringify(body),
    });
  const tb = (method: string, route: string, body?: BodyInit | object) =>
    api(method, `/toolbox/${encodeURIComponent(id)}/${route}`, body);
  const sh = async (command: string) =>
    (await (await tb('POST', 'process/execute', { command, timeout: 20 })).json()) as {
      exitCode: number;
      result: string;
    };

  beforeAll(async () => {
    await docker.ensureNetwork('sbx-proj', { internal: false });
    dir = mkdtempSync(join(tmpdir(), 'sbxd-int-'));
    store = new Store(dir);
    const r = router('key');
    registerSandboxRoutes(r, {
      cfg,
      store,
      docker,
      admission: new Admission({ cfg, store, docker }),
    });
    registerToolboxRoutes(r, { cfg, store, docker });
    server = createServer(r.handle);
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const created = (await (
      await api('POST', '/sandbox', { snapshot: 'forge/sandbox-base:1', labels: {} })
    ).json()) as { id: string; state: string };
    id = created.id;
    expect(created.state).toBe('started');
    const seed = await sh(
      'mkdir -p /home/daytona/t/sub /home/daytona/t/node_modules/m && ' +
        'printf "hello needle\\nsecond\\n" > /home/daytona/t/a.txt && ' +
        'echo needle > /home/daytona/t/sub/b.ts && echo needle > /home/daytona/t/node_modules/m/c.ts && ' +
        'ln -s /etc /home/daytona/l',
    );
    expect(seed.exitCode).toBe(0);
  });
  afterAll(async () => {
    if (id) await api('DELETE', `/sandbox/${encodeURIComponent(id)}`);
    server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('work-dir, upload then download round-trips binary, upload creates parents', async () => {
    expect(await (await tb('GET', 'work-dir')).json()).toEqual({ dir: '/home/daytona' });
    const bytes = Buffer.from([0, 1, 2, 255, 254, 10, 13, 0]);
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(bytes)]), 'b.bin');
    const up1 = await tb('POST', 'files/upload?path=/home/daytona/a/b.bin', form);
    expect(up1.status).toBe(200);
    const down = await tb('GET', 'files/download?path=/home/daytona/a/b.bin');
    expect(Buffer.from(await down.arrayBuffer())).toEqual(bytes);
    expect((await tb('GET', 'files/download?path=/home/daytona/a')).status).toBe(400);
    expect((await tb('GET', 'files/download?path=/home/daytona/none')).status).toBe(404);
  });

  it('list, info, find, search against a seeded tree', async () => {
    const list = (await (await tb('GET', 'files?path=/home/daytona/t')).json()) as {
      name: string;
      isDir: boolean;
    }[];
    expect(list.map((e) => [e.name, e.isDir]).sort()).toEqual([
      ['a.txt', false],
      ['node_modules', true],
      ['sub', true],
    ]);
    expect((await tb('GET', 'files?path=/home/daytona/none')).status).toBe(404);
    expect((await tb('GET', 'files?path=/home/daytona/t/a.txt')).status).toBe(400);

    expect(await (await tb('GET', 'files/info?path=/home/daytona/t/a.txt')).json()).toEqual({
      name: 'a.txt',
      isDir: false,
      size: 20,
    });
    expect((await tb('GET', 'files/info?path=/home/daytona/none')).status).toBe(404);

    const found = (await (
      await tb('GET', 'files/find?path=/home/daytona/t&pattern=needle')
    ).json()) as { file: string; line: number; content: string }[];
    expect(found.map((m) => m.file).sort()).toEqual([
      '/home/daytona/t/a.txt',
      '/home/daytona/t/sub/b.ts',
    ]);
    expect(found.find((m) => m.file.endsWith('a.txt'))).toEqual({
      file: '/home/daytona/t/a.txt',
      line: 1,
      content: 'hello needle',
    });
    expect((await tb('GET', 'files/find?path=/home/daytona/none&pattern=x')).status).toBe(404);

    expect(
      await (await tb('GET', 'files/search?path=/home/daytona/t&pattern=*.ts')).json(),
    ).toEqual({ files: ['/home/daytona/t/sub/b.ts'] });
  });

  it('execute: env, exit code, timeout kills the process', async () => {
    const r = await tb('POST', 'process/execute', {
      command: 'echo $LC_ALL; exit 3',
      envs: { LC_ALL: 'C' },
      timeout: 10,
    });
    expect(await r.json()).toEqual({ exitCode: 3, result: 'C\n' });
    const t = await tb('POST', 'process/execute', { command: 'sleep 5', timeout: 1 });
    expect(t.status).toBe(408);
    expect((await sh('ps -eo args | grep "[s]leep 5"; true')).result).toBe('');
  });

  it('sessions: start, visible in ps, delete kills it', async () => {
    expect((await tb('POST', 'process/session', { sessionId: 'sess.1' })).status).toBe(200);
    expect(
      (await tb('POST', 'process/session/sess.1/exec', { command: 'sleep 300', runAsync: true }))
        .status,
    ).toBe(200);
    await new Promise((r) => setTimeout(r, 500));
    expect((await sh('ps -eo args | grep "[s]leep 300"')).result).toContain('sleep 300');
    expect((await tb('DELETE', 'process/session/sess.1')).status).toBe(200);
    await new Promise((r) => setTimeout(r, 500));
    expect((await sh('ps -eo args | grep "[s]leep 300"; true')).result).toBe('');
    expect((await tb('DELETE', 'process/session/sess.1')).status).toBe(404);
  });

  it('follows links like the daemon (the API realpath jail refuses, not sandboxd)', async () => {
    const list = (await (await tb('GET', 'files?path=/home/daytona/l')).json()) as {
      name: string;
    }[];
    expect(list.map((e) => e.name)).toContain('passwd');
  });

  it('is 404 once the sandbox is stopped, and sessions are cleared', async () => {
    await tb('POST', 'process/session', { sessionId: 'left' });
    await api('POST', `/sandbox/${encodeURIComponent(id)}/stop`);
    expect((await tb('GET', 'work-dir')).status).toBe(404);
    expect(store.hasSession(id, 'left')).toBe(false);
  });
});
