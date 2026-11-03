import { createServer } from 'node:http';

import { createBrokerClient } from './broker-client.ts';
import { validateEnvironment } from './config/environment.ts';
import { createEdgeOriginCheck } from './edge-origin.ts';
import { createGrantVerifier } from './grant-check.ts';
import { createPipeline } from './pipeline.ts';
import { RouteCache } from './route-cache.ts';
import { createDomainVerifier, createRouteVerifier, createSiteVerifier } from './route-verify.ts';
import { createManifestCache, createS3ArtifactStore } from './site-serve.ts';
import { createTlsAsk } from './tls-ask.ts';

const env = validateEnvironment(process.env);

const cache = new RouteCache({ max: env.ROUTE_CACHE_MAX, ttlMs: env.ROUTE_CACHE_TTL_MS });
const verify = createRouteVerifier(env.PREVIEW_PUBLIC_JWKS);
// Sites (spec 027) only when SITE_DOMAIN is set; the schema then guarantees ARTIFACT_STORE_*.
const siteDomain = env.SITE_DOMAIN;
const verifySite =
  siteDomain === undefined ? undefined : createSiteVerifier(env.PREVIEW_PUBLIC_JWKS);
// Custom domains (spec 028) only when EDGE_ORIGIN_SECRET and SITE_DOMAIN are both set; the schema
// already refuses the secret without SITE_DOMAIN.
const edgeSecret = siteDomain === undefined ? undefined : env.EDGE_ORIGIN_SECRET;
const verifyDomain =
  edgeSecret === undefined ? undefined : createDomainVerifier(env.PREVIEW_PUBLIC_JWKS);
const broker = createBrokerClient(
  env.BROKER_TRANSPORT === 'mtls'
    ? {
        cache,
        origin: env.BROKER_ORIGIN,
        // The schema's superRefine guarantees all three under `mtls`.
        tls: { ca: env.BROKER_TLS_CA!, cert: env.BROKER_TLS_CERT!, key: env.BROKER_TLS_KEY! },
        transport: 'mtls',
        verify,
        verifyDomain,
        verifySite,
      }
    : {
        cache,
        origin: env.BROKER_ORIGIN,
        // Defaulted by the schema's transform under `plain`.
        sharedSecret: env.BROKER_SHARED_SECRET!,
        transport: 'plain',
        verify,
        verifyDomain,
        verifySite,
      },
);
const pipeline = createPipeline({
  broker,
  dialOrigin: env.PREVIEW_UPSTREAM_DIAL,
  domain:
    edgeSecret === undefined
      ? undefined
      : {
          fromEdge: createEdgeOriginCheck(edgeSecret),
          getDomain: (hostname) => broker.getDomain(hostname),
        },
  previewDomain: env.PREVIEW_DOMAIN,
  productOrigin: env.PRODUCT_ORIGIN,
  site:
    siteDomain === undefined
      ? undefined
      : {
          domain: siteDomain,
          getSite: (label) => broker.getSite(label),
          manifests: createManifestCache(),
          // A read-only key scoped to the artifacts bucket; path-style, region `auto`
          // (contracts/site-serving.md § 4).
          store: createS3ArtifactStore({
            accessKeyId: env.ARTIFACT_STORE_ACCESS_KEY_ID!,
            bucket: env.ARTIFACT_STORE_BUCKET!,
            endpoint: env.ARTIFACT_STORE_ENDPOINT!,
            region: 'auto',
            secretAccessKey: env.ARTIFACT_STORE_SECRET_ACCESS_KEY!,
          }),
        },
  socketMaxMs: env.GATEWAY_SOCKET_MAX_MS,
  upstreamTimeoutMs: env.GATEWAY_UPSTREAM_TIMEOUT_MS,
  verifyGrant: createGrantVerifier(env.PREVIEW_PUBLIC_JWKS),
  wakeBudgetMs: env.GATEWAY_WAKE_BUDGET_MS,
  wakeMax: env.ROUTE_CACHE_MAX,
});

const server = createServer((req, res) => {
  void pipeline.onRequest(req, res);
});
server.on('upgrade', (req, socket, head) => {
  void pipeline.onUpgrade(req, socket, head);
});

server.listen(env.PORT, () => {
  const sites = siteDomain === undefined ? '' : ` and *.${siteDomain}`;
  // Never the secret itself: only whether custom domains are on.
  const domains = edgeSecret === undefined ? '' : ' and custom domains from the edge';
  console.log(
    `gateway listening on ${String(env.PORT)} for *.${env.PREVIEW_DOMAIN}${sites}${domains}`,
  );
});

// Caddy's on-demand TLS `ask` (compose.vps.yaml): a separate port that is never proxied publicly.
const allowed = createTlsAsk({
  getRoute: (label, ctx) => broker.getRoute(label, ctx),
  previewDomain: env.PREVIEW_DOMAIN,
});
const askPort = env.TLS_ASK_PORT;
const ask =
  askPort === undefined
    ? undefined
    : createServer((req, res) => {
        const domain = new URL(req.url ?? '/', 'http://ask').searchParams.get('domain') ?? '';
        allowed(domain).then(
          (ok) => res.writeHead(ok ? 200 : 403).end(),
          () => res.writeHead(403).end(),
        );
      }).listen(askPort);

// Graceful close: stop accepting, drop idle keep-alives, let in-flight exchanges finish, and
// give up after a bounded wait so a stuck socket cannot pin the process.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    ask?.close();
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
