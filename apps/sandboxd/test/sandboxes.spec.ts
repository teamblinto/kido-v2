import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Admission } from '../src/admission.ts';
import type { Config } from '../src/config.ts';
import { router } from '../src/http.ts';
import { registerSandboxRoutes } from '../src/sandboxes.ts';
import { Store } from '../src/store.ts';
import { FakeDocker } from './fake-docker.ts';

const cfg = {
  nodeId: 'n1',
  publicUrl: 'http://sandboxd.test:3986',
  maxRunning: 22,
  minMemAvailableBytes: 0,
  imageAllow: ['forge/sandbox-base:1'],
  runtimeProject: 'runc',
  egressListen: { host: '172.30.0.1', port: 3988 },
  storageQuota: false,
} as Config;

let dir: string;
let store: Store;
let docker: FakeDocker;
let server: Server;
let base: string;
let adm: Admission;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sbxd-'));
  store = new Store(dir);
  docker = new FakeDocker();
  docker.images.add('forge/sandbox-base:1');
  adm = new Admission({
    cfg,
    store,
    docker,
    memAvailable: () => Infinity,
    controlTimeoutMs: 100,
  });
  const api = router('key');
  registerSandboxRoutes(api, {
    cfg,
    store,
    docker,
    admission: adm,
    sys: {
      memAvailable: () => 123,
      statfs: () => Promise.resolve({ bsize: 10, blocks: 100, bfree: 40, bavail: 30 }),
    },
  });
  server = createServer(api.handle);
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => {
  server.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = (method: string, path: string, body?: unknown) =>
  fetch(base + path, {
    method,
    headers: { authorization: 'Bearer key', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** Create, then wait for the admission drain the handler only kicked off. */
const create = async (labels: Record<string, string> = {}) => {
  const res = await call('POST', '/sandbox', {
    snapshot: 'forge/sandbox-base:1',
    labels,
    autoArchiveInterval: 0,
    autoStopInterval: 0,
  });
  const dto = (await res.json()) as Record<string, unknown>;
  await adm.tick();
  return { res, dto };
};
const stateOf = async (id: string) =>
  ((await (await call('GET', `/sandbox/${id}`)).json()) as { state: string }).state;
const cidOf = (id: string) => store.get(id)!.containerId!;

describe('sandbox control plane', () => {
  it('create answers the dto the API parses, then the sandbox starts', async () => {
    const { res, dto } = await create({ a: 'b' });
    expect(res.status).toBe(200);
    expect(dto.id).toMatch(/^n1-[0-9a-f-]{36}$/);
    // shape of sandboxLookupSchema in apps/api daytona.schemas.ts
    expect(typeof dto.createdAt).toBe('string');
    expect(dto.labels).toEqual({ a: 'b' });
    expect(dto.runnerId).toBe('n1');
    expect(typeof dto.state).toBe('string');
    expect(new URL(dto.toolboxProxyUrl as string).href).toBe('http://sandboxd.test:3986/toolbox');
    const got = (await (await call('GET', `/sandbox/${dto.id as string}`)).json()) as {
      state: string;
    };
    expect(got.state).toBe('started');
  });

  it('rejects an unknown, non-allow-listed snapshot with 400', async () => {
    const res = await call('POST', '/sandbox', { snapshot: 'nope', labels: {} });
    expect(res.status).toBe(400);
  });

  it('uses a committed forge-snap image over the allow-list', async () => {
    docker.images.add('forge-snap/mine:latest');
    const res = await call('POST', '/sandbox', { snapshot: 'mine', labels: {} });
    expect(res.status).toBe(200);
    expect([...docker.containers.values()][0]!.spec.image).toBe('forge-snap/mine:latest');
  });

  it('image allow-list: forge/ prefix and exact entries only', async () => {
    docker.images.add('forge/other/img');
    docker.images.add('forge-snap/foo:latest');
    const post = (snapshot: string) => call('POST', '/sandbox', { snapshot, labels: {} });
    expect((await post('forge/sandbox-base:1')).status).toBe(200);
    expect((await post('forge/other/img')).status).toBe(200);
    expect((await post('forge-snap/foo:latest')).status).toBe(200);
    for (const bad of [
      'docker.io/library/alpine',
      'forge/../x',
      'forge/a/../x',
      'forge/a//b',
      'forge/a/-x',
      'forge/Upper',
      'forge/has space',
      'alpine',
    ]) {
      expect([bad, (await post(bad)).status]).toEqual([bad, 400]);
    }
  });

  it('removes the container when the row cannot be inserted', async () => {
    vi.spyOn(store, 'insert').mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const res = await call('POST', '/sandbox', { snapshot: 'forge/sandbox-base:1', labels: {} });
    expect(res.status).toBe(500);
    expect(docker.containers.size).toBe(0);
  });

  it('start on a running sandbox at capacity stays started', async () => {
    const { dto } = await create();
    const id = dto.id as string;
    cfg.maxRunning = 1;
    try {
      expect((await call('POST', `/sandbox/${id}/start`)).status).toBe(200);
      const got = (await (await call('GET', `/sandbox/${id}`)).json()) as { state: string };
      expect(got.state).toBe('started');
    } finally {
      cfg.maxRunning = 22;
    }
  });

  it('reports error once start has failed for good', async () => {
    docker.start = () => Promise.reject(new Error('boom'));
    const { dto } = await create();
    expect(await stateOf(dto.id as string)).toBe('error');
  });

  it('a container that exited on its own reports stopped, and start brings it back', async () => {
    const id = (await create()).dto.id as string;
    docker.containers.get(cidOf(id))!.status = 'exited';
    expect(await stateOf(id)).toBe('stopped');
    await call('POST', `/sandbox/${id}/start`);
    await adm.tick();
    expect(await stateOf(id)).toBe('started');
  });

  it('a row whose container is gone reports error', async () => {
    const id = (await create()).dto.id as string;
    docker.containers.delete(cidOf(id));
    expect(await stateOf(id)).toBe('error');
  });

  it('create, start, stop and delete return while a docker start hangs', async () => {
    docker.start = () => new Promise<void>(() => undefined);
    const t0 = Date.now();
    const res = await call('POST', '/sandbox', { snapshot: 'forge/sandbox-base:1', labels: {} });
    const { id, state } = (await res.json()) as { id: string; state: string };
    expect(state).toBe('starting');
    expect((await call('POST', `/sandbox/${id}/start`)).status).toBe(200);
    expect((await call('POST', `/sandbox/${id}/stop`)).status).toBe(200);
    expect((await call('DELETE', `/sandbox/${id}`)).status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('refuses to snapshot an agent home (409): it would bake credentials into an image', async () => {
    const { dto } = await create({ baios: 'agent-home' });
    const res = await call('POST', `/sandbox/${dto.id as string}/snapshot`, { name: 'x' });
    expect(res.status).toBe(409);
    expect(docker.calls.some((c) => c.method === 'commit')).toBe(false);
  });

  it('an allow-listed image that is not on the host is 400 Snapshot not found', async () => {
    docker.images.delete('forge/sandbox-base:1');
    const res = await call('POST', '/sandbox', { snapshot: 'forge/sandbox-base:1', labels: {} });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/not found/);
    expect(docker.containers.size).toBe(0);
  });

  it('401 without bearer', async () => {
    expect((await fetch(`${base}/sandbox`)).status).toBe(401);
  });

  it('describe unknown is 404', async () => {
    expect((await call('GET', '/sandbox/n1-missing')).status).toBe(404);
  });

  it('lists by labels', async () => {
    const a = await create({ team: 'x' });
    await create({ team: 'y' });
    const res = await call('GET', `/sandbox?labels=${encodeURIComponent('{"team":"x"}')}`);
    const page = (await res.json()) as { items: { id: string }[]; nextCursor: null };
    expect(page.items.map((i) => i.id)).toEqual([a.dto.id]);
    expect(page.nextCursor).toBeNull();
    expect((await call('GET', '/sandbox?labels=%7Bbad')).status).toBe(400);
  });

  it('stop, start, relabel and delete', async () => {
    const { dto } = await create();
    const id = dto.id as string;
    expect((await call('POST', `/sandbox/${id}/stop`)).status).toBe(200);
    expect(docker.calls.some((c) => c.method === 'stop' && c.args[1] === 10)).toBe(true);
    const state = async () =>
      ((await (await call('GET', `/sandbox/${id}`)).json()) as { state: string }).state;
    expect(await state()).toBe('stopped');
    expect((await call('POST', `/sandbox/${id}/start`)).status).toBe(200);
    await adm.tick();
    expect(await state()).toBe('started');
    const put = await call('PUT', `/sandbox/${id}/labels`, { labels: { z: '1' } });
    expect(((await put.json()) as { labels: unknown }).labels).toEqual({ z: '1' });
    expect((await call('DELETE', `/sandbox/${id}?force=true`)).status).toBe(200);
    expect((await call('GET', `/sandbox/${id}`)).status).toBe(404);
    expect((await call('DELETE', `/sandbox/${id}?force=true`)).status).toBe(404);
  });

  it('snapshots: commit, describe, delete, in-use 409', async () => {
    const { dto } = await create();
    expect(
      (await call('POST', `/sandbox/${dto.id as string}/snapshot`, { name: 'x' })).status,
    ).toBe(200);
    const got = await call('GET', '/snapshots/x');
    expect(await got.json()).toEqual({ name: 'x', state: 'active', errorReason: null });
    expect((await call('GET', '/snapshots/none')).status).toBe(404);
    docker.imagesInUse.add('forge-snap/x:latest');
    expect((await call('DELETE', '/snapshots/x')).status).toBe(409);
    docker.imagesInUse.clear();
    expect((await call('DELETE', '/snapshots/x')).status).toBe(200);
    expect((await call('DELETE', '/snapshots/x')).status).toBe(404);
  });

  it('network-settings: empty list stores null, otherwise trimmed entries', async () => {
    const { dto } = await create();
    const id = dto.id as string;
    await call('POST', `/sandbox/${id}/network-settings`, {
      networkAllowList: '',
      networkBlockAll: true,
    });
    expect(store.get(id)).toMatchObject({ networkAllow: null, networkBlockAll: true });
    await call('POST', `/sandbox/${id}/network-settings`, {
      networkAllowList: ' a.com, ,b.com ',
      networkBlockAll: false,
    });
    expect(store.get(id)).toMatchObject({
      networkAllow: ['a.com', 'b.com'],
      networkBlockAll: false,
    });
    const bad = await call('POST', `/sandbox/${id}/network-settings`, { networkBlockAll: 1 });
    expect(bad.status).toBe(400);
  });

  it('capacity reports running, queued and host headroom', async () => {
    await create();
    await create();
    const res = await call('GET', '/capacity');
    expect(await res.json()).toEqual({
      running: 2,
      queued: 0,
      maxRunning: 22,
      memAvailableBytes: 123,
      diskFreeBytes: 300,
      diskUsedPct: 67,
    });
  });
});
