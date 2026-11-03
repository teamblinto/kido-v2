import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Admission } from './admission.ts';
import { classOf, containerSpec } from './classes.ts';
import type { Config } from './config.ts';
import type { DockerPort } from './docker.ts';
import { HttpError, type router, sendJson } from './http.ts';
import type { SandboxRow, Store } from './store.ts';

const SNAP_NAME = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
const snapRef = (name: string) => `forge-snap/${name}:latest`;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req as AsyncIterable<Buffer>) {
    n += c.length;
    if (n > 1 << 20) throw new HttpError(413, 'body too large');
    chunks.push(c);
  }
  if (n === 0) return {};
  try {
    const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  throw new HttpError(400, 'invalid JSON body');
}

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

export function registerSandboxRoutes(
  api: ReturnType<typeof router>,
  d: { cfg: Config; store: Store; docker: DockerPort; admission: Admission },
): void {
  const { cfg, store, docker, admission } = d;

  const row = (id: string): SandboxRow => {
    const r = store.get(id);
    if (!r) throw new HttpError(404, 'Sandbox not found');
    return r;
  };

  async function dto(r: SandboxRow) {
    const c = r.containerId ? await docker.inspect(r.containerId) : null;
    let state = 'starting';
    if (c && r.desired !== 'queued') {
      const s = c.status;
      if (s === 'running') state = 'started';
      else if (s === 'removing') state = 'destroying';
      else if (s === 'dead') state = 'error';
      else if (s === 'exited' || s === 'created') {
        state = r.desired === 'stopped' ? 'stopped' : 'starting';
      }
    }
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
    } else if (cfg.imageAllow.includes(snapshot)) {
      image = snapshot;
    } else {
      throw new HttpError(400, `Snapshot ${snapshot} not found`);
    }
    const id = `${cfg.nodeId}-${randomUUID()}`;
    const cls = classOf(labels);
    const containerId = await docker.create(containerSpec(cfg, id, image, cls, labels, []));
    const now = new Date().toISOString();
    store.insert({
      id,
      containerId,
      image,
      class: cls,
      labels,
      desired: 'queued',
      networkAllow: null,
      networkBlockAll: false,
      createdAt: now,
      queuedAt: now,
    });
    admission.request(id);
    await admission.tick();
    sendJson(res, 200, await dto(row(id)));
  });

  api.route('GET', '/sandbox/:id', async (_req, res, p) => {
    sendJson(res, 200, await dto(row(p.id!)));
  });

  api.route('POST', '/sandbox/:id/start', async (_req, res, p) => {
    row(p.id!);
    admission.request(p.id!);
    await admission.tick();
    empty(res);
  });

  api.route('POST', '/sandbox/:id/stop', async (_req, res, p) => {
    const r = row(p.id!);
    admission.cancel(r.id);
    store.setState(r.id, 'stopped');
    if (r.containerId) await docker.stop(r.containerId, 10);
    await admission.tick();
    empty(res);
  });

  // `force` is implied: removal is always forced.
  api.route('DELETE', '/sandbox/:id', async (_req, res, p) => {
    const r = row(p.id!);
    admission.cancel(r.id);
    if (r.containerId) await docker.remove(r.containerId);
    store.remove(r.id);
    await admission.tick();
    empty(res);
  });

  api.route('PUT', '/sandbox/:id/labels', async (req, res, p) => {
    row(p.id!);
    const body = await readJson(req);
    if (body.labels === undefined) throw new HttpError(400, 'labels is required');
    store.setLabels(p.id!, toLabels(body.labels));
    sendJson(res, 200, await dto(row(p.id!)));
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
    const items = await Promise.all(store.byLabels(match).map(dto));
    sendJson(res, 200, { items, nextCursor: null });
  });

  api.route('POST', '/sandbox/:id/snapshot', async (req, res, p) => {
    const r = row(p.id!);
    const { name } = await readJson(req);
    if (typeof name !== 'string' || !SNAP_NAME.test(name)) {
      throw new HttpError(400, 'invalid snapshot name');
    }
    if (!r.containerId) throw new HttpError(409, 'sandbox has no container');
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
