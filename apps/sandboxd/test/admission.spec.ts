import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Admission } from '../src/admission.ts';
import { watchEvents } from '../src/events.ts';
import { Store, type SandboxRow } from '../src/store.ts';
import { FakeDocker } from './fake-docker.ts';

let dir: string;
let store: Store;
let docker: FakeDocker;
let mem: number;
let adm: Admission;
const cfg = { maxRunning: 2, minMemAvailableBytes: 100 };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'adm-'));
  store = new Store(dir);
  docker = new FakeDocker();
  mem = 1000;
  adm = new Admission({ cfg, store, docker, memAvailable: () => mem });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
async function add(desired: SandboxRow['desired'] = 'queued'): Promise<string> {
  const id = `n1-${String(++n)}`;
  const containerId = await docker.create({
    name: `sbx-${id}`,
    image: 'i',
    labels: { 'sandboxd.id': id },
    env: [],
    hostConfig: {},
    network: 'sbx-proj',
  });
  store.insert({
    id,
    containerId,
    image: 'i',
    class: 'project',
    labels: {},
    desired,
    networkAllow: null,
    networkBlockAll: false,
    createdAt: new Date(1000 + n).toISOString(),
  });
  return id;
}
const status = (id: string) => docker.containers.get(store.get(id)!.containerId!)!.status;

describe('admission', () => {
  it('holds the third request until one dies', async () => {
    const ids = [await add(), await add(), await add()];
    for (const i of ids) await adm.request(i);
    await adm.tick();
    expect(ids.map(status)).toEqual(['running', 'running', 'created']);
    expect(adm.size()).toBe(1);
    docker.containers.get(store.get(ids[0]!)!.containerId!)!.status = 'exited';
    store.setState(ids[0]!, 'stopped');
    await adm.tick();
    expect(status(ids[2]!)).toBe('running');
    expect(adm.size()).toBe(0);
  });

  it('a die event triggers a tick', async () => {
    const ids = [await add(), await add(), await add()];
    for (const i of ids) await adm.request(i);
    await adm.tick();
    const off = watchEvents(docker, adm);
    docker.containers.get(store.get(ids[1]!)!.containerId!)!.status = 'exited';
    docker.emit({ action: 'die', cid: 'x', labels: { 'sandboxd.id': ids[1]! } });
    await adm.tick();
    expect(status(ids[2]!)).toBe('running');
    off();
  });

  it('starts nothing while memory is below the floor', async () => {
    const id = await add();
    await adm.request(id);
    mem = 50;
    await adm.tick();
    expect(status(id)).toBe('created');
    mem = 500;
    await adm.tick();
    expect(status(id)).toBe('running');
  });

  it('retries a failed start 3 times, then marks it failed', async () => {
    const id = await add();
    let calls = 0;
    docker.start = () => {
      calls++;
      return Promise.reject(new Error('boom'));
    };
    await adm.request(id);
    await adm.tick();
    expect(calls).toBe(3);
    expect(adm.hasFailed(id)).toBe(true);
    expect(adm.size()).toBe(0);
    docker.start = FakeDocker.prototype.start.bind(docker);
    await adm.request(id);
    expect(adm.hasFailed(id)).toBe(false);
    await adm.tick();
    expect(status(id)).toBe('running');
  });

  it('a running container is marked started, not queued, and counted by docker status', async () => {
    const ids = [await add('stopped'), await add('stopped'), await add()];
    docker.containers.get(store.get(ids[0]!)!.containerId!)!.status = 'running';
    docker.containers.get(store.get(ids[1]!)!.containerId!)!.status = 'running';
    await adm.request(ids[0]!);
    expect(store.get(ids[0]!)!.desired).toBe('started');
    expect(adm.size()).toBe(0);
    await adm.request(ids[2]!);
    await adm.tick(); // two running by docker status = maxRunning
    expect(status(ids[2]!)).toBe('created');
  });

  it('a stop landing during start leaves the container stopped', async () => {
    const id = await add();
    await adm.request(id);
    const realStart = docker.start.bind(docker);
    docker.start = async (cid: string) => {
      await realStart(cid);
      store.setState(id, 'stopped'); // /stop arrives while start is in flight
    };
    await adm.tick();
    expect(status(id)).toBe('exited');
  });

  it('a delete landing during start removes the container', async () => {
    const id = await add();
    await adm.request(id);
    const cid = store.get(id)!.containerId!;
    const realStart = docker.start.bind(docker);
    docker.start = async (c: string) => {
      await realStart(c);
      store.remove(id);
    };
    await adm.tick();
    expect(docker.containers.has(cid)).toBe(false);
  });

  it('cancel drops a queued sandbox', async () => {
    const id = await add();
    await adm.request(id);
    adm.cancel(id);
    await adm.tick();
    expect(status(id)).toBe('created');
  });

  it('recover turns a queued row whose container already runs into started (crash after start)', async () => {
    const id = await add('queued');
    docker.containers.get(store.get(id)!.containerId!)!.status = 'running';
    await adm.recover();
    expect(store.get(id)!.desired).toBe('started');
    expect(adm.size()).toBe(0);
  });

  it('request does not overwrite a /stop that lands during its inspect', async () => {
    const id = await add('stopped');
    const realInspect = docker.inspect.bind(docker);
    docker.inspect = async (cid: string) => {
      const r = await realInspect(cid);
      store.setState(id, 'stopped'); // what POST /stop does
      adm.cancel(id);
      return r;
    };
    await adm.request(id);
    docker.inspect = realInspect;
    expect(store.get(id)!.desired).toBe('stopped');
    await adm.tick();
    expect(status(id)).toBe('created');
  });

  it('request does not mark started over a /stop when the container runs', async () => {
    const id = await add('stopped');
    docker.containers.get(store.get(id)!.containerId!)!.status = 'running';
    const realInspect = docker.inspect.bind(docker);
    docker.inspect = async (cid: string) => {
      const r = await realInspect(cid);
      store.setState(id, 'stopped');
      adm.cancel(id);
      return r;
    };
    await adm.request(id);
    expect(store.get(id)!.desired).toBe('stopped');
  });

  it('a hung docker start times out, counts as a failed attempt and frees the drain', async () => {
    const a2 = new Admission({ cfg, store, docker, memAvailable: () => mem, controlTimeoutMs: 20 });
    const id = await add();
    docker.start = () => new Promise<void>(() => undefined);
    await a2.request(id);
    await a2.tick();
    expect(a2.hasFailed(id)).toBe(true);
  });

  it('recover enqueues unstarted queued/started rows in createdAt order', async () => {
    const a = await add('queued');
    const b = await add('started');
    await add('stopped');
    await adm.recover();
    expect(adm.size()).toBe(2);
    await adm.tick();
    expect([status(a), status(b)]).toEqual(['running', 'running']);
  });
});
