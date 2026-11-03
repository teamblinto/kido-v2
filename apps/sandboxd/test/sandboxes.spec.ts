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

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sbxd-'));
  store = new Store(dir);
  docker = new FakeDocker();
  const api = router('key');
  registerSandboxRoutes(api, {
    cfg,
    store,
    docker,
    admission: new Admission({ cfg, store, docker, memAvailable: () => Infinity }),
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

const create = async (labels: Record<string, string> = {}) => {
  const res = await call('POST', '/sandbox', {
    snapshot: 'forge/sandbox-base:1',
    labels,
    autoArchiveInterval: 0,
    autoStopInterval: 0,
  });
  return { res, dto: (await res.json()) as Record<string, unknown> };
};

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
    vi.spyOn(docker, 'removeImage').mockResolvedValueOnce('in-use' as never);
    expect((await call('DELETE', '/snapshots/x')).status).toBe(409);
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
});
