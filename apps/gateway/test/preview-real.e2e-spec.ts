import { createServer, type IncomingMessage, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createGrantVerifier } from '../src/grant-check.ts';
import { createPipeline } from '../src/pipeline.ts';
import { createRouteVerifier, type RouteRecord } from '../src/route-verify.ts';

/**
 * Quickstart § 4: the upstream leg a fixture cannot prove. A real sandbox is created through the
 * Daytona API, a dev server is started by hand inside it (research R2: 017 routes to one, it does
 * not start one), the signed preview origin is obtained exactly as `DaytonaAdapter.previewOrigin`
 * obtains it, and the committed gateway pipeline — real route verify, real proxy — fetches a page
 * from the sandbox through it. The gateway cannot import the API (FR-006), so the two HTTP calls
 * are copied here rather than shared.
 */

const configured = Boolean(process.env.DAYTONA_API_URL && process.env.DAYTONA_API_KEY);

// Distinct from the api's `DAYTONA-SKIP "sandbox-…"` banners and from the `SKIPPING` word CI greps for.
if (!configured) {
  process.stderr.write(
    'DAYTONA-SKIP "preview-real" (gateway): DAYTONA_API_URL / DAYTONA_API_KEY not set\n',
  );
}

const API = (process.env.DAYTONA_API_URL ?? '').replace(/\/$/, '');
const KEY = process.env.DAYTONA_API_KEY ?? '';
/** The image the local stack pulls on first boot (`infra/daytona/compose.yaml` `DEFAULT_SNAPSHOT`). */
const SNAPSHOT = process.env.DAYTONA_SNAPSHOT ?? 'daytonaio/sandbox:0.5.0-slim';
const OWNER = `forge-017-walk-${String(process.pid)}`;
const DOMAIN = 'forge-preview.localhost';
const LABEL = '0123456789abcdef0123';
const PORT = 5173;
const BODY = `served from inside the sandbox by ${OWNER}`;
/** A cold create is ~13 s on the local stack (014 R1); the page fetch waits on the server's bind. */
const WALK_TIMEOUT_MS = 180_000;

const servers: Server[] = [];
let sandboxId: string | undefined;
let gatewayPort: number;
let route: RouteRecord;

async function daytona(path: string, init: { body?: unknown; method?: string } = {}) {
  const response = await fetch(path.startsWith('http') ? path : `${API}${path}`, {
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${KEY}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    method: init.method ?? 'GET',
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`Daytona ${init.method ?? 'GET'} ${path} answered ${String(response.status)}`);
  }
  // A session create answers `201` with no body.
  const text = await response.text();
  return (text === '' ? {} : JSON.parse(text)) as Record<string, unknown>;
}

async function until(what: string, predicate: () => Promise<boolean>, ms = 120_000) {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function get(host: string, path: string, via?: { headers: Record<string, string>; port: number }) {
  return new Promise<{ body: string; headers: IncomingMessage['headers']; status: number }>(
    (resolve, reject) => {
      const req = request(
        {
          headers: { connection: 'close', host, ...via?.headers },
          host: '127.0.0.1',
          path,
          port: via?.port ?? gatewayPort,
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

/** Exactly the dial `proxy.ts` makes: the minted host as `Host`, the token as the header. */
function upstream(path: string) {
  return get(new URL(route.upstream).host, path, {
    headers: { 'x-daytona-preview-token': route.upstreamToken },
    port: Number(new URL(process.env.PREVIEW_UPSTREAM_DIAL ?? route.upstream).port || 80),
  });
}

describe('preview gateway against a real sandbox (e2e)', () => {
  describe.skipIf(!configured)('with DAYTONA_API_URL and DAYTONA_API_KEY', () => {
    beforeAll(async () => {
      // `POST {api}/sandbox`, as `DaytonaAdapter.create`; then the dto until `started`.
      const created = await daytona('/sandbox', {
        body: {
          autoArchiveInterval: 0,
          autoStopInterval: 0,
          labels: { 'forge.kind': 'walk', 'forge.owner': OWNER },
          snapshot: SNAPSHOT,
        },
        method: 'POST',
      });
      const id = created.id as string;
      sandboxId = id;
      let toolbox = '';
      await until('the sandbox to start', async () => {
        const dto = await daytona(`/sandbox/${id}`);
        toolbox = dto.toolboxProxyUrl as string;
        return dto.state === 'started';
      });

      // The dev server, by hand (R2): a toolbox session so it outlives the exec call.
      const session = `${toolbox}/${id}/process/session`;
      await daytona(session, { body: { sessionId: 'walk' }, method: 'POST' });
      await daytona(`${session}/walk/exec`, {
        body: {
          command: `mkdir -p /tmp/www && printf '%s' '${BODY}' > /tmp/www/index.html && cd /tmp/www && python3 -m http.server ${String(PORT)}`,
          runAsync: true,
        },
        method: 'POST',
      });

      // `GET {api}/sandbox/{id}/ports/{port}/signed-preview-url`, as `DaytonaAdapter.previewOrigin`.
      const origin = await daytona(
        `/sandbox/${id}/ports/${String(PORT)}/signed-preview-url?expiresInSeconds=300`,
      );
      const now = Math.floor(Date.now() / 1000);
      route = {
        exp: now + 300,
        iat: now,
        label: LABEL,
        org: '00000000-0000-4000-8000-000000000000',
        ports: [PORT],
        project: '00000000-0000-4000-8000-000000000001',
        sandbox: id,
        state: 'active',
        upstream: origin.url as string,
        upstreamToken: origin.token as string,
        visibility: 'public',
      };

      // The committed gateway: a throwaway signer, the real verifier, a broker that answers it.
      const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
      const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'EdDSA', kid: 'walk' }] };
      const jws = await new SignJWT(route)
        .setProtectedHeader({ alg: 'EdDSA', kid: 'walk' })
        .sign(pair.privateKey);
      const verify = createRouteVerifier(jwks);
      const pipeline = createPipeline({
        broker: {
          getRoute: async (label) => {
            const verified = label === LABEL ? await verify(jws) : undefined;
            return verified === undefined
              ? { kind: 'refused' }
              : { kind: 'route', route: verified };
          },
          redeemGrant: () => Promise.resolve({ kind: 'refused' }),
        },
        // R19: `proxy.localhost:4000` does not resolve on Windows; `Host` stays the minted one.
        dialOrigin: process.env.PREVIEW_UPSTREAM_DIAL,
        previewDomain: DOMAIN,
        productOrigin: 'https://app.example.test',
        socketMaxMs: 60_000,
        upstreamTimeoutMs: 30_000,
        verifyGrant: createGrantVerifier(jwks),
        wakeBudgetMs: 90_000,
      });
      const gateway = createServer((req, res) => void pipeline.onRequest(req, res));
      servers.push(gateway);
      gatewayPort = await new Promise((resolve) => {
        gateway.listen(0, '127.0.0.1', () => resolve((gateway.address() as AddressInfo).port));
      });

      // The server binds a moment after `exec` answers: wait on the raw upstream leg here so no
      // test depends on running first.
      await until(
        'the dev server to answer',
        async () => (await upstream('/index.html')).status === 200,
      );
    }, WALK_TIMEOUT_MS);

    afterAll(async () => {
      for (const server of servers.splice(0)) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
      // `DELETE {api}/sandbox/{id}?force=true`, as `DaytonaAdapter.remove`; best effort.
      if (sandboxId !== undefined) {
        await daytona(`/sandbox/${sandboxId}?force=true`, { method: 'DELETE' }).catch(
          () => undefined,
        );
      }
    }, 60_000);

    it('reaches the dev server through the provider origin with the signed token (the upstream leg)', async () => {
      const reply = await upstream('/index.html');

      expect(reply.status).toBe(200);
      expect(reply.body).toBe(BODY);
      // Recorded (T052, v0.189.0): the provider's proxy pins its own auth cookie to the minted
      // host with a `Domain` attribute; `proxy.ts` strips it before the R13 check (ADR 039).
      process.stderr.write(`upstream set-cookie present: ${String('set-cookie' in reply.headers)}
`);
    });

    it('serves that page through the committed gateway', async () => {
      const reply = await get(`${LABEL}-${String(PORT)}.${DOMAIN}`, '/index.html');

      expect(reply.status).toBe(200);
      expect(reply.body).toBe(BODY);
      expect(reply.headers['x-robots-tag']).toBe('noindex');
      expect(reply.headers['x-daytona-preview-token']).toBeUndefined();
    });

    it('refuses an undeclared port before any dial', async () => {
      const reply = await get(`${LABEL}-8080.${DOMAIN}`, '/index.html');

      expect(reply.status).toBe(404);
    });
  });
});
