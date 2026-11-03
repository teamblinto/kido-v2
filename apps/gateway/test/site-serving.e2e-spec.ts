import { createHash, createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createBrokerClient } from '../src/broker-client.ts';
import { REFUSED_PAGE } from '../src/pages.ts';
import { createPipeline } from '../src/pipeline.ts';
import { RouteCache } from '../src/route-cache.ts';
import { createRouteVerifier, createSiteVerifier } from '../src/route-verify.ts';
import { createManifestCache, createS3ArtifactStore } from '../src/site-serve.ts';

/**
 * T042, end to end over real sockets: the gateway wired as `main.ts` wires it for sites (the real
 * broker client, cache, site verifier, manifest cache and S3 client), a stub broker that signs
 * site records with a throwaway Ed25519 key (contracts/site-serving.md § 2–3), and a fake S3 on
 * `node:http` that **verifies each request's SigV4 signature** with its own, independent code
 * before it answers (§ 4). A wrong signature is a `403`, which the gateway must surface as 503.
 */

const PREVIEW_DOMAIN = 'forge-preview.localhost';
const SITE_DOMAIN = 'forge-site.localhost';
const SECRET = 'e2e-broker-secret';
const LIVE = 'my-site-7f3a';
const BADKEY = 'bad-key-site';
const BUCKET = 'artifacts';
const ACCESS_KEY = 'AKIDGATEWAYREADONLY';
const SECRET_KEY = 'gateway-read-only-secret';
const ORG = '0f6c5f9e-3c1a-4c56-9a4e-4b8f8d3c1a11';
const PROJECT = '6b1d1a7c-8a1b-4c3e-9e6f-2d3c4b5a6f70';

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

const INDEX = Buffer.from(
  '<!doctype html><title>deployed</title><script src="/assets/app-3f2a.js"></script>',
);
const APP_JS = Buffer.from('document.title = "deployed";');
const MANIFEST = Buffer.from(
  JSON.stringify({
    files: {
      'assets/app-3f2a.js': { sha: sha(APP_JS), size: APP_JS.length, type: 'text/javascript' },
      'index.html': { sha: sha(INDEX), size: INDEX.length, type: 'text/html; charset=utf-8' },
    },
    version: 1,
  }),
);
const ARTIFACT = sha(MANIFEST);
/** BADKEY's release: its own artifact, so its manifest is never already cached. */
const MANIFEST_2 = Buffer.from(
  JSON.stringify({
    files: {
      'index.html': { sha: sha(INDEX), size: INDEX.length, type: 'text/html; charset=utf-8' },
    },
    version: 1,
  }),
);
const ARTIFACT_2 = sha(MANIFEST_2);
/** ISOLATED's release (T066): its own artifact, so the cookie-carrying request reads both keys. */
const ISOLATED = 'isolated-site';
const MANIFEST_3 = Buffer.from(
  JSON.stringify({
    files: {
      'index.html': { sha: sha(INDEX), size: INDEX.length, type: 'text/html; charset=utf-8' },
      'robots.txt': { sha: sha(APP_JS), size: APP_JS.length, type: 'text/plain' },
    },
    version: 1,
  }),
);
const ARTIFACT_3 = sha(MANIFEST_3);
/** Labels the broker answers with a signed record; every other label is its one `404 {}`. */
const ARTIFACT_BY_LABEL = new Map([
  [LIVE, ARTIFACT],
  [BADKEY, ARTIFACT_2],
  [ISOLATED, ARTIFACT_3],
]);

const OBJECTS = new Map([
  [`${ORG}/${PROJECT}/${ARTIFACT}/manifest.json`, MANIFEST],
  [`${ORG}/${PROJECT}/${ARTIFACT_2}/manifest.json`, MANIFEST_2],
  [`${ORG}/${PROJECT}/${ARTIFACT_3}/manifest.json`, MANIFEST_3],
  [`${ORG}/${PROJECT}/blobs/${sha(INDEX)}`, INDEX],
  [`${ORG}/${PROJECT}/blobs/${sha(APP_JS)}`, APP_JS],
]);

const servers: Server[] = [];
/** Every object read the fake S3 accepted, and every one it refused, by key. */
const s3Accepted: string[] = [];
const s3Refused: string[] = [];
/** The request headers of every read the fake S3 received, by key. */
const s3Headers: { headers: IncomingMessage['headers']; key: string }[] = [];
const brokerAsked: string[] = [];
let gatewayPort: number;
/** While set, the gateway reads with a wrong secret, to prove the fake S3 really checks. */
let badStoreActive = false;

function listen(server: Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

/**
 * A SigV4 check written apart from `src/sigv4.ts`: rebuild the canonical request from what
 * arrived on the wire and compare signatures. `true` only for a request signed with SECRET_KEY,
 * for `s3` in region `auto`, dated within five minutes, `UNSIGNED-PAYLOAD`.
 */
function verifySigV4(req: IncomingMessage): boolean {
  const auth =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(
      req.headers.authorization ?? '',
    );
  if (auth === null) return false;
  const [, accessKey, day, region, service, signedHeaders, signature] = auth as unknown as string[];
  const amzDate = String(req.headers['x-amz-date']);
  const payload = String(req.headers['x-amz-content-sha256']);
  const names = signedHeaders!.split(';');
  if (
    accessKey !== ACCESS_KEY ||
    region !== 'auto' ||
    service !== 's3' ||
    payload !== 'UNSIGNED-PAYLOAD' ||
    !amzDate.startsWith(day!) ||
    !['host', 'x-amz-content-sha256', 'x-amz-date'].every((n) => names.includes(n))
  ) {
    return false;
  }
  const when = Date.parse(
    `${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`,
  );
  if (Math.abs(Date.now() - when) > 300_000) return false;

  const [path, query = ''] = (req.url ?? '').split('?');
  const canonical = [
    req.method,
    path,
    query,
    ...names.map((n) => `${n}:${String(req.headers[n]).trim()}`),
    '',
    signedHeaders,
    payload,
  ].join('\n');
  const scope = `${day!}/${region}/${service}/aws4_request`;
  const toSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha(canonical)}`;
  let key: Buffer = createHmac('sha256', `AWS4${SECRET_KEY}`).update(day!).digest();
  for (const part of [region, service, 'aws4_request']) {
    key = createHmac('sha256', key).update(part).digest();
  }
  return createHmac('sha256', key).update(toSign).digest('hex') === signature;
}

function createFakeS3(): Server {
  return createServer((req, res) => {
    req.resume();
    const key = decodeURIComponent((req.url ?? '').replace(`/${BUCKET}/`, ''));
    s3Headers.push({ headers: req.headers, key });
    if (req.method !== 'GET' || !verifySigV4(req)) {
      s3Refused.push(key);
      res
        .writeHead(403, { 'content-type': 'application/xml' })
        .end('<Error>SignatureDoesNotMatch</Error>');
      return;
    }
    s3Accepted.push(key);
    const body = OBJECTS.get(key);
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    // Hostile object metadata: the gateway must pass none of it on.
    res.writeHead(200, {
      'content-length': body.length,
      'content-type': 'application/octet-stream',
      'set-cookie': 'from-the-bucket=1',
      'x-amz-meta-type': 'text/evil',
    });
    res.end(body);
  });
}

function get(host: string, path = '/', method = 'GET', extra: Record<string, string> = {}) {
  return new Promise<{ body: Buffer; headers: IncomingMessage['headers']; status: number }>(
    (resolve, reject) => {
      const req = request(
        {
          headers: { ...extra, connection: 'close', host },
          host: '127.0.0.1',
          method,
          path,
          port: gatewayPort,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () =>
            resolve({
              body: Buffer.concat(chunks),
              headers: res.headers,
              status: res.statusCode ?? 0,
            }),
          );
        },
      );
      req.on('error', reject);
      req.end();
    },
  );
}

beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
  const jwks = {
    keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'EdDSA', kid: 'k1', use: 'sig' }],
  };
  const signSite = (label: string) =>
    new SignJWT({
      artifact: ARTIFACT_BY_LABEL.get(label),
      deployment: '3c2b1a0f-9e8d-4c7b-8a6f-5e4d3c2b1a0f',
      kind: 'site',
      label,
      org: ORG,
      project: PROJECT,
    })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'k1' })
      .setIssuedAt()
      .setExpirationTime('30s')
      .sign(pair.privateKey);

  const brokerPort = await listen(
    createServer((req, res) => {
      req.resume();
      const label = /^\/broker\/sites\/([^/]+)$/.exec(req.url ?? '')?.[1];
      if (
        req.headers['x-broker-secret'] !== SECRET ||
        req.method !== 'GET' ||
        label === undefined
      ) {
        res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
        return;
      }
      brokerAsked.push(label);
      if (!ARTIFACT_BY_LABEL.has(label)) {
        res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
        return;
      }
      void signSite(label).then((site) => {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ site }));
      });
    }),
  );
  const s3Port = await listen(createFakeS3());

  const cache = new RouteCache({ max: 100, ttlMs: 5000 });
  const broker = createBrokerClient({
    cache,
    origin: `http://127.0.0.1:${String(brokerPort)}`,
    sharedSecret: SECRET,
    transport: 'plain',
    verify: createRouteVerifier(jwks),
    verifySite: createSiteVerifier(jwks),
  });
  const storeTarget = {
    accessKeyId: ACCESS_KEY,
    bucket: BUCKET,
    endpoint: `http://127.0.0.1:${String(s3Port)}`,
    region: 'auto',
    secretAccessKey: SECRET_KEY,
  };
  const goodStore = createS3ArtifactStore(storeTarget);
  const badStore = createS3ArtifactStore({ ...storeTarget, secretAccessKey: 'not-the-key' });
  const pipeline = createPipeline({
    broker,
    previewDomain: PREVIEW_DOMAIN,
    productOrigin: 'https://app.example.test',
    site: {
      domain: SITE_DOMAIN,
      getSite: (label) => broker.getSite(label),
      manifests: createManifestCache(),
      store: { get: (key) => (badStoreActive ? badStore : goodStore).get(key) },
    },
    socketMaxMs: 60_000,
    upstreamTimeoutMs: 5000,
    verifyGrant: () => Promise.resolve(undefined),
    wakeBudgetMs: 90_000,
  });
  gatewayPort = await listen(createServer((req, res) => void pipeline.onRequest(req, res)));
});

afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
});

describe('site serving, end to end (T042)', () => {
  it('serves index.html at / from the SigV4-verified store, with generated headers only', async () => {
    const res = await get(`${LIVE}.${SITE_DOMAIN}:3200`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(INDEX);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers.etag).toBe(`"${sha(INDEX)}"`);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('public, max-age=0, must-revalidate');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['x-amz-meta-type']).toBeUndefined();
    expect(s3Accepted).toEqual(
      expect.arrayContaining([
        `${ORG}/${PROJECT}/${ARTIFACT}/manifest.json`,
        `${ORG}/${PROJECT}/blobs/${sha(INDEX)}`,
      ]),
    );
    expect(s3Refused).toEqual([]);
  });

  it('serves an asset with the immutable cache, from the cached record and manifest', async () => {
    const asked = brokerAsked.length;
    const manifestReads = s3Accepted.filter((k) => k.endsWith('manifest.json')).length;

    const res = await get(`${LIVE}.${SITE_DOMAIN}`, '/assets/app-3f2a.js');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(APP_JS);
    expect(res.headers['content-type']).toBe('text/javascript');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(brokerAsked.length).toBe(asked);
    expect(s3Accepted.filter((k) => k.endsWith('manifest.json')).length).toBe(manifestReads);
  });

  it('falls back to index.html for a client-side route', async () => {
    const res = await get(`${LIVE}.${SITE_DOMAIN}`, '/settings/profile');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(INDEX);
  });

  it('answers an unknown label with the uniform 404 bytes, identical to a path miss', async () => {
    const unknown = await get(`no-such-site.${SITE_DOMAIN}`);
    const miss = await get(`${LIVE}.${SITE_DOMAIN}`, '/missing.png');
    const notAHost = await get('example.test');

    expect(brokerAsked).toContain('no-such-site');
    for (const res of [unknown, miss, notAHost]) {
      expect(res.status).toBe(404);
      expect(res.body.toString()).toBe(REFUSED_PAGE.body);
    }
  });

  it('refuses a non-GET method with 405 and Allow', async () => {
    const res = await get(`${LIVE}.${SITE_DOMAIN}`, '/', 'POST');

    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe('GET, HEAD');
  });

  it('answers 503 when the store refuses the signature (403), and caches no manifest', async () => {
    badStoreActive = true;
    try {
      const res = await get(`${BADKEY}.${SITE_DOMAIN}`);

      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe('5');
      expect(s3Refused).toContain(`${ORG}/${PROJECT}/${ARTIFACT_2}/manifest.json`);
    } finally {
      badStoreActive = false;
    }

    // Nothing was cached from the refusal: with the right key the same release now serves.
    const res = await get(`${BADKEY}.${SITE_DOMAIN}`);
    expect(res.status).toBe(200);
    expect(s3Accepted).toContain(`${ORG}/${PROJECT}/${ARTIFACT_2}/manifest.json`);
  });
});

describe('isolation: a site is a stranger to the product (T066, SC-007 first half)', () => {
  /** What a browser sends when the product and a preview have both set their cookies. */
  const PRODUCT = {
    authorization: 'Bearer product-token',
    cookie: '__Host-session=product-session; __Host-preview_grant=preview-grant-jws',
    origin: 'https://app.example.test',
    'x-csrf-token': 'product-csrf',
    'x-forwarded-for': '203.0.113.9',
  };
  /** Every header the gateway's S3 client may send: SigV4's own, and Node's transport ones. */
  const S3_HEADERS = ['authorization', 'connection', 'host', 'x-amz-content-sha256', 'x-amz-date'];

  it('serves a request carrying product and preview cookies, forwarding none of them', async () => {
    const before = s3Headers.length;

    const res = await get(`${ISOLATED}.${SITE_DOMAIN}`, '/', 'GET', PRODUCT);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(INDEX);
    const reads = s3Headers.slice(before);
    expect(reads.map((r) => r.key)).toEqual([
      `${ORG}/${PROJECT}/${ARTIFACT_3}/manifest.json`,
      `${ORG}/${PROJECT}/blobs/${sha(INDEX)}`,
    ]);
    for (const { headers } of reads) {
      expect(headers.cookie).toBeUndefined();
      expect(Object.keys(headers).sort()).toEqual(S3_HEADERS);
      expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDGATEWAYREADONLY\//);
      const sent = JSON.stringify(headers);
      for (const value of Object.values(PRODUCT)) {
        expect(sent).not.toContain(value);
      }
    }
  });

  it('never sets a cookie, although every object the store returns carries set-cookie', async () => {
    for (const path of ['/', '/robots.txt', '/client/route']) {
      const res = await get(`${ISOLATED}.${SITE_DOMAIN}`, path, 'GET', PRODUCT);

      expect(res.status).toBe(200);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(res.headers['x-amz-meta-type']).toBeUndefined();
      expect(Object.keys(res.headers).sort()).toEqual(
        [
          'cache-control',
          'connection',
          'content-length',
          'content-type',
          'date',
          'etag',
          'x-content-type-options',
        ].sort(),
      );
    }
    // The metadata was there to be leaked: the fake S3 sent it on this very file's reads.
    expect(s3Headers.some((r) => r.key.endsWith('manifest.json'))).toBe(true);
  });
});

describe('uniform refusal (T067, FR-030)', () => {
  /** A label the broker refuses; the API's `SiteRouteService` refuses all three the same way. */
  const refusedHosts = [
    ['an unknown label', `no-such-site.${SITE_DOMAIN}`],
    ['a never-deployed label', `never-deployed-site.${SITE_DOMAIN}`],
    ['an offline label', `offline-site.${SITE_DOMAIN}`],
    ['a host under neither domain', 'evil.example.test'],
    ['the bare site domain', SITE_DOMAIN],
    ['a label two levels down', `a.${LIVE}.${SITE_DOMAIN}`],
    ['a malformed label', `-bad-.${SITE_DOMAIN}`],
  ] as const;
  /** Each traversal form against a live site; none may reach a key outside the manifest. */
  const traversals = [
    '/../index.html',
    '/assets/../index.html',
    '/./index.html',
    '/%2e%2e/index.html',
    '/assets/%2E%2E/index.html',
    '/%2F..%2Findex.html',
    '/assets%2findex.html',
    '/%5C..%5Cindex.html',
    '/..\\index.html',
    '/index.html%00',
    '/%00',
    '/%E0%A4%A',
    '/manifest.json',
    `/${ARTIFACT}/manifest.json`,
  ];

  it('answers every refusal with the same status and the same body bytes', async () => {
    const reference = await get(`${LIVE}.${SITE_DOMAIN}`, '/missing.png');
    expect(reference.status).toBe(404);
    expect(reference.body.toString()).toBe(REFUSED_PAGE.body);

    const cases = [
      ...refusedHosts.map(([name, host]) => ({ host, name, path: '/' })),
      ...traversals.map((path) => ({ host: `${LIVE}.${SITE_DOMAIN}`, name: path, path })),
    ];
    for (const { host, name, path } of cases) {
      const res = await get(host, path);

      expect({ name, status: res.status }).toEqual({ name, status: reference.status });
      expect({ body: res.body.equals(reference.body), name }).toEqual({ body: true, name });
      expect({ name, type: res.headers['content-type'] }).toEqual({
        name,
        type: reference.headers['content-type'],
      });
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    expect(brokerAsked).toEqual(
      expect.arrayContaining(['no-such-site', 'never-deployed-site', 'offline-site']),
    );
  });
});
