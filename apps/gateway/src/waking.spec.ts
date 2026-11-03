import { createServer, type IncomingMessage, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { BrokerRouteResult } from './broker-client.ts';
import type { Grant } from './grant-check.ts';
import { COULD_NOT_WAKE_PAGE, WAKING_PAGE } from './pages.ts';
import { createPipeline } from './pipeline.ts';
import type { RouteRecord } from './route-verify.ts';
import { createWaking } from './waking.ts';

const DOMAIN = 'forge-preview.localhost';
const LABEL = '0123456789abcdef0123';
const HOST = `${LABEL}-5173.${DOMAIN}`;
const NOW = Math.floor(Date.now() / 1000);
const GOOD = 'good.grant.jws';
const WAKING: BrokerRouteResult = { kind: 'waking' };
const CTX = { host: HOST };

const servers: Server[] = [];

function listen(server: Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function route(upstreamPort: number, visibility: RouteRecord['visibility']): BrokerRouteResult {
  return {
    kind: 'route',
    route: {
      exp: NOW + 30,
      iat: NOW,
      label: LABEL,
      org: '00000000-0000-4000-8000-000000000000',
      ports: [5173],
      project: '00000000-0000-4000-8000-000000000001',
      sandbox: 'sb',
      state: 'active',
      upstream: `http://127.0.0.1:${String(upstreamPort)}`,
      upstreamToken: 'tok',
      visibility,
    },
  };
}

/** A gateway whose broker answers each entry of `answers` in turn; the last one repeats. */
async function gateway(answers: (BrokerRouteResult | Promise<BrokerRouteResult>)[]) {
  const queue = [...answers];
  const getRoute = vi.fn(() => Promise.resolve(queue.length > 1 ? queue.shift() : queue[0]));
  const redeemGrant = vi.fn(() => Promise.resolve({ kind: 'refused' as const }));
  const pipeline = createPipeline({
    broker: { getRoute: getRoute as () => Promise<BrokerRouteResult>, redeemGrant },
    previewDomain: DOMAIN,
    productOrigin: 'https://app.example.test',
    socketMaxMs: 60_000,
    upstreamTimeoutMs: 5000,
    verifyGrant: (jws: string, host: string): Promise<Grant | undefined> =>
      Promise.resolve(
        jws === GOOD && host === HOST ? { aud: host, exp: NOW + 600, sub: 'u' } : undefined,
      ),
    wakeBudgetMs: 90_000,
  });
  const port = await listen(createServer((req, res) => void pipeline.onRequest(req, res)));
  return { getRoute, pipeline, port, redeemGrant };
}

function get(port: number, cookie?: string, path = '/') {
  return new Promise<{ body: string; headers: IncomingMessage['headers']; status: number }>(
    (resolve, reject) => {
      const req = request(
        {
          headers: { connection: 'close', host: HOST, ...(cookie === undefined ? {} : { cookie }) },
          host: '127.0.0.1',
          path,
          port,
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            body += chunk;
          });
          res.on('end', () => resolve({ body, headers: res.headers, status: res.statusCode ?? 0 }));
        },
      );
      req.on('error', reject);
      req.end();
    },
  );
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

describe('the waking flow through the pipeline', () => {
  it('answers 202 + the waking page + Retry-After: 2 at once on a 202: one broker call, no retry, no dial', async () => {
    const dial = vi.fn();
    await listen(createServer(dial));
    const { getRoute, port } = await gateway([WAKING]);

    const reply = await get(port);

    expect(reply.status).toBe(202);
    expect(reply.headers['retry-after']).toBe('2');
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(reply.body).toBe(WAKING_PAGE.body);
    expect(getRoute).toHaveBeenCalledTimes(1);
    expect(dial).not.toHaveBeenCalled();
  });

  it('coalesces concurrent requests for one label into a single in-flight broker call', async () => {
    let answer: (result: BrokerRouteResult) => void = () => undefined;
    const pending = new Promise<BrokerRouteResult>((r) => {
      answer = r;
    });
    const { getRoute, port } = await gateway([pending]);

    const replies = Promise.all([get(port), get(port), get(port)]);
    await vi.waitFor(() => expect(getRoute).toHaveBeenCalledTimes(1));
    answer(WAKING);

    for (const reply of await replies) {
      expect(reply.status).toBe(202);
    }
    expect(getRoute).toHaveBeenCalledTimes(1);
  });

  it('proxies a later poll against a now-active private sandbox without repeating the grant exchange', async () => {
    const upstreamPort = await listen(
      createServer((req, res) => res.end(String(req.headers.cookie))),
    );
    const { pipeline, port, redeemGrant } = await gateway([WAKING, route(upstreamPort, 'private')]);
    const cookie = `__Host-preview_grant=${GOOD}`;

    expect((await get(port, cookie)).status).toBe(202);
    expect(pipeline.waking.pending).toEqual([LABEL]);

    const reply = await get(port, cookie);

    expect(reply.status).toBe(200);
    expect(reply.body).toBe('undefined');
    expect(redeemGrant).not.toHaveBeenCalled();
    expect(pipeline.waking.pending).toEqual([]);
  });

  it('sends an unauthorised visitor to the grant exchange; the waking branch is never entered', async () => {
    const dial = vi.fn();
    const upstreamPort = await listen(createServer(dial));
    const { getRoute, pipeline, port } = await gateway([route(upstreamPort, 'private')]);

    const reply = await get(port);

    expect(reply.status).toBe(302);
    expect(getRoute).toHaveBeenCalledTimes(1);
    expect(pipeline.waking.pending).toEqual([]);
    expect(dial).not.toHaveBeenCalled();
  });

  it('forwards the grant cookie and the bare host to the broker', async () => {
    const { getRoute, port } = await gateway([WAKING]);

    await get(port, `a=1; __Host-preview_grant=${GOOD}`);

    expect(getRoute).toHaveBeenCalledWith(LABEL, { grant: GOOD, host: HOST });
  });

  describe('an unauthorised broker answer', () => {
    it('is the grant exchange: 302 to the product origin, no waking state, no dial', async () => {
      const dial = vi.fn();
      await listen(createServer(dial));
      const { pipeline, port } = await gateway([{ kind: 'unauthorised' }]);

      const reply = await get(port);

      expect(reply.status).toBe(302);
      expect(reply.headers.location).toBe(
        `https://app.example.test/preview-authorize?label=${LABEL}&return=${HOST}`,
      );
      expect(pipeline.waking.pending).toEqual([]);
      expect(dial).not.toHaveBeenCalled();
    });

    it('outranks a locally valid cookie: still 302', async () => {
      const { port } = await gateway([{ kind: 'unauthorised' }]);

      expect((await get(port, `__Host-preview_grant=${GOOD}`)).status).toBe(302);
    });

    it('still redeems a ?code= return first; the redirect back re-asks the broker with the grant', async () => {
      const { getRoute, port, redeemGrant } = await gateway([{ kind: 'unauthorised' }]);
      redeemGrant.mockResolvedValueOnce({ grant: GOOD, kind: 'grant' } as never);

      const reply = await get(port, undefined, '/p?code=c0de');

      expect(redeemGrant).toHaveBeenCalledWith({ code: 'c0de', host: HOST });
      expect(reply.status).toBe(302);
      expect(reply.headers.location).toBe('/p');
      expect(reply.headers['set-cookie']?.[0]).toMatch(`__Host-preview_grant=${GOOD};`);
      expect(getRoute).toHaveBeenCalledTimes(1);
    });
  });

  it('serves the plain could-not-wake page when the broker refuses a label it said was waking', async () => {
    const { port } = await gateway([WAKING, { kind: 'refused' }]);

    expect((await get(port)).status).toBe(202);
    const reply = await get(port);

    expect(reply.status).toBe(503);
    expect(reply.body).toBe(COULD_NOT_WAKE_PAGE.body);
    expect(reply.body).not.toMatch(/sandbox|daytona|resume/i);
  });
});

describe('createWaking', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  it('gives up with could-not-wake once a label has been waking past the budget, then starts over', async () => {
    const waking = createWaking({
      budgetMs: 90_000,
      getRoute: () => Promise.resolve(WAKING),
      max: 10,
    });

    await expect(waking.resolve(LABEL, CTX)).resolves.toEqual({ kind: 'page', page: WAKING_PAGE });
    vi.advanceTimersByTime(89_999);
    await expect(waking.resolve(LABEL, CTX)).resolves.toEqual({ kind: 'page', page: WAKING_PAGE });
    vi.advanceTimersByTime(1);
    await expect(waking.resolve(LABEL, CTX)).resolves.toEqual({
      kind: 'page',
      page: COULD_NOT_WAKE_PAGE,
    });
    expect(waking.pending).toEqual([]);

    // The next request opens a fresh budget rather than refusing forever.
    await expect(waking.resolve(LABEL, CTX)).resolves.toEqual({ kind: 'page', page: WAKING_PAGE });
  });

  it('passes a plain refusal (never waking) through as refused, not could-not-wake', async () => {
    const waking = createWaking({
      budgetMs: 1,
      getRoute: () => Promise.resolve({ kind: 'refused' }),
      max: 10,
    });

    await expect(waking.resolve(LABEL, CTX)).resolves.toEqual({ kind: 'refused' });
  });

  it('bounds the labels it tracks by insertion order', async () => {
    const waking = createWaking({
      budgetMs: 90_000,
      getRoute: () => Promise.resolve(WAKING),
      max: 2,
    });

    for (const label of ['a', 'b', 'c']) {
      await waking.resolve(label, CTX);
    }

    expect(waking.pending).toEqual(['b', 'c']);
  });
});
