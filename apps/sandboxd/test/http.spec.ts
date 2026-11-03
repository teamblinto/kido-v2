import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { HttpError, router, sendJson } from '../src/http.ts';

let server: Server;
let base: string;

beforeAll(async () => {
  const r = router('key');
  r.route('GET', '/sandbox/:id/x', (_req, res, params, url) => {
    sendJson(res, 200, { id: params.id, q: url.searchParams.get('q') });
    return Promise.resolve();
  });
  r.route('GET', '/conflict', () => Promise.reject(new HttpError(409, 'busy')), { auth: false });
  r.route(
    'GET',
    '/open',
    (_req, res) => {
      sendJson(res, 200, { ok: true });
      return Promise.resolve();
    },
    { auth: false },
  );
  r.route('GET', '/boom', () => Promise.reject(new Error('secret detail')), { auth: false });
  server = createServer(r.handle);
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});

const get = (p: string, auth?: string) =>
  fetch(base + p, { headers: auth ? { authorization: auth } : {} });

describe('http', () => {
  it('401 on missing or wrong bearer', async () => {
    for (const a of [undefined, 'Bearer nope', 'Bearer ']) {
      const res = await get('/sandbox/1/x', a);
      expect(res.status).toBe(401);
      expect(await res.json()).toHaveProperty('message');
    }
  });
  it('routes with params and query', async () => {
    const res = await get('/sandbox/abc/x?q=1', 'Bearer key');
    expect(await res.json()).toEqual({ id: 'abc', q: '1' });
  });
  it('requires the bearer by default, not with auth:false', async () => {
    expect((await get('/sandbox/1/x?q=1')).status).toBe(401);
    expect((await get('/open')).status).toBe(200);
  });
  it('400 on malformed percent-encoding', async () => {
    expect((await get('/sandbox/%E0%A4%A/x', 'Bearer key')).status).toBe(400);
  });
  it('logs one request line with only the whitelisted fields', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let lines: string[];
    try {
      await fetch(`${base}/sandbox/abc/x?q=secretquery`, {
        headers: {
          authorization: 'Bearer key',
          'x-forge-operation-id': 'op-1',
          'x-forge-lease-epoch': '7',
        },
      });
      await new Promise((r) => setTimeout(r, 20));
      lines = out.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('"request"'));
    } finally {
      out.mockRestore();
    }
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(rec).toMatchObject({
      op: 'GET /sandbox/:id/x',
      status: 200,
      sandboxId: 'abc',
      operationId: 'op-1',
      leaseEpoch: '7',
    });
    expect(typeof rec.durationMs).toBe('number');
    expect(lines[0]).not.toMatch(/Bearer|key"|secretquery/);
  });
  it('404 on unknown route', async () => {
    expect((await get('/nope')).status).toBe(404);
  });
  it('maps HttpError', async () => {
    const res = await get('/conflict');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ message: 'busy' });
  });
  it('500 without leaking', async () => {
    const res = await get('/boom');
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('secret detail');
  });
});
