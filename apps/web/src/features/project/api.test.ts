import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { ApiProblem } from '@/lib/api/problem';
import { API, server } from '@/test/server';
import { problemResponse } from '@/test/render';
import {
  addDomain,
  cancelRun,
  checkDomain,
  createRun,
  getCheckpointDiff,
  getDomain,
  getPreview,
  getRun,
  getRunEvents,
  listCheckpoints,
  listDomains,
  listFiles,
  listRuns,
  readFile,
  removeDomain,
  retryDomain,
  revertCheckpoint,
  rotatePreview,
  setPreviewVisibility,
  wakeSandbox,
} from './api';

const ORG = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const PROJECT = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const RUN = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

const RUNS = `${API}/orgs/${ORG}/projects/${PROJECT}/runs`;

/** A run exactly as `runResponseSchema` describes one — no more fields, no fewer. */
const aRun = {
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cancelRequestedAt: null,
  contextSkips: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  endedAt: null,
  failureClass: null,
  id: RUN,
  inputTokens: 0,
  lastSeq: 0,
  model: 'claude-opus-5',
  outputTokens: 0,
  projectId: PROJECT,
  promptExcerpt: 'ship it',
  startedAt: null,
  status: 'queued',
  userId: '3f2504e0-4f89-11d3-9a0c-0305e82c3302',
};

describe('the console client', () => {
  it('sends each call to its own route and parses the contract’s shape', async () => {
    const seen: string[] = [];

    const record = (method: string, path: string) => {
      seen.push(`${method} ${path}`);
    };

    server.use(
      http.post(RUNS, async ({ request }) => {
        record('POST', '/runs');
        // No model was picked, so the body is `{ prompt }` and nothing else.
        expect(await request.json()).toEqual({ prompt: 'ship it' });

        return HttpResponse.json(aRun);
      }),
      http.post(`${RUNS}/${RUN}/cancel`, () => {
        record('POST', '/runs/:id/cancel');

        return new HttpResponse(null, { status: 202 });
      }),
      http.get(`${RUNS}/${RUN}/events`, ({ request }) => {
        record('GET', '/runs/:id/events');
        const url = new URL(request.url);

        expect(url.searchParams.get('after')).toBe('4');
        expect(url.searchParams.get('limit')).toBe('200');

        return HttpResponse.json({ events: [], lastSeq: 4 });
      }),
      http.get(`${RUNS}/${RUN}`, () => {
        record('GET', '/runs/:id');

        return HttpResponse.json(aRun);
      }),
      http.get(RUNS, ({ request }) => {
        record('GET', '/runs');
        expect(new URL(request.url).searchParams.get('limit')).toBe('50');

        return HttpResponse.json({ nextCursor: null, runs: [aRun] });
      }),
    );

    const created = await createRun(ORG, PROJECT, { prompt: 'ship it' });
    const cancelled = await cancelRun(ORG, PROJECT, RUN);
    const read = await getRun(ORG, PROJECT, RUN);
    const events = await getRunEvents(ORG, PROJECT, RUN, { after: 4, limit: 200 });
    const listed = await listRuns(ORG, PROJECT, { limit: 50 });

    expect(seen).toEqual([
      'POST /runs',
      'POST /runs/:id/cancel',
      'GET /runs/:id',
      'GET /runs/:id/events',
      'GET /runs',
    ]);

    expect(created.id).toBe(RUN);
    expect(cancelled).toBeUndefined();
    expect(read.model).toBe('claude-opus-5');
    expect(events.lastSeq).toBe(4);
    expect(listed.runs).toHaveLength(1);
  });

  it('sends the model when given and omits it otherwise', async () => {
    // The picker's choice travels as `model`; leaving it alone sends `{ prompt }` and nothing
    // else, so the API's default applies (spec 011 US6). The handler echoes what was sent, the
    // way the real one records the pick on the row.
    const bodies: unknown[] = [];

    server.use(
      http.post(RUNS, async ({ request }) => {
        const body = (await request.json()) as { model?: string; prompt: string };

        bodies.push(body);

        return HttpResponse.json({ ...aRun, model: body.model ?? 'claude-sonnet-5' });
      }),
    );

    const picked = await createRun(ORG, PROJECT, { model: 'claude-haiku-4-5', prompt: 'ship it' });
    const left = await createRun(ORG, PROJECT, { prompt: 'ship it' });

    expect(bodies).toEqual([
      { model: 'claude-haiku-4-5', prompt: 'ship it' },
      { prompt: 'ship it' },
    ]);
    expect(picked.model).toBe('claude-haiku-4-5');
    expect(left.model).toBe('claude-sonnet-5');
  });

  it('fails on a response with an undeclared field rather than rendering it', async () => {
    // The point of `apiRequest`'s required schema, asserted at this feature's boundary: the
    // contract's objects are strict, so a server that grew a field fails here — in a test —
    // rather than shipping one nothing reads.
    server.use(http.get(`${RUNS}/${RUN}`, () => HttpResponse.json({ ...aRun, mood: 'cheerful' })));

    // Asserted as a parse failure rather than as any throw, so the test cannot pass because the
    // call fell over for some unrelated reason.
    await expect(getRun(ORG, PROJECT, RUN)).rejects.toThrow(ZodError);
  });

  it('lets a refusal through as an ApiProblem', async () => {
    // Every call, not just one: a refusal from any of the five has to reach the catalogue with
    // its slug intact, because that is what `MESSAGES` puts a sentence to (FR-021).
    server.use(
      http.post(RUNS, () => problemResponse('permission-denied', 403)),
      http.post(`${RUNS}/${RUN}/cancel`, () => problemResponse('not-found', 404)),
      http.get(`${RUNS}/${RUN}/events`, () => problemResponse('gone', 410)),
      http.get(`${RUNS}/${RUN}`, () => problemResponse('not-found', 404)),
      http.get(RUNS, () => problemResponse('unauthorized', 401)),
    );

    const refusals = await Promise.all(
      [
        createRun(ORG, PROJECT, { prompt: 'ship it' }),
        cancelRun(ORG, PROJECT, RUN),
        getRun(ORG, PROJECT, RUN),
        getRunEvents(ORG, PROJECT, RUN),
        listRuns(ORG, PROJECT),
      ].map(async (call) => call.catch((error: unknown) => error)),
    );

    expect(refusals.map((error) => ApiProblem.is(error))).toEqual([true, true, true, true, true]);
    expect(refusals.map((error) => (error as ApiProblem).slug)).toEqual([
      'permission-denied',
      'not-found',
      'not-found',
      'gone',
      'unauthorized',
    ]);
  });

  it('omits the query string entirely when nothing was asked for', async () => {
    // A bare path rather than `?`: the contract defaults `after` and `limit` server-side, and a
    // client that sent empty parameters would be deciding on the server's behalf.
    let asked = '';

    server.use(
      http.get(RUNS, ({ request }) => {
        asked = new URL(request.url).search;

        return HttpResponse.json({ nextCursor: null, runs: [] });
      }),
    );

    await listRuns(ORG, PROJECT);

    expect(asked).toBe('');
  });
});

const PROJECT_PATH = `${API}/orgs/${ORG}/projects/${PROJECT}`;
const CHECKPOINT = '6ba7b812-9dad-11d1-80b4-00c04fd430c8';

/** A checkpoint exactly as `checkpointSchema` describes one. */
const aCheckpoint = {
  actorId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  files: [],
  gitSha: 'a'.repeat(40),
  id: CHECKPOINT,
  kind: 'turn',
  label: 'Turn 1',
  mirroredAt: null,
  parentId: null,
  revertsId: null,
  runId: null,
  turn: 1,
};

describe('the editor client', () => {
  it('sends each call to its own route and parses the contract’s shape', async () => {
    // One walk over every call 022 adds: the route it asks for, and an answer the contract
    // schema accepts. A path typed wrong here is an unhandled request, which the server errors
    // on — so the routes are asserted by the handlers matching at all.
    const seen: string[] = [];
    let idempotency: string | null = '';

    server.use(
      http.get(`${PROJECT_PATH}/files`, ({ request }) => {
        seen.push(`GET /files?path=${new URL(request.url).searchParams.get('path') ?? ''}`);

        return HttpResponse.json({
          entries: [{ kind: 'file', name: 'index.ts', size: 12 }],
          path: 'src',
        });
      }),
      http.get(`${PROJECT_PATH}/files/content`, ({ request }) => {
        seen.push(`GET /files/content?path=${new URL(request.url).searchParams.get('path') ?? ''}`);

        return HttpResponse.json({
          baseCheckpointId: CHECKPOINT,
          bytes: 3,
          path: 'src/index.ts',
          renderable: true,
          content: 'ok',
        });
      }),
      http.post(`${PROJECT_PATH}/files/wake`, () => {
        seen.push('POST /files/wake');

        return HttpResponse.json({ because: 'resuming', ready: false });
      }),
      http.get(`${PROJECT_PATH}/checkpoints/${CHECKPOINT}/diff`, () => {
        seen.push('GET /checkpoints/:id/diff');

        return HttpResponse.json({ checkpointId: CHECKPOINT, files: [], parentId: null });
      }),
      http.post(`${PROJECT_PATH}/checkpoints/${CHECKPOINT}/revert`, ({ request }) => {
        seen.push('POST /checkpoints/:id/revert');
        idempotency = request.headers.get('Idempotency-Key');

        return HttpResponse.json(aCheckpoint, { status: 201 });
      }),
      http.get(`${PROJECT_PATH}/checkpoints`, ({ request }) => {
        seen.push(`GET /checkpoints${new URL(request.url).search}`);

        return HttpResponse.json({ items: [aCheckpoint], nextCursor: null });
      }),
      http.get(`${PROJECT_PATH}/preview`, () => {
        seen.push('GET /preview');

        return HttpResponse.json({
          port: 5173,
          stage: 'ready',
          url: 'https://a.preview.test',
          visibility: 'private',
        });
      }),
      http.put(`${PROJECT_PATH}/preview/visibility`, async ({ request }) => {
        seen.push(`PUT /preview/visibility ${JSON.stringify(await request.json())}`);

        return HttpResponse.json({
          port: 5173,
          stage: 'ready',
          url: 'https://a.preview.test',
          visibility: 'org',
        });
      }),
      http.post(`${PROJECT_PATH}/preview/rotate`, () => {
        seen.push('POST /preview/rotate');

        return HttpResponse.json({
          port: 5173,
          status: 'preview-label-rotated',
          url: 'https://b.preview.test',
        });
      }),
    );

    const listing = await listFiles(ORG, PROJECT, 'src');
    const file = await readFile(ORG, PROJECT, 'src/index.ts');
    const wake = await wakeSandbox(ORG, PROJECT);
    const checkpoints = await listCheckpoints(ORG, PROJECT, { limit: 20 });
    const diff = await getCheckpointDiff(ORG, PROJECT, CHECKPOINT);
    const reverted = await revertCheckpoint(ORG, PROJECT, CHECKPOINT, 'key-1');
    const preview = await getPreview(ORG, PROJECT);
    const visibility = await setPreviewVisibility(ORG, PROJECT, 'org');
    const rotated = await rotatePreview(ORG, PROJECT);

    expect(seen).toEqual([
      'GET /files?path=src',
      'GET /files/content?path=src/index.ts',
      'POST /files/wake',
      'GET /checkpoints?limit=20',
      'GET /checkpoints/:id/diff',
      'POST /checkpoints/:id/revert',
      'GET /preview',
      'PUT /preview/visibility {"visibility":"org"}',
      'POST /preview/rotate',
    ]);

    expect(listing.entries[0]?.name).toBe('index.ts');
    expect(file.renderable).toBe(true);
    expect(wake).toEqual({ because: 'resuming', ready: false });
    expect(checkpoints.items).toHaveLength(1);
    expect(diff.checkpointId).toBe(CHECKPOINT);
    expect(reverted.id).toBe(CHECKPOINT);
    expect(preview.visibility).toBe('private');
    expect(visibility.visibility).toBe('org');
    expect(rotated.url).toBe('https://b.preview.test');
    // A revert is the one route that must not be replayed by accident (016): the key travels.
    expect(idempotency).toBe('key-1');
  });

  it('asks for the root with an explicit empty path', async () => {
    // `''` is the workspace root, not "no path": the jail is the API's, and omitting the
    // parameter would be a request the contract does not describe.
    let asked = '';

    server.use(
      http.get(`${PROJECT_PATH}/files`, ({ request }) => {
        asked = new URL(request.url).search;

        return HttpResponse.json({ entries: [], path: '' });
      }),
    );

    await listFiles(ORG, PROJECT, '');

    expect(asked).toBe('?path=');
  });
});

const DOMAIN = '6ba7b813-9dad-11d1-80b4-00c04fd430c8';

/** A domain exactly as `domainSchema` describes one (spec 028 contracts/domains.md). */
const aDomain = {
  activatedAt: null,
  addedBy: '3f2504e0-4f89-11d3-9a0c-0305e82c3302',
  check: null,
  checkAvailableAt: null,
  createdAt: '2026-09-23T10:00:00.000Z',
  displayHostname: 'app.acme.com',
  driftedAt: null,
  failureReason: null,
  hostname: 'app.acme.com',
  id: DOMAIN,
  records: [
    {
      name: '_forge-challenge.app.acme.com',
      purpose: 'ownership',
      status: 'unchecked',
      type: 'TXT',
      value: 'forge-verify=abc',
    },
    {
      name: 'app.acme.com',
      purpose: 'routing',
      status: 'unchecked',
      type: 'CNAME',
      value: 'domains.forge.test',
    },
  ],
  releaseAt: null,
  state: 'pending',
  windowEndsAt: '2026-09-26T10:00:00.000Z',
};

describe('the domains client', () => {
  it('sends each call to its own route and parses the contract’s shape', async () => {
    // Every route contracts/domains.md names, answered with a body its schema accepts. A path
    // typed wrong is an unhandled request, which the server errors on.
    const seen: string[] = [];
    const keys: Record<string, string | null> = {};
    const DOMAINS = `${PROJECT_PATH}/domains`;

    server.use(
      http.get(DOMAINS, () => {
        seen.push('GET /domains');

        return HttpResponse.json({ canManage: true, items: [aDomain] });
      }),
      http.post(DOMAINS, async ({ request }) => {
        seen.push(`POST /domains ${JSON.stringify(await request.json())}`);
        keys.add = request.headers.get('Idempotency-Key');

        return HttpResponse.json({ domain: aDomain }, { status: 201 });
      }),
      http.get(`${DOMAINS}/${DOMAIN}`, () => {
        seen.push('GET /domains/:id');

        return HttpResponse.json({ domain: aDomain });
      }),
      http.post(`${DOMAINS}/${DOMAIN}/check`, () => {
        seen.push('POST /domains/:id/check');

        return HttpResponse.json({ domain: aDomain }, { status: 202 });
      }),
      http.post(`${DOMAINS}/${DOMAIN}/retry`, ({ request }) => {
        seen.push('POST /domains/:id/retry');
        keys[`retry-${String(seen.length)}`] = request.headers.get('Idempotency-Key');

        return HttpResponse.json({ domain: aDomain });
      }),
      http.delete(`${DOMAINS}/${DOMAIN}`, () => {
        seen.push('DELETE /domains/:id');

        return HttpResponse.json(
          {
            deletableRecords: aDomain.records.map(({ name, type, value }) => ({
              name,
              type,
              value,
            })),
            domain: { ...aDomain, state: 'removing', windowEndsAt: null },
          },
          { status: 202 },
        );
      }),
    );

    const list = await listDomains(ORG, PROJECT);
    const added = await addDomain(ORG, PROJECT, { hostname: '  app.acme.com ' }, 'key-add');
    const one = await getDomain(ORG, PROJECT, DOMAIN);
    const checked = await checkDomain(ORG, PROJECT, DOMAIN);
    const retried = await retryDomain(ORG, PROJECT, DOMAIN, 'key-retry');
    await retryDomain(ORG, PROJECT, DOMAIN);
    const removed = await removeDomain(ORG, PROJECT, DOMAIN);

    expect(seen).toEqual([
      'GET /domains',
      // The request schema trims: the body the API sees is the one the contract names.
      'POST /domains {"hostname":"app.acme.com"}',
      'GET /domains/:id',
      'POST /domains/:id/check',
      'POST /domains/:id/retry',
      'POST /domains/:id/retry',
      'DELETE /domains/:id',
    ]);
    expect(list).toEqual({ canManage: true, items: [aDomain] });
    expect(added.domain.id).toBe(DOMAIN);
    expect(one.domain.hostname).toBe('app.acme.com');
    expect(checked.domain.state).toBe('pending');
    expect(retried.domain.state).toBe('pending');
    expect(removed.domain.state).toBe('removing');
    expect(removed.deletableRecords).toHaveLength(2);
    // Add requires the key; retry's is optional and absent when not given.
    expect(keys.add).toBe('key-add');
    expect(keys['retry-5']).toBe('key-retry');
    expect(keys['retry-6']).toBeNull();
  });

  it('refuses to send a body the contract does not name', async () => {
    await expect(addDomain(ORG, PROJECT, { hostname: '   ' }, 'key')).rejects.toBeInstanceOf(
      ZodError,
    );
  });

  it('fails on a domain with an undeclared field rather than rendering it', async () => {
    server.use(
      http.get(`${PROJECT_PATH}/domains/${DOMAIN}`, () =>
        HttpResponse.json({ domain: { ...aDomain, token: 'secret' } }),
      ),
    );

    await expect(getDomain(ORG, PROJECT, DOMAIN)).rejects.toBeInstanceOf(ZodError);
  });

  it('lets a refusal through as an ApiProblem carrying its reason', async () => {
    server.use(
      http.post(`${PROJECT_PATH}/domains`, () =>
        problemResponse('conflict', 409, { limit: 10, reason: 'domain-limit' }),
      ),
    );

    const error = await addDomain(ORG, PROJECT, { hostname: 'app.acme.com' }, 'key').catch(
      (caught: unknown) => caught,
    );

    expect(ApiProblem.is(error, 'conflict')).toBe(true);
    expect((error as ApiProblem).detail?.reason).toBe('domain-limit');
  });
});
