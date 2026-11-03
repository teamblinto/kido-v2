import { createHash } from 'node:crypto';
import {
  createServer,
  request,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { REFUSED_PAGE } from './pages.ts';
import { signS3Get } from './sigv4.ts';
import {
  type ArtifactStore,
  assetIndexKey,
  createManifestCache,
  MAX_ASSET_INDEX_BYTES,
  createS3ArtifactStore,
  parseManifest,
  resolveSitePath,
  serveSite,
  type SiteManifest,
  siteHeaders,
  type SiteTarget,
} from './site-serve.ts';

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

const INDEX = Buffer.from('<!doctype html><title>app</title>');
const APP_JS = Buffer.from('console.log("app")');
const LOGO = Buffer.from('png-bytes');

const MANIFEST: SiteManifest = {
  files: {
    'assets/app-3f2a.js': { sha: sha(APP_JS), size: APP_JS.length, type: 'text/javascript' },
    'docs/index.html': { sha: sha(INDEX), size: INDEX.length, type: 'text/html; charset=utf-8' },
    'img/logo.png': { sha: sha(LOGO), size: LOGO.length, type: 'image/png' },
    'index.html': { sha: sha(INDEX), size: INDEX.length, type: 'text/html; charset=utf-8' },
  },
  version: 1,
};

/** The canonical form (keys sorted at every level, no whitespace), as the worker writes it. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

const MANIFEST_BYTES = Buffer.from(canonical(MANIFEST));
const TARGET: SiteTarget = {
  artifact: sha(MANIFEST_BYTES),
  org: '11111111-1111-4111-8111-111111111111',
  project: '22222222-2222-4222-8222-222222222222',
};
const PREFIX = `${TARGET.org}/${TARGET.project}`;

/** An asset of an earlier release: in the bucket and the asset index, not in MANIFEST. */
const OLD_JS = Buffer.from('console.log("old release")');
const OLD_ENTRY = { sha: sha(OLD_JS), size: OLD_JS.length, type: 'text/javascript' };
const OLD_INDEX_KEY = `${PREFIX}/asset-index/assets/old-9c1d.js`;

describe('resolveSitePath (contracts/site-serving.md § 5)', () => {
  it.each([
    ['/', 'index.html'],
    ['/?utm=1', 'index.html'],
    ['/docs/', 'docs/index.html'],
    ['/assets/app-3f2a.js', 'assets/app-3f2a.js'],
    ['/assets/app-3f2a.js?v=2#x', 'assets/app-3f2a.js'],
    ['/img/logo%2Epng', 'img/logo.png'],
    ['/about', 'index.html'],
    ['/users/42/settings', 'index.html'],
    ['/users/', 'index.html'],
  ])('%s → %s', (url, key) => {
    expect(resolveSitePath(url, MANIFEST)).toBe(key);
  });

  it.each([
    '/missing.png',
    '/assets/gone-0000.js',
    '/a%2Fb',
    '/a%2fb.js',
    '/a%5Cb',
    '/a%5cindex.html',
    '/a%00',
    '/index.html%00',
    '/../index.html',
    '/docs/../index.html',
    '/docs/%2E%2E/index.html',
    '/a\\b',
    '/%E0%A4%A',
    '',
    'index.html',
  ])('%s → 404', (url) => {
    expect(resolveSitePath(url, MANIFEST)).toBeUndefined();
  });
});

describe('siteHeaders', () => {
  it('generates Content-Type from the manifest, nosniff, ETag and a long cache under assets/', () => {
    expect(siteHeaders('assets/app-3f2a.js', MANIFEST.files['assets/app-3f2a.js']!)).toEqual({
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Length': String(APP_JS.length),
      'Content-Type': 'text/javascript',
      ETag: `"${sha(APP_JS)}"`,
      'X-Content-Type-Options': 'nosniff',
    });
  });

  it('revalidates everything outside assets/', () => {
    for (const key of ['index.html', 'img/logo.png', 'docs/index.html']) {
      expect(siteHeaders(key, MANIFEST.files[key]!)['Cache-Control']).toBe(
        'public, max-age=0, must-revalidate',
      );
    }
  });
});

describe('parseManifest', () => {
  it('accepts the canonical manifest whose sha-256 is the artifact', () => {
    expect(parseManifest(MANIFEST_BYTES, TARGET.artifact)).toEqual(MANIFEST);
  });

  it('refuses bytes whose sha-256 is not the artifact', () => {
    expect(parseManifest(MANIFEST_BYTES, sha('other'))).toBeUndefined();
  });

  it.each([
    ['not JSON', 'nope'],
    ['files as an array', '{"files":[],"version":1}'],
    ['files as null', '{"files":null,"version":1}'],
    ['files as a string', '{"files":"index.html","version":1}'],
    ['a wrong version', { files: {}, version: 2 }],
    [
      'a bad sha',
      { files: { 'a.js': { sha: 'XYZ', size: 1, type: 'text/javascript' } }, version: 1 },
    ],
    [
      'a negative size',
      { files: { 'a.js': { sha: sha('a'), size: -1, type: 'text/javascript' } }, version: 1 },
    ],
    [
      'a ".." path',
      { files: { '../a.js': { sha: sha('a'), size: 1, type: 'text/javascript' } }, version: 1 },
    ],
    [
      'an absolute path',
      { files: { '/a.js': { sha: sha('a'), size: 1, type: 'text/javascript' } }, version: 1 },
    ],
    [
      'a backslash',
      { files: { 'a\\b.js': { sha: sha('a'), size: 1, type: 'text/javascript' } }, version: 1 },
    ],
    [
      'a NUL',
      { files: { 'a\u0000.js': { sha: sha('a'), size: 1, type: 'text/javascript' } }, version: 1 },
    ],
    [
      'a header-breaking type',
      {
        files: { 'a.js': { sha: sha('a'), size: 1, type: 'text/html\r\nSet-Cookie: x=1' } },
        version: 1,
      },
    ],
    [
      'over 100 MiB in total',
      {
        files: { 'a.js': { sha: sha('a'), size: 100 * 1024 * 1024 + 1, type: 'text/javascript' } },
        version: 1,
      },
    ],
  ])('refuses %s', (_name, value) => {
    const bytes = Buffer.from(typeof value === 'string' ? value : canonical(value));
    expect(parseManifest(bytes, sha(bytes))).toBeUndefined();
  });

  /**
   * The API writes a file named `__proto__` as an ordinary key (artifact.ts). JSON.parse makes it
   * an own property; the validated manifest must keep it one, not turn it into a prototype.
   */
  it('refuses more than 10,000 files', () => {
    const entry = { sha: sha('a'), size: 1, type: 'text/plain' };
    const files = Object.fromEntries(
      Array.from({ length: 10_001 }, (_, index) => [`f${String(index)}.txt`, entry]),
    );
    const bytes = Buffer.from(canonical({ files, version: 1 }));
    expect(parseManifest(bytes, sha(bytes))).toBeUndefined();
  });

  it('keeps a __proto__ path as an own entry, and serves it by exact key only', () => {
    const entry = { sha: sha('p'), size: 1, type: 'application/octet-stream' };
    const bytes = Buffer.from(
      `{"files":{"__proto__":${canonical(entry)},"index.html":${canonical(MANIFEST.files['index.html'])}},"version":1}`,
    );
    const manifest = parseManifest(bytes, sha(bytes))!;

    expect(manifest).toBeDefined();
    expect(Object.hasOwn(manifest.files, '__proto__')).toBe(true);
    expect(Object.keys(manifest.files).sort()).toEqual(['__proto__', 'index.html']);
    expect(Object.getPrototypeOf(manifest.files)).toBeNull();
    expect(resolveSitePath('/__proto__', manifest)).toBe('__proto__');
    // Inherited names are not files: the SPA fallback, not the prototype, answers them.
    expect(resolveSitePath('/constructor', manifest)).toBe('index.html');
    expect(resolveSitePath('/constructor.js', manifest)).toBeUndefined();
  });
});

interface FakeStore extends ArtifactStore {
  failing: boolean;
  gets: string[];
  objects: Map<string, Buffer>;
}

/** Objects carry hostile metadata: none of it may reach the client. */
function fakeStore(): FakeStore {
  const store: FakeStore = {
    failing: false,
    gets: [],
    objects: new Map([
      [`${PREFIX}/${TARGET.artifact}/manifest.json`, MANIFEST_BYTES],
      [`${PREFIX}/blobs/${sha(INDEX)}`, INDEX],
      [`${PREFIX}/blobs/${sha(APP_JS)}`, APP_JS],
      [`${PREFIX}/blobs/${sha(OLD_JS)}`, OLD_JS],
      [OLD_INDEX_KEY, Buffer.from(canonical(OLD_ENTRY))],
      // An index entry outside assets/: never consulted.
      [`${PREFIX}/asset-index/img/old.png`, Buffer.from(canonical(OLD_ENTRY))],
    ]),
    get(key) {
      store.gets.push(key);
      if (store.failing) return Promise.reject(new Error('store down'));
      const bytes = store.objects.get(key);
      return Promise.resolve(
        bytes === undefined
          ? undefined
          : {
              body: Readable.from([bytes]),
              headers: {
                'content-type': 'text/evil',
                'set-cookie': ['session=stolen'],
                'x-amz-meta-type': 'text/evil',
              },
            },
      );
    },
  };
  return store;
}

describe('serveSite', () => {
  let server: Server;
  let base: string;
  let store: FakeStore;
  let target: SiteTarget;
  let manifests: ReturnType<typeof createManifestCache>;

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void serveSite(req, res, target, { manifests, store });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  function reset() {
    store = fakeStore();
    target = TARGET;
    manifests = createManifestCache();
  }
  reset();
  afterEach(reset);

  it('serves index.html at / with generated headers only', async () => {
    const res = await fetch(`${base}/`);

    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(INDEX);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-length')).toBe(String(INDEX.length));
    expect(res.headers.get('etag')).toBe(`"${sha(INDEX)}"`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('x-robots-tag')).toBeNull();
    expect(res.headers.get('x-amz-meta-type')).toBeNull();
  });

  it('serves an asset with the immutable cache and no Set-Cookie', async () => {
    const res = await fetch(`${base}/assets/app-3f2a.js`, { headers: { cookie: 'a=b' } });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(APP_JS.toString());
    expect(res.headers.get('content-type')).toBe('text/javascript');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('falls back to index.html for an extensionless miss (SPA)', async () => {
    const res = await fetch(`${base}/dashboard/settings`);

    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(INDEX);
  });

  it.each(['/missing.png', '/a%2Fb', '/a%5Cb', '/a%00'])('%s → the uniform 404', async (path) => {
    const res = await fetch(`${base}${path}`);

    expect(res.status).toBe(404);
    expect(await res.text()).toBe(REFUSED_PAGE.body);
    expect(store.gets.some((key) => key.includes('/blobs/'))).toBe(false);
  });

  it('answers 304 with the same headers and no body when If-None-Match matches', async () => {
    const res = await fetch(`${base}/`, { headers: { 'if-none-match': `W/"x", "${sha(INDEX)}"` } });

    expect(res.status).toBe(304);
    expect(await res.text()).toBe('');
    expect(res.headers.get('etag')).toBe(`"${sha(INDEX)}"`);
    expect(res.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    expect(store.gets.some((key) => key.includes('/blobs/'))).toBe(false);
  });

  it('serves the body when If-None-Match does not match', async () => {
    const res = await fetch(`${base}/`, { headers: { 'if-none-match': '"other"' } });

    expect(res.status).toBe(200);
  });

  it('answers HEAD with headers and no body, without reading the blob', async () => {
    const res = await fetch(`${base}/assets/app-3f2a.js`, { method: 'HEAD' });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String(APP_JS.length));
    expect(res.headers.get('etag')).toBe(`"${sha(APP_JS)}"`);
    expect(await res.text()).toBe('');
    expect(store.gets.some((key) => key.includes('/blobs/'))).toBe(false);
  });

  it.each(['POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'])('%s → 405 with Allow', async (method) => {
    const res = await fetch(`${base}/`, { method });

    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(store.gets).toEqual([]);
  });

  it('refuses a manifest whose sha-256 is not the artifact: 503, never served', async () => {
    const forged = Buffer.from(canonical({ ...MANIFEST, files: {} }));
    store.objects.set(`${PREFIX}/${TARGET.artifact}/manifest.json`, forged);

    const res = await fetch(`${base}/`);

    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(await res.text()).not.toContain('app');
  });

  it('answers 503 for a missing manifest and for an unreachable store', async () => {
    target = { ...TARGET, artifact: sha('never-uploaded') };
    expect((await fetch(`${base}/`)).status).toBe(503);

    target = TARGET;
    store.failing = true;
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
  });

  it('answers 502 when the manifest names a blob the store does not have', async () => {
    const res = await fetch(`${base}/img/logo.png`);

    expect(res.status).toBe(502);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('fetches a manifest once per artifact, then serves from the cache', async () => {
    await fetch(`${base}/`);
    await fetch(`${base}/assets/app-3f2a.js`);

    expect(store.gets.filter((key) => key.endsWith('manifest.json'))).toHaveLength(1);
  });

  it('refuses a manifest over the byte cap: 503, and nothing is cached', async () => {
    const capped = { manifests, maxManifestBytes: MANIFEST_BYTES.length - 1, store };
    const capServer = createServer((req, res) => void serveSite(req, res, target, capped));
    await new Promise<void>((resolve) => capServer.listen(0, '127.0.0.1', resolve));
    try {
      const port = (capServer.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${String(port)}/`);

      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('5');
      expect(manifests.get(TARGET.artifact)).toBeUndefined();
    } finally {
      await new Promise((resolve) => capServer.close(resolve));
    }
    // At exactly the cap it is served.
    expect((await fetch(`${base}/`)).status).toBe(200);
  });

  describe('an asset of an earlier release, through the asset index (FR-025)', () => {
    const indexGets = () => store.gets.filter((key) => key.includes('/asset-index/'));

    it('names the index key under the project prefix', () => {
      expect(assetIndexKey(TARGET, 'assets/old-9c1d.js')).toBe(OLD_INDEX_KEY);
    });

    it('serves it with the same generated, immutable headers as a manifest hit', async () => {
      const res = await fetch(`${base}/assets/old-9c1d.js?v=1`);

      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer())).toEqual(OLD_JS);
      expect(Object.fromEntries(res.headers)).toMatchObject({
        'cache-control': 'public, max-age=31536000, immutable',
        'content-length': String(OLD_JS.length),
        'content-type': 'text/javascript',
        etag: `"${sha(OLD_JS)}"`,
        'x-content-type-options': 'nosniff',
      });
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(res.headers.get('x-amz-meta-type')).toBeNull();
      expect(indexGets()).toEqual([OLD_INDEX_KEY]);
    });

    it('answers HEAD and a matching If-None-Match without reading the blob', async () => {
      const head = await fetch(`${base}/assets/old-9c1d.js`, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(head.headers.get('etag')).toBe(`"${sha(OLD_JS)}"`);

      const cached = await fetch(`${base}/assets/old-9c1d.js`, {
        headers: { 'if-none-match': `"${sha(OLD_JS)}"` },
      });
      expect(cached.status).toBe(304);
      expect(store.gets.some((key) => key.includes('/blobs/'))).toBe(false);
    });

    it('never consults the index for a path the current manifest has', async () => {
      store.objects.set(
        `${PREFIX}/asset-index/assets/app-3f2a.js`,
        Buffer.from(canonical(OLD_ENTRY)),
      );
      const res = await fetch(`${base}/assets/app-3f2a.js`);

      expect(await res.text()).toBe(APP_JS.toString());
      expect(indexGets()).toEqual([]);
    });

    it.each(['/img/old.png', '/old-9c1d.js', '/assetsold.js', '/docs/assets/old-9c1d.js'])(
      'a miss outside assets/ (%s) is the uniform 404, with no index read',
      async (path) => {
        const res = await fetch(`${base}${path}`);

        expect(res.status).toBe(404);
        expect(await res.text()).toBe(REFUSED_PAGE.body);
        expect(indexGets()).toEqual([]);
      },
    );

    it('an extensionless path under assets/ keeps the SPA fallback, with no index read', async () => {
      const res = await fetch(`${base}/assets/nothing-here`);

      expect(Buffer.from(await res.arrayBuffer())).toEqual(INDEX);
      expect(indexGets()).toEqual([]);
    });

    it('an asset in no release is the uniform 404', async () => {
      const res = await fetch(`${base}/assets/never-0000.js`);

      expect(res.status).toBe(404);
      expect(await res.text()).toBe(REFUSED_PAGE.body);
      expect(indexGets()).toEqual([`${PREFIX}/asset-index/assets/never-0000.js`]);
    });

    it.each([
      '/assets/../assets/old-9c1d.js',
      '/assets/%2E%2E/assets/old-9c1d.js',
      '/assets/%2e%2e/%2e%2e/other-project/asset-index/assets/x.js',
      '/assets/..%2Fx.js',
      '/assets%2Fold-9c1d.js',
      '/assets/a%5Cb.js',
      '/assets/a%00.js',
      '/assets//old-9c1d.js',
      '/assets/./old-9c1d.js',
    ])('refuses a traversal through the index path: %s → 404, no index read', async (path) => {
      // Sent verbatim: `fetch` would normalise `.` and `..` segments before they left the client.
      const res = await new Promise<{ body: string; status: number }>((resolve, reject) => {
        const req = request(`${base}/`, { path }, (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
          incoming.on('end', () =>
            resolve({ body: Buffer.concat(chunks).toString(), status: incoming.statusCode ?? 0 }),
          );
        });
        req.on('error', reject);
        req.end();
      });

      expect(res.status).toBe(404);
      expect(res.body).toBe(REFUSED_PAGE.body);
      expect(indexGets()).toEqual([]);
      expect(store.gets.some((key) => key.includes('/blobs/'))).toBe(false);
    });

    it.each([
      ['not JSON', 'nope'],
      ['a bare sha', sha(OLD_JS)],
      ['a bad sha', canonical({ ...OLD_ENTRY, sha: 'XYZ' })],
      ['an uppercase sha', canonical({ ...OLD_ENTRY, sha: sha(OLD_JS).toUpperCase() })],
      ['a negative size', canonical({ ...OLD_ENTRY, size: -1 })],
      ['a fractional size', canonical({ ...OLD_ENTRY, size: 1.5 })],
      ['an oversized size', canonical({ ...OLD_ENTRY, size: 100 * 1024 * 1024 + 1 })],
      ['a header-breaking type', canonical({ ...OLD_ENTRY, type: 'text/html\r\nSet-Cookie: a=1' })],
      ['a missing type', canonical({ sha: OLD_ENTRY.sha, size: OLD_ENTRY.size })],
      ['an array', '[]'],
      ['null', 'null'],
      ['over the byte cap', ' '.repeat(MAX_ASSET_INDEX_BYTES + 1)],
    ])('a malformed index entry (%s) is 503, never served', async (_name, body) => {
      store.objects.set(OLD_INDEX_KEY, Buffer.from(body));

      const res = await fetch(`${base}/assets/old-9c1d.js`);

      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('5');
      expect(await res.text()).not.toContain('old release');
      expect(store.gets.some((key) => key.includes('/blobs/'))).toBe(false);
    });

    it('an entry at exactly the byte cap is read', async () => {
      const body = canonical(OLD_ENTRY);
      store.objects.set(
        OLD_INDEX_KEY,
        Buffer.from(body + ' '.repeat(MAX_ASSET_INDEX_BYTES - Buffer.byteLength(body))),
      );

      expect((await fetch(`${base}/assets/old-9c1d.js`)).status).toBe(200);
    });

    it('an unreachable store while reading the index is 503', async () => {
      await fetch(`${base}/`); // cache the manifest
      store.failing = true;

      const res = await fetch(`${base}/assets/old-9c1d.js`);
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('5');
    });

    it('an entry naming a blob the store does not have is 502', async () => {
      store.objects.delete(`${PREFIX}/blobs/${sha(OLD_JS)}`);

      expect((await fetch(`${base}/assets/old-9c1d.js`)).status).toBe(502);
    });

    it('reads another project’s index never: the key is always the target’s prefix', async () => {
      target = { ...TARGET, project: '33333333-3333-4333-8333-333333333333' };
      store.objects.set(
        `${TARGET.org}/${target.project}/${TARGET.artifact}/manifest.json`,
        MANIFEST_BYTES,
      );

      const res = await fetch(`${base}/assets/old-9c1d.js`);
      expect(res.status).toBe(404);
      expect(indexGets()).toEqual([
        `${TARGET.org}/${target.project}/asset-index/assets/old-9c1d.js`,
      ]);
    });
  });

  it('answers 503 when the store fails reading the blob', async () => {
    await fetch(`${base}/`); // cache the manifest
    store.failing = true;

    const res = await fetch(`${base}/`);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
  });

  it('destroys the response when the blob stream fails after the headers', async () => {
    const read = store.get.bind(store);
    store.get = (key) =>
      key.includes('/blobs/')
        ? Promise.resolve({
            body: new Readable({
              read() {
                this.push(INDEX.subarray(0, 5));
                this.destroy(new Error('connection reset'));
              },
            }),
            headers: {},
          })
        : read(key);

    // Never a complete body: the socket closes, before or after the headers reach the client.
    await expect(fetch(`${base}/`).then((res) => res.arrayBuffer())).rejects.toThrow();
  });

  it('treats a request with no url as /', async () => {
    const req = Object.assign(Readable.from([]), { headers: {}, method: 'HEAD', url: undefined });
    const res = { end: vi.fn(), writeHead: vi.fn() };
    res.writeHead.mockReturnValue(res);

    await serveSite(req as unknown as IncomingMessage, res as unknown as ServerResponse, TARGET, {
      manifests,
      store,
    });

    expect(res.writeHead).toHaveBeenCalledWith(
      200,
      siteHeaders('index.html', MANIFEST.files['index.html']!),
    );
  });

  it('does not cache a refused manifest', async () => {
    store.failing = true;
    await fetch(`${base}/`);
    store.failing = false;

    expect((await fetch(`${base}/`)).status).toBe(200);
  });
});

describe('createManifestCache', () => {
  it('holds 256 artifacts by default and evicts the least recently used', () => {
    const cache = createManifestCache();
    for (let i = 0; i < 257; i++) cache.set(`a${String(i)}`, MANIFEST);

    expect(cache.get('a0')).toBeUndefined();
    expect(cache.get('a1')).toBe(MANIFEST);
    cache.set('b', MANIFEST);
    expect(cache.get('a1')).toBe(MANIFEST);
    expect(cache.get('a2')).toBeUndefined();
  });
});

describe('createS3ArtifactStore', () => {
  const now = () => new Date('2026-09-22T10:11:12Z');
  let s3: Server;
  let endpoint: string;
  let seen: { authorization?: string; path?: string }[] = [];

  beforeAll(async () => {
    s3 = createServer((req, res) => {
      seen.push({ authorization: req.headers.authorization, path: req.url });
      const key = decodeURIComponent((req.url ?? '').replace(/^\/artifacts\//, ''));
      const expected = signS3Get(target(), key, now);
      if (req.headers.authorization !== expected.headers.authorization) {
        res.writeHead(403).end();
      } else if (key === 'org/p/blobs/a b') {
        res.writeHead(200, { 'content-type': 'text/evil' }).end('hello');
      } else if (key === 'org/p/boom') {
        res.writeHead(500).end();
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => s3.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${String((s3.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => s3.close(resolve));
  });

  afterEach(() => {
    seen = [];
  });

  const target = () => ({
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    bucket: 'artifacts',
    endpoint,
    region: 'auto',
    secretAccessKey: 'secret',
  });

  it('reads an object with a SigV4-signed path-style GET', async () => {
    const object = await createS3ArtifactStore(target(), { now }).get('org/p/blobs/a b');

    expect(object).toBeDefined();
    const chunks: Buffer[] = [];
    for await (const chunk of object!.body) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('hello');
    expect(seen[0]?.path).toBe('/artifacts/org/p/blobs/a%20b');
  });

  it('answers undefined for 404 and throws for anything else', async () => {
    const client = createS3ArtifactStore(target(), { now });

    await expect(client.get('org/p/missing')).resolves.toBeUndefined();
    await expect(client.get('org/p/boom')).rejects.toThrow();
    await expect(
      createS3ArtifactStore({ ...target(), secretAccessKey: 'wrong' }, { now }).get(
        'org/p/blobs/a b',
      ),
    ).rejects.toThrow();
  });

  it('dials an https endpoint over TLS: a plain-HTTP listener fails the read', async () => {
    const client = createS3ArtifactStore(
      { ...target(), endpoint: endpoint.replace('http:', 'https:') },
      { now, timeoutMs: 2_000 },
    );

    await expect(client.get('org/p/blobs/a b')).rejects.toThrow();
    expect(seen).toEqual([]);
  });

  it('gives up on a store that accepts but never answers', async () => {
    const silent = createServer(() => undefined);
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    try {
      const port = (silent.address() as AddressInfo).port;
      const client = createS3ArtifactStore(
        { ...target(), endpoint: `http://127.0.0.1:${String(port)}` },
        { now, timeoutMs: 50 },
      );

      await expect(client.get('k')).rejects.toThrow('object store timeout');
    } finally {
      silent.closeAllConnections();
      await new Promise((resolve) => silent.close(resolve));
    }
  });

  it('throws when the store does not answer', async () => {
    const client = createS3ArtifactStore(
      { ...target(), endpoint: 'http://127.0.0.1:1' },
      { now, timeoutMs: 500 },
    );

    await expect(client.get('k')).rejects.toThrow();
  });
});
