import { randomUUID } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';

import { type Admission, procMemAvailable } from './admission.ts';
import { classOf, containerSpec } from './classes.ts';
import type { Config } from './config.ts';
import type { ContainerStatus, DockerPort } from './docker.ts';
import { readJson } from './exec.ts';
import { HttpError, type router, sendJson } from './http.ts';
import { log } from './log.ts';
import type { SandboxRow, Store } from './store.ts';

const SNAP_NAME = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
// forge/ and forge-snap/ images by prefix; anything else must be listed in SANDBOXD_IMAGE_ALLOW.
const SEG = '[a-z0-9]+(?:[._-][a-z0-9]+)*'; // a valid docker repo path component
const FORGE_IMAGE = new RegExp(`^forge(?:-snap)?/${SEG}(?:/${SEG})*(?::[A-Za-z0-9._-]+)?$`);
const snapRef = (name: string) => `forge-snap/${name}:latest`;

function toLabels(v: unknown): Record<string, string> {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw new HttpError(400, 'labels must be an object');
  }
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) {
    if (typeof x !== 'string') throw new HttpError(400, 'label values must be strings');
    out[k] = x;
  }
  return out;
}

/** Host readers behind GET /capacity, injectable so the numbers can be asserted. */
export interface SysReaders {
  memAvailable: () => number;
  statfs: () => Promise<{ bsize: number; blocks: number; bfree: number; bavail: number }>;
}

function usedPct(fs: { blocks: number; bfree: number; bavail: number }): number {
  const used = fs.blocks - fs.bfree;
  return used + fs.bavail === 0 ? 0 : Math.round((used / (used + fs.bavail)) * 100);
}

export function registerSandboxRoutes(
  api: ReturnType<typeof router>,
  d: { cfg: Config; store: Store; docker: DockerPort; admission: Admission; sys?: SysReaders },
): void {
  const { cfg, store, docker, admission } = d;
  const sys: SysReaders = d.sys ?? {
    memAvailable: procMemAvailable,
    statfs: () => statfs(cfg.dockerRoot),
  };

  const row = (id: string): SandboxRow => {
    const r = store.get(id);
    if (!r) throw new HttpError(404, 'Sandbox not found');
    return r;
  };

  /**
   * The row, unless its container has been removed behind our back: then the sandbox no longer
   * exists, and the 404 is what tells the API to replace it. The row is forgotten so nothing polls
   * it. `inspect` answers null only for Docker's own 404, so a Docker blip loses nothing.
   */
  async function live(id: string): Promise<SandboxRow> {
    const r = row(id);
    if (r.containerId === null || (await docker.inspect(r.containerId)) !== null) return r;
    admission.cancel(id);
    store.remove(id);
    log('warn', 'container gone, sandbox forgotten', { 'sandboxd.id': id });
    throw new HttpError(404, 'Sandbox not found');
  }

  /**
   * Daytona's state. One that exited on its own while wanted running is `stopped`, so the API's
   * start/reconcile path brings it back.
   */
  function stateOf(r: SandboxRow, c: { status: ContainerStatus } | null): string {
    if (!c) return 'error';
    if (r.desired === 'queued') return admission.hasFailed(r.id) ? 'error' : 'starting';
    switch (c.status) {
      case 'running':
        return 'started';
      case 'removing':
        return 'destroying';
      case 'dead':
        return 'error';
      case 'exited':
      case 'created':
        return 'stopped';
      default:
        return 'starting';
    }
  }

  async function dto(r: SandboxRow) {
    const state = stateOf(r, r.containerId ? await docker.inspect(r.containerId) : null);
    return {
      id: r.id,
      state,
      labels: r.labels,
      createdAt: r.createdAt,
      runnerId: cfg.nodeId,
      toolboxProxyUrl: `${cfg.publicUrl}/toolbox`,
      user: 'daytona',
    };
  }

  const empty = (res: ServerResponse) => sendJson(res, 200, {});

  api.route('POST', '/sandbox', async (req, res) => {
    const body = await readJson(req);
    const snapshot = body.snapshot;
    if (typeof snapshot !== 'string' || !snapshot) throw new HttpError(400, 'snapshot is required');
    const labels = toLabels(body.labels);
    let image: string;
    if (SNAP_NAME.test(snapshot) && (await docker.imageExists(snapRef(snapshot)))) {
      image = snapRef(snapshot);
    } else if (
      (FORGE_IMAGE.test(snapshot) && !snapshot.includes('..')) ||
      cfg.imageAllow.includes(snapshot)
    ) {
      image = snapshot;
    } else {
      throw new HttpError(400, `Snapshot ${snapshot} not found`);
    }
    // Allowed by name but not on this host: a caller error, not a 500 from docker create.
    if (image === snapshot && !(await docker.imageExists(image))) {
      throw new HttpError(400, `Snapshot ${snapshot} not found`);
    }
    const id = `${cfg.nodeId}-${randomUUID()}`;
    const cls = classOf(labels);
    const containerId = await docker.create(containerSpec(cfg, id, image, cls, labels));
    try {
      store.insert({
        id,
        containerId,
        image,
        class: cls,
        labels,
        desired: 'queued',
        networkAllow: null,
        networkBlockAll: false,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      await docker.remove(containerId); // no orphan container for a row that never landed
      throw err;
    }
    await admission.request(id);
    // Never awaited here or below: one drain can take seconds per queued runsc start (minutes
    // after a reboot), and the adapter polls describe anyway. tick() logs its own failures.
    void admission.tick();
    sendJson(res, 200, await dto(row(id)));
  });

  api.route('GET', '/sandbox/:id', async (_req, res, p) => {
    sendJson(res, 200, await dto(await live(p.id!)));
  });

  api.route('POST', '/sandbox/:id/start', async (_req, res, p) => {
    await live(p.id!);
    await admission.request(p.id!);
    void admission.tick();
    empty(res);
  });

  api.route('POST', '/sandbox/:id/stop', async (_req, res, p) => {
    const r = row(p.id!);
    admission.cancel(r.id);
    store.setState(r.id, 'stopped');
    store.removeSessionsFor(r.id);
    if (r.containerId) await docker.stop(r.containerId, 10);
    void admission.tick();
    empty(res);
  });

  // `force` is implied: removal is always forced.
  api.route('DELETE', '/sandbox/:id', async (_req, res, p) => {
    const r = row(p.id!);
    admission.cancel(r.id);
    if (r.containerId) await docker.remove(r.containerId);
    store.remove(r.id);
    void admission.tick();
    empty(res);
  });

  api.route('PUT', '/sandbox/:id/labels', async (req, res, p) => {
    row(p.id!);
    const body = await readJson(req);
    if (body.labels === undefined) throw new HttpError(400, 'labels is required');
    store.setLabels(p.id!, toLabels(body.labels));
    sendJson(res, 200, await dto(row(p.id!)));
  });

  api.route('GET', '/capacity', async (_req, res) => {
    const fs = await sys.statfs();
    sendJson(res, 200, {
      running: await admission.runningCount(),
      queued: admission.size(),
      maxRunning: cfg.maxRunning,
      memAvailableBytes: sys.memAvailable(),
      diskFreeBytes: fs.bavail * fs.bsize,
      // df's definition: used / (used + available to unprivileged users); 0 on an empty fs.
      diskUsedPct: usedPct(fs),
    });
  });

  api.route('GET', '/sandbox', async (_req, res, _p, url) => {
    let match: Record<string, string> = {};
    const raw = url.searchParams.get('labels');
    if (raw !== null) {
      try {
        match = toLabels(JSON.parse(raw));
      } catch {
        throw new HttpError(400, 'Invalid labels JSON format');
      }
    }
    // shortcut: one page, never a cursor; a node holds a few dozen sandboxes.
    const rows = store.byLabels(match);
    const items = await Promise.all(rows.map(dto));
    // Left out, so the reconciler asks for it by id and gets the 404 that writes it off.
    const present = await Promise.all(
      rows.map(
        async (r) => r.containerId === null || (await docker.inspect(r.containerId)) !== null,
      ),
    );
    sendJson(res, 200, { items: items.filter((_, index) => present[index]), nextCursor: null });
  });

  api.route('POST', '/sandbox/:id/snapshot', async (req, res, p) => {
    const r = row(p.id!);
    const { name } = await readJson(req);
    if (typeof name !== 'string' || !SNAP_NAME.test(name)) {
      throw new HttpError(400, 'invalid snapshot name');
    }
    if (!r.containerId) throw new HttpError(409, 'sandbox has no container');
    // An agent home's disk holds a person's Claude sign-in: never bake it into an image.
    if (r.class === 'agent') throw new HttpError(409, 'agent homes cannot be snapshotted');
    await docker.commit(r.containerId, snapRef(name));
    empty(res);
  });

  api.route('GET', '/snapshots/:name', async (_req, res, p) => {
    if (!SNAP_NAME.test(p.name!) || !(await docker.imageExists(snapRef(p.name!)))) {
      throw new HttpError(404, `Snapshot with name ${p.name!} not found`);
    }
    sendJson(res, 200, { name: p.name, state: 'active', errorReason: null });
  });

  api.route('DELETE', '/snapshots/:name', async (_req, res, p) => {
    if (!SNAP_NAME.test(p.name!)) throw new HttpError(404, 'not found');
    const out = await docker.removeImage(snapRef(p.name!));
    if (out === 'missing') throw new HttpError(404, `Snapshot with name ${p.name!} not found`);
    if (out === 'in-use') throw new HttpError(409, 'snapshot in use');
    empty(res);
  });

  api.route('POST', '/sandbox/:id/network-settings', async (req, res, p) => {
    row(p.id!);
    const { networkAllowList: list, networkBlockAll: block } = await readJson(req);
    if (typeof list !== 'string' || typeof block !== 'boolean') {
      throw new HttpError(400, 'networkAllowList (string) and networkBlockAll (boolean) required');
    }
    const allow = list
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    store.setNetwork(p.id!, allow.length ? allow : null, block);
    empty(res);
  });
}
