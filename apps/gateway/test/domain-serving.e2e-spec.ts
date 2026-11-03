import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBrokerClient } from '../src/broker-client.ts';
import { createEdgeOriginCheck } from '../src/edge-origin.ts';
import { REFUSED_PAGE } from '../src/pages.ts';
import { createPipeline } from '../src/pipeline.ts';
import { RouteCache } from '../src/route-cache.ts';
import {
  createDomainVerifier,
  createRouteVerifier,
  createSiteVerifier,
} from '../src/route-verify.ts';
import { createManifestCache, createS3ArtifactStore } from '../src/site-serve.ts';

/**
 * T035, end to end over real sockets: the gateway wired as `main.ts` wires it for custom domains
 * (the real broker client, cache, domain verifier, edge-origin check, manifest cache and S3
 * client), a stub broker that signs domain records with a throwaway Ed25519 key
 * (contracts/domain-serving.md § 2), and a fake S3 on `node:http`. The edge is played by the test
 * itself: it adds `X-Forge-Edge`, or does not.
 */

const PREVIEW_DOMAIN = 'forge-preview.localhost';
const SITE_DOMAIN = 'forge-site.localhost';
const BROKER_SECRET = 'e2e-broker-secret';
const EDGE_SECRET = 'e2e-edge-origin-secret-0123456789abcdef';
const BUCKET = 'artifacts';
const ORG = '0f6c5f9e-3c1a-4c56-9a4e-4b8f8d3c1a11';
const PROJECT = '6b1d1a7c-8a1b-4c3e-9e6f-2d3c4b5a6f70';
/** A live domain: the broker signs a record for exactly this hostname. */
const HOST_A = 'www.acme-example.com';
/** A misbehaving broker's answer for B is A's record (a replay the gateway must refuse). */
const HOST_B = 'shop.acme-example.com';
/** A hostname the broker refuses (removed, pending, or never added: one `404 {}`). */
const HOST_GONE = 'old.acme-example.com';

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

const INDEX = Buffer.from('<!doctype html><title>on a custom domain</title>');
const MANIFEST = Buffer.from(
  JSON.stringify({
    files: {
      'index.html': { sha: sha(INDEX), size: INDEX.length, type: 'text/html; charset=utf-8' },
    },
    version: 1,
  }),
);
const ARTIFACT = sha(MANIFEST);
const OBJECTS = new Map([
  [`${ORG}/${PROJECT}/${ARTIFACT}/manifest.json`, MANIFEST],
  [`${ORG}/${PROJECT}/blobs/${sha(INDEX)}`, INDEX],
]);

/** What a browser sends when the product and a preview have both set their cookies. */
const PRODUCT = {
  authorization: 'Bearer product-token',
  cookie: '__Host-session=product-session; __Host-preview_grant=preview-grant-jws',
};

const servers: Server[] = [];
const brokerAsked: { headers: IncomingMessage['headers']; hostname: string }[] = [];
const s3Headers: IncomingMessage['headers'][] = [];
/** Every line written to the console or the process streams while a test runs. */
let logged: string[] = [];
let gatewayPort: number;

function listen(server: Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function get(host: string, headers: Record<string, string> = {}, path = '/') {
  return new Promise<{ body: Buffer; headers: IncomingMessage['headers']; status: number }>(
    (resolve, reject) => {
      const req = request(
        {
          headers: { ...headers, connection: 'close', host },
          host: '127.0.0.1',
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

const fromEdge = (extra: Record<string, string> = {}) => ({
  ...extra,
  'X-Forge-Edge': EDGE_SECRET,
});

beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
  const jwks = {
    keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'EdDSA', kid: 'k1', use: 'sig' }],
  };
  const signDomain = (hostname: string) =>
    new SignJWT({
      artifact: ARTIFACT,
      deployment: '3c2b1a0f-9e8d-4c7b-8a6f-5e4d3c2b1a0f',
      hostname,
      kind: 'domain',
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
      const raw = /^\/broker\/domains\/([^/]+)$/.exec(req.url ?? '')?.[1];
      if (
        req.headers['x-broker-secret'] !== BROKER_SECRET ||
        req.method !== 'GET' ||
        raw === undefined
      ) {
        res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
        return;
      }
      const hostname = decodeURIComponent(raw);
      brokerAsked.push({ headers: req.headers, hostname });
      const signedFor = hostname === HOST_A ? HOST_A : hostname === HOST_B ? HOST_A : undefined;
      if (signedFor === undefined) {
        res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
        return;
      }
      void signDomain(signedFor).then((domain) => {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ domain }));
      });
    }),
  );
  const s3Port = await listen(
    createServer((req, res) => {
      req.resume();
      s3Headers.push(req.headers);
      const body = OBJECTS.get(decodeURIComponent((req.url ?? '').replace(`/${BUCKET}/`, '')));
      if (body === undefined) {
        res.writeHead(404).end();
        return;
      }
      // Hostile object metadata: the gateway must pass none of it on.
      res.writeHead(200, { 'content-length': body.length, 'set-cookie': 'from-the-bucket=1' });
      res.end(body);
    }),
  );

  const broker = createBrokerClient({
    cache: new RouteCache({ max: 100, ttlMs: 5000 }),
    origin: `http://127.0.0.1:${String(brokerPort)}`,
    sharedSecret: BROKER_SECRET,
    transport: 'plain',
    verify: createRouteVerifier(jwks),
    verifyDomain: createDomainVerifier(jwks),
    verifySite: createSiteVerifier(jwks),
  });
  const pipeline = createPipeline({
    broker,
    domain: {
      fromEdge: createEdgeOriginCheck(EDGE_SECRET),
      getDomain: (hostname) => broker.getDomain(hostname),
    },
    previewDomain: PREVIEW_DOMAIN,
    productOrigin: 'https://app.example.test',
    site: {
      domain: SITE_DOMAIN,
      getSite: (label) => broker.getSite(label),
      manifests: createManifestCache(),
      store: createS3ArtifactStore({
        accessKeyId: 'AKIDGATEWAYREADONLY',
        bucket: BUCKET,
        endpoint: `http://127.0.0.1:${String(s3Port)}`,
        region: 'auto',
        secretAccessKey: 'gateway-read-only-secret',
      }),
    },
    socketMaxMs: 60_000,
    upstreamTimeoutMs: 5000,
    verifyGrant: () => Promise.resolve(undefined),
    wakeBudgetMs: 90_000,
  });
  gatewayPort = await listen(createServer((req, res) => void pipeline.onRequest(req, res)));
});

beforeEach(() => {
  logged = [];
  const capture = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  };
  for (const method of ['debug', 'error', 'info', 'log', 'warn'] as const) {
    vi.spyOn(console, method).mockImplementation(capture);
  }
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    vi.spyOn(stream, 'write').mockImplementation((chunk: unknown, ...rest: unknown[]) => {
      logged.push(String(chunk));
      return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
});

describe('custom-domain serving, end to end (T035)', () => {
  it('serves the release from the edge, with generated headers only', async () => {
    const res = await get(`${HOST_A}:3200`, fromEdge());

    expect(res.status).toBe(200);
    expect(res.body).toEqual(INDEX);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(brokerAsked.map((a) => a.hostname)).toContain(HOST_A);
  });

  it('refuses the same hostname without the edge header, asking the broker nothing (US2-7)', async () => {
    const asked = brokerAsked.length;

    for (const headers of [{}, { 'X-Forge-Edge': 'not-the-edge-secret' }] as Record<
      string,
      string
    >[]) {
      const res = await get(HOST_A, headers);

      expect(res.status).toBe(404);
      expect(res.body.toString()).toBe(REFUSED_PAGE.body);
    }
    expect(brokerAsked.length).toBe(asked);
  });

  it("refuses host A's record presented for host B, and a hostname the broker refuses", async () => {
    const wrong = await get(HOST_B, fromEdge());
    const gone = await get(HOST_GONE, fromEdge());
    const reference = await get(HOST_A, fromEdge(), '/missing.png');

    expect(brokerAsked.map((a) => a.hostname)).toEqual(expect.arrayContaining([HOST_B, HOST_GONE]));
    for (const res of [wrong, gone, reference]) {
      expect(res.status).toBe(404);
      expect(res.body.toString()).toBe(REFUSED_PAGE.body);
    }
    // A's record was not cached under B: B asks again, and is refused again.
    const again = brokerAsked.filter((a) => a.hostname === HOST_B).length;
    expect((await get(HOST_B, fromEdge())).status).toBe(404);
    expect(brokerAsked.filter((a) => a.hostname === HOST_B).length).toBe(again + 1);
  });

  it('sets no cookie and forwards no product or preview credential (FR-019)', async () => {
    const s3Before = s3Headers.length;

    const res = await get(HOST_A, fromEdge(PRODUCT));

    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
    const onwards = [...s3Headers.slice(s3Before), ...brokerAsked.map((a) => a.headers)];
    for (const headers of onwards) {
      expect(headers.cookie).toBeUndefined();
      const sent = JSON.stringify(headers);
      expect(sent).not.toContain('product-session');
      expect(sent).not.toContain('preview-grant-jws');
      expect(sent).not.toContain('product-token');
    }
  });

  it('never lets X-Forge-Edge reach a response, the broker, the store or a log line', async () => {
    const responses = [
      await get(HOST_A, fromEdge()),
      await get(HOST_A, fromEdge(), '/missing.png'),
      await get(HOST_B, fromEdge()),
      await get(HOST_A, { 'X-Forge-Edge': `${EDGE_SECRET}x` }),
      await get(`my-site.${SITE_DOMAIN}`, fromEdge()),
    ];

    for (const res of responses) {
      const seen = `${JSON.stringify(res.headers)}\n${res.body.toString()}`.toLowerCase();
      expect(seen).not.toContain('x-forge-edge');
      expect(seen).not.toContain(EDGE_SECRET);
    }
    for (const headers of [...brokerAsked.map((a) => a.headers), ...s3Headers]) {
      expect(headers['x-forge-edge']).toBeUndefined();
      expect(JSON.stringify(headers)).not.toContain(EDGE_SECRET);
    }
    const lines = logged.join('\n');
    expect(lines.toLowerCase()).not.toContain('x-forge-edge');
    expect(lines).not.toContain(EDGE_SECRET);
  });
});
