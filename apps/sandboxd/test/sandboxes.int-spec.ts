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

const docker = new DockerodePort();
const up = await docker.ping();
if (!up) console.error('SANDBOXD-DOCKER-SKIP: docker not reachable, skipping integration tests');

describe.skipIf(!up)('sandbox lifecycle on real docker', () => {
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

  beforeAll(async () => {
    await docker.ensureNetwork('sbx-proj', { internal: false });
    dir = mkdtempSync(join(tmpdir(), 'sbxd-int-'));
    store = new Store(dir);
    const api = router('key');
    registerSandboxRoutes(api, {
      cfg,
      store,
      docker,
      admission: new Admission({ cfg, store, docker }),
    });
    server = createServer(api.handle);
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const call = (method: string, path: string, body?: unknown) =>
    fetch(base + path, {
      method,
      headers: { authorization: 'Bearer key' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const state = async (id: string) =>
    ((await (await call('GET', `/sandbox/${id}`)).json()) as { state: string }).state;
  async function waitFor(id: string, want: string, ms = 20_000) {
    const end = Date.now() + ms;
    let s = '';
    while (Date.now() < end) {
      s = await state(id);
      if (s === want) return;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`sandbox ${id} stuck in ${s}, wanted ${want}`);
  }

  it('create -> started -> stopped -> started -> deleted', async () => {
    const res = await call('POST', '/sandbox', { snapshot: 'forge/sandbox-base:1', labels: {} });
    const { id } = (await res.json()) as { id: string };
    try {
      await waitFor(id, 'started');
      await call('POST', `/sandbox/${id}/stop`);
      await waitFor(id, 'stopped');
      await call('POST', `/sandbox/${id}/start`);
      await waitFor(id, 'started');
    } finally {
      expect((await call('DELETE', `/sandbox/${id}?force=true`)).status).toBe(200);
    }
    expect((await call('GET', `/sandbox/${id}`)).status).toBe(404);
  }, 60_000);
});
