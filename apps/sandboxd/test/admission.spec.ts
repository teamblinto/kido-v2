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
    queuedAt: null,
  });
  return id;
}
const status = (id: string) => docker.containers.get(store.get(id)!.containerId!)!.status;

describe('admission', () => {
  it('holds the third request until one dies', async () => {
    const ids = [await add(), await add(), await add()];
    ids.forEach((i) => adm.request(i));
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
    ids.forEach((i) => adm.request(i));
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
    adm.request(id);
    mem = 50;
    await adm.tick();
    expect(status(id)).toBe('created');
    mem = 500;
    await adm.tick();
    expect(status(id)).toBe('running');
  });

  it('cancel drops a queued sandbox', async () => {
    const id = await add();
    adm.request(id);
    adm.cancel(id);
    await adm.tick();
    expect(status(id)).toBe('created');
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
