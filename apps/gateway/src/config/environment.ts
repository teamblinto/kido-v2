import { z } from 'zod';

const previewJwk = z
  .object({
    crv: z.literal('Ed25519'),
    kid: z.string().min(1),
    kty: z.literal('OKP'),
    x: z.string().min(1),
  })
  .loose();
const previewJwks = z.object({ keys: z.array(previewJwk) });
export type PreviewJwks = z.infer<typeof previewJwks>;

/**
 * True when `a` and `b` are the same host or one sits under the other, compared by whole labels:
 * `sites.forge.example` is under `forge.example`; `xforge.example` is not. A single-label parent
 * (`localhost`) is not counted, since no cookie can be scoped to one from a subdomain. The same
 * rule as the API's (spec 027 R10): a site's script must not set a cookie the product or a preview
 * reads.
 */
function domainsOverlap(a: string, b: string) {
  const under = (child: string, parent: string) =>
    parent.includes('.') && child.endsWith(`.${parent}`);

  return a === b || under(a, b) || under(b, a);
}

/** The hostname of PRODUCT_ORIGIN, or `undefined` when it is not a URL. */
function productHost(origin: string) {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export const environmentSchema = z
  .object({
    // Deployed sites (spec 027 R11): read with a read-only key scoped to the artifacts bucket,
    // never the API's write key. All four are required when SITE_DOMAIN is set, and none is
    // accepted without it; SITE_DOMAIN itself is optional so a preview-only gateway still boots.
    ARTIFACT_STORE_ACCESS_KEY_ID: z.string().trim().min(1).optional(),
    ARTIFACT_STORE_BUCKET: z.string().trim().min(1).optional(),
    ARTIFACT_STORE_ENDPOINT: z.url().optional(),
    ARTIFACT_STORE_SECRET_ACCESS_KEY: z.string().trim().min(1).optional(),
    // The broker listener the gateway dials for routes and grants (spec 017 R4). `mtls` is a
    // `node:https` client presenting a certificate; `plain` is `node:http` behind a
    // shared-secret header (defaulted below) and, like the API's `KEK_PROVIDER=env`, is the
    // default for local and refused everywhere else. The mTLS values are all-or-none and
    // required for `mtls`. Unlike the API (the broker listener, which validates an incoming
    // client's certificate CN against BROKER_CLIENT_CNS), the gateway is the broker's client: it
    // only ever presents a cert/key and trusts a CA for the server's — BROKER_CLIENT_CNS is
    // API-side only and does not belong here. BROKER_TLS_CA on the gateway is the CA it trusts
    // for the broker's server certificate.
    // Broker origin = transport scheme + BROKER_HOST + BROKER_PORT (`broker` on compose).
    BROKER_HOST: z.string().trim().min(1).default('localhost'),
    BROKER_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
    BROKER_SHARED_SECRET: z.string().trim().min(1).optional(),
    BROKER_TLS_CA: z.string().trim().min(1).optional(),
    BROKER_TLS_CERT: z.string().trim().min(1).optional(),
    BROKER_TLS_KEY: z.string().trim().min(1).optional(),
    BROKER_TRANSPORT: z.enum(['mtls', 'plain']).default('plain'),
    // Custom domains (spec 028 R15): the shared secret the edge adds to every request it forwards
    // for a tenant's hostname, so a request that reached this gateway around the edge is refused.
    // Optional; without it the gateway serves no custom hostname. It requires SITE_DOMAIN (below),
    // since a custom hostname serves a site. The gateway holds no Cloudflare token (FR-032).
    EDGE_ORIGIN_SECRET: z.string().trim().min(32).optional(),
    // Deployment identity (mirrors the API's). Required rather than defaulted: no safe guess.
    DEPLOY_ENV: z.enum(['local', 'staging', 'production']),
    // The gateway's bounds on one proxied exchange (spec 017 R13): upstream headers must arrive
    // within the timeout; an upgraded socket is closed at the ceiling regardless.
    GATEWAY_SOCKET_MAX_MS: z.coerce.number().int().positive().default(3_600_000),
    GATEWAY_UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    // How long a label may keep answering `202` before the "could not be woken" page (spec 017
    // FR-032; §14 budgets 8 s for a resume, so 90 s is generous).
    GATEWAY_WAKE_BUDGET_MS: z.coerce.number().int().positive().default(90_000),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3200),
    // Previews are served at <label>-<port>.<PREVIEW_DOMAIN> (spec 017 R3).
    PREVIEW_DOMAIN: z.string().trim().toLowerCase().min(1).default('forge-preview.localhost'),
    // The gateway is verify-only: it never holds PREVIEW_SIGNING_KEY and cannot mint a key pair
    // of its own. The API defaults this to a fresh ephemeral pair's public half under
    // DEPLOY_ENV=local, but an ephemeral pair generated in the API process has no channel to
    // reach the gateway process, so unlike the API this is required in every DEPLOY_ENV,
    // including local — local deployments must set PREVIEW_PUBLIC_JWKS explicitly (e.g. from the
    // API's derived value, or a fixed local key pair shared by both processes).
    PREVIEW_PUBLIC_JWKS: z
      .string()
      .transform((raw, ctx) => {
        try {
          return JSON.parse(raw) as unknown;
        } catch {
          ctx.addIssue({ code: 'custom', message: 'must be a JSON JWKS' });
          return z.NEVER;
        }
      })
      .pipe(previewJwks),
    // The API/web origin the gateway redirects a non-public preview to for the grant exchange
    // (spec 017 §4, T030): `<PRODUCT_ORIGIN>/preview-authorize?label=…&return=…`.
    PRODUCT_ORIGIN: z.string().trim().min(1).default('http://localhost:5173'),
    // Local-only: the origin the gateway dials in place of a route's `upstream` host when that
    // host does not resolve from here (research R19: Docker's `proxy.localhost` on Windows).
    // `Host`/SNI stay the upstream's own. A real deployment never needs it.
    PREVIEW_UPSTREAM_DIAL: z.url().optional(),
    // The gateway's bounded in-process route cache (spec 017 R5): SC-006's five seconds is the
    // TTL, so a rotated label stops resolving everywhere within it with no invalidation channel.
    ROUTE_CACHE_MAX: z.coerce.number().int().positive().default(1_000),
    ROUTE_CACHE_TTL_MS: z.coerce.number().int().positive().default(5_000),
    // Deployed sites are served at `<site_label>.<SITE_DOMAIN>` (spec 027 R10, R11).
    SITE_DOMAIN: z.string().trim().toLowerCase().min(1).optional(),
    // When set, a second listener answers an on-demand TLS edge's `ask` (`?domain=`): 200 only
    // for a preview host the broker knows (tls-ask.ts). Never route public traffic to it.
    TLS_ASK_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  })
  .superRefine((environment, ctx) => {
    const isRealDeployment = environment.DEPLOY_ENV !== 'local';

    if (environment.BROKER_TRANSPORT === 'plain' && isRealDeployment) {
      ctx.addIssue({
        code: 'custom',
        message:
          'the plain broker transport is a bearer token that resolves any label and is local-only (R4)',
        path: ['BROKER_TRANSPORT'],
      });
    }

    if (environment.PREVIEW_UPSTREAM_DIAL !== undefined && isRealDeployment) {
      ctx.addIssue({
        code: 'custom',
        message: 'is a local-only dial override (R19)',
        path: ['PREVIEW_UPSTREAM_DIAL'],
      });
    }

    // Spec 027: the artifact store is all-or-none with SITE_DOMAIN. A key this gateway has no
    // site to serve with is a credential held for nothing.
    const artifactStoreKeys = [
      'ARTIFACT_STORE_ACCESS_KEY_ID',
      'ARTIFACT_STORE_BUCKET',
      'ARTIFACT_STORE_ENDPOINT',
      'ARTIFACT_STORE_SECRET_ACCESS_KEY',
    ] as const;
    const artifactStoreSet = artifactStoreKeys.filter((key) => environment[key] !== undefined);

    if (environment.SITE_DOMAIN === undefined) {
      if (artifactStoreSet.length > 0) {
        ctx.addIssue({
          code: 'custom',
          message: `is required when any ARTIFACT_STORE_* variable is set (${artifactStoreSet.join(', ')})`,
          path: ['SITE_DOMAIN'],
        });
      }
    } else {
      for (const key of artifactStoreKeys) {
        if (environment[key] === undefined) {
          ctx.addIssue({
            code: 'custom',
            message: 'is required when SITE_DOMAIN is set',
            path: [key],
          });
        }
      }

      const appHost = productHost(environment.PRODUCT_ORIGIN);

      if (domainsOverlap(environment.SITE_DOMAIN, environment.PREVIEW_DOMAIN)) {
        ctx.addIssue({
          code: 'custom',
          message: `must not equal, sit under or sit above PREVIEW_DOMAIN (${environment.PREVIEW_DOMAIN}); a site and a preview never share a cookie scope (R10)`,
          path: ['SITE_DOMAIN'],
        });
      }

      if (appHost !== undefined && domainsOverlap(environment.SITE_DOMAIN, appHost)) {
        ctx.addIssue({
          code: 'custom',
          message: `must not equal, sit under or sit above the product host PRODUCT_ORIGIN names (${appHost}); a site never shares a cookie scope with the product (R10)`,
          path: ['SITE_DOMAIN'],
        });
      }
    }

    if (environment.EDGE_ORIGIN_SECRET !== undefined && environment.SITE_DOMAIN === undefined) {
      ctx.addIssue({
        code: 'custom',
        message:
          'requires SITE_DOMAIN; a custom hostname serves a site, and a gateway with no sites has nothing to serve it (R15)',
        path: ['EDGE_ORIGIN_SECRET'],
      });
    }

    // The read key and every object it signs for would cross the network in the clear.
    if (
      isRealDeployment &&
      environment.ARTIFACT_STORE_ENDPOINT !== undefined &&
      new URL(environment.ARTIFACT_STORE_ENDPOINT).protocol !== 'https:'
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'an http: (or any non-https:) endpoint is local-only; the artifact store is read over https: (R11)',
        path: ['ARTIFACT_STORE_ENDPOINT'],
      });
    }

    const mtlsKeys = ['BROKER_TLS_CA', 'BROKER_TLS_CERT', 'BROKER_TLS_KEY'] as const;
    const mtlsSetCount = mtlsKeys.filter((key) => environment[key] !== undefined).length;

    if (mtlsSetCount > 0 || environment.BROKER_TRANSPORT === 'mtls') {
      for (const key of mtlsKeys) {
        if (environment[key] === undefined) {
          ctx.addIssue({
            code: 'custom',
            message:
              mtlsSetCount > 0
                ? 'is required when any BROKER_TLS_* variable is set'
                : 'is required when BROKER_TRANSPORT is "mtls"',
            path: [key],
          });
        }
      }
    }
  })
  .transform((environment) => ({
    ...environment,
    BROKER_ORIGIN: `${environment.BROKER_TRANSPORT === 'mtls' ? 'https' : 'http'}://${environment.BROKER_HOST}:${String(environment.BROKER_PORT)}`,
    // Plain is local-only (refused above), so a well-known default keeps the compose stack and
    // `pnpm dev:gateway` in step without another value to copy between them.
    BROKER_SHARED_SECRET:
      environment.BROKER_SHARED_SECRET ??
      (environment.BROKER_TRANSPORT === 'plain' ? 'local-broker-secret' : undefined),
  }));

export type Environment = z.infer<typeof environmentSchema>;

export function validateEnvironment(config: Record<string, unknown>): Environment {
  const result = environmentSchema.safeParse(config);

  if (!result.success) {
    throw new Error(`Invalid environment configuration: ${z.prettifyError(result.error)}`);
  }

  return result.data;
}
