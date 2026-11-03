import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { isIP } from 'node:net';

import { isCatalogueModel, VERSION_LOCAL_PLACEHOLDER } from '@repo/contracts';
import { z } from 'zod';

import { hasWorkerProfile, parseRunProfiles } from './run-profiles';

const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');

/**
 * Connection strings are validated by protocol rather than by `z.url()` so that a
 * `mysql://` or a bare `host:port` fails at boot with the variable named, instead of
 * surfacing as a driver error on the first query.
 */
function connectionUrl(protocols: readonly string[]) {
  return z
    .string()
    .trim()
    .refine(
      (value) => {
        try {
          return protocols.includes(new URL(value).protocol);
        } catch {
          return false;
        }
      },
      { message: `must be a URL using one of: ${protocols.join(', ')}` },
    );
}

const postgresUrl = connectionUrl(['postgres:', 'postgresql:']);
const redisUrl = connectionUrl(['redis:', 'rediss:']);

/** The Ed25519 private key a base64 PKCS8 string holds, or undefined when it is not one. */
function readSigningKey(value: string) {
  try {
    const key = createPrivateKey({
      format: 'der',
      key: Buffer.from(value, 'base64'),
      type: 'pkcs8',
    });
    return key.asymmetricKeyType === 'ed25519' ? key : undefined;
  } catch {
    return undefined;
  }
}

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

/** The public half of a signing key as the one-key JWKS the gateway verifies against. */
function deriveJwks(privateKeyBase64: string, kid: string): PreviewJwks {
  const key = readSigningKey(privateKeyBase64);

  if (key === undefined) {
    throw new Error('PREVIEW_SIGNING_KEY was accepted but does not read as Ed25519');
  }

  const jwk = createPublicKey(key).export({ format: 'jwk' }) as {
    crv: 'Ed25519';
    kty: 'OKP';
    x: string;
  };
  return { keys: [{ ...jwk, alg: 'EdDSA', kid, use: 'sig' }] };
}

/** The names spec 017 adds; none may be shipped to the browser as a `VITE_*` var. */
const PREVIEW_ENV_NAMES = [
  'BROKER_CLIENT_CNS',
  'BROKER_PORT',
  'BROKER_SHARED_SECRET',
  'BROKER_TLS_CA',
  'BROKER_TLS_CERT',
  'BROKER_TLS_KEY',
  'BROKER_TRANSPORT',
  'GATEWAY_SOCKET_MAX_MS',
  'GATEWAY_UPSTREAM_TIMEOUT_MS',
  'PREVIEW_DOMAIN',
  'PREVIEW_PUBLIC_JWKS',
  'PREVIEW_SIGNING_KEY',
  'PREVIEW_SIGNING_KEY_ID',
  'ROUTE_CACHE_MAX',
  'ROUTE_CACHE_TTL_MS',
] as const;

const SANDBOX_CALLBACK_URL_DEFAULT = 'http://localhost:3000/api/v1/internal/sandbox-callbacks';

/** Where deployed sites are served under `DEPLOY_ENV=local` (spec 027 R10); required elsewhere. */
const SITE_DOMAIN_LOCAL_DEFAULT = 'forge-site.localhost';

/** The host inbound webhooks arrive at under `DEPLOY_ENV=local` (spec 029 R2); required elsewhere. */
const HOOKS_HOST_LOCAL_DEFAULT = 'hooks.localhost';

/**
 * True when `a` and `b` are the same host or one sits under the other, compared by whole labels:
 * `sites.forge.example` is under `forge.example`; `xforge.example` is not. A single-label parent
 * (`localhost`) is not counted, since no cookie can be scoped to one from a subdomain. That is the
 * overlap spec 027 R10 refuses: an untrusted site's script setting a cookie the parent reads.
 */
function domainsOverlap(a: string, b: string) {
  const under = (child: string, parent: string) =>
    parent.includes('.') && child.endsWith(`.${parent}`);

  return a === b || under(a, b) || under(b, a);
}

/** The hostname of the product's own origin, or `undefined` when APP_URL is not a URL. */
function productHost(appUrl: string) {
  try {
    return new URL(appUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** The key id `apps/api/.env.example` publishes beside its example key; a real deployment must not sign with it. */
const EXAMPLE_SIGNING_KEY_ID = 'local-example';
/** The id the boot-generated local pair is named by when none is configured. */
const EPHEMERAL_SIGNING_KEY_ID = 'local-ephemeral';
/** The webhook secret `apps/api/.env.example` publishes; a deployment signing with it accepts anyone's signature. */
const EXAMPLE_GITHUB_WEBHOOK_SECRET = 'local-example-webhook-secret';
/** The GitHub App key `apps/api/.env.example` publishes; parseable so local boots, refused elsewhere. */
const EXAMPLE_GITHUB_APP_PRIVATE_KEY =
  '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA4emgx1yE5A7nyR0WBnsl323JlKcvT4ZCbYuxxBGtdQ3tCz7n\nUjJ7lEVCWSc0Has4jkyK9Q1d/iwkJ0Zsj53BczcWwP2XDQk1ML28oRf7XxKLo2Up\naSbUqmROBiTousn/4laH34P8etpCUIqHW3aCGbEpkwNISCgcjC7PoQdORcYVPRMd\nCh/lbcZsaoGGCVXIAa2l2OfMwjqkm4A+HxU3idiLZ5532kIlPzgyF00ttDGrZo0D\nE1dbo5dbaLM92nnywxjklOLkHSVUskULhVtlM8HC82h1kJB9ToLKm+ZF3ryWCa8m\na0JQMApStRc/oWbmWpfSTKxK4MdcxfG9AwZOeQIDAQABAoIBAAI+MvwMGeI3aghb\njVgFZuVzf6TRmcFsPMhU1Zjch4ZOUFE7flVHi054JcAVIA/uEzihAmBdHZEED6Ix\n1E3UjBiPEVNbee0itSG3ErnHo6z1p37+w6FarpHyVl1AQKcZwA3dR8zj0KDfz5uP\nj3NMhfY/P9LrzAM973AUUrg7KWIx2kSp1qYXn24R7Qo0Q4We/dxrkk7CPqt3NUhN\nhTtc/u3dhmVT0cvPDDujyi/YO5MaG/XLRM0A+pCxIOHtz2WjAwPwpeQ2VwympawH\nHUGWlecDXR2FhTrMtbpZfaPUjMa0IacOyT4JbBkhwV4UTRjebDju3ILw3qYnFHl3\nOXCqsXMCgYEA/dYcCHYJu2pcF3EKuPq9isMvx9eEKbZE/o8V8bxJdVVHJhwU2DZr\n2a0KjhYwAjJHEEgP/idg/h//vrufeC/tBtljCWQ4dyo7eReU3nlS6eA0oD7BXi0Y\nLMAghc+0JxkkVVCqn2iDCCVSVyXzFgBbE9ybraB2uy82ztAJ32rqGKsCgYEA49aW\nNWvwXiy6mk+GQK6uVQu2Ln5a8BzV+BM3iCTmylxyrTntXTBM895sg95l832Iwnb5\nd8TCZ6iERMrrldA7FMcGIRju0NlH54j/CXyeCzZwmMx5OqLIa9KhSzLg9aE9DPu6\nkarW5+XLJ2J94qwyk0cRaRUtcVGjQ56THiRn/WsCgYEAx3X5rURjvVuEZf8z98tA\nKcvaveRCPCy35ng1PDFCX+rU78NdNdD9ypzJEIGq0+8CHG8j8girlMU8R3pTgzPV\nw24K/pQ8MpeDCFJZbsBTQOgnMkxd0k0JFBEc/UkLPTXqcQfkK0MKw9nf7A8sBvvc\nlaziv/q5kbk2Dik3uNHgheUCgYBqQx0PkWYsJiRp8AknhdEdLTcs/BWhw3EwIJZX\n0w4o93EsxcWlHu/lFan63vEh3Ty5pg+4AnbBLeFyzEmQN+w2RpTfPuezVIOqw0Rf\nwlVb2Woueb9Yz682SqibkAFHzonQ0l8zrUBKK+zSU6du3u0/r3e5UP0+ytqgoQbw\nmf4+PQKBgCzavOLUcRWFi8RMM2DyguReo4JawA/nMjliZgrJO5Hq0ApNrH9ao0ze\nM/CEoq5+xpqHKFbQqT5qoy2ALoXiryahGo6qVsgl76TZ40jbxCufCQh7EXw/52SN\nvE3y1kCuPoJcSBOmT46ZwGCSyRpf1bVO7rvsfXSMm/W5EOIut8ww\n-----END RSA PRIVATE KEY-----\n'.trim();
/** The Supabase OAuth secret `apps/api/.env.example` publishes; refused outside local (spec 030 R12). */
const EXAMPLE_SUPABASE_OAUTH_CLIENT_SECRET = 'local-example-supabase-secret';
/** The connector provider base URLs a tenant credential is sent to (spec 030 R12). */
const CONNECTOR_API_URL_NAMES = [
  'CONNECTOR_RESEND_API_URL',
  'NEON_API_URL',
  'NETLIFY_API_URL',
  'SUPABASE_API_URL',
] as const;
/** Spec 032: one OAuth client per provider whose subscriptions can be linked. */
const BYOS_PROVIDER_PREFIXES = ['BYOS_ANTHROPIC', 'BYOS_OPENAI'] as const;
const GITHUB_APP_ENV_NAMES = [
  'GITHUB_APP_CLIENT_ID',
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_SLUG',
] as const;

/**
 * The platform's Cloudflare for SaaS registration (spec 028 R15): all three or none, like
 * `GITHUB_APP_*`. None means the API registers no custom hostname.
 */
const CLOUDFLARE_ENV_NAMES = [
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ZONE_ID',
  'CUSTOM_HOSTNAME_TARGET',
] as const;

/**
 * One `DNS_RESOLVERS` entry as `Resolver.setServers` takes it: an IPv4 or IPv6 address, optionally
 * with a port (`1.1.1.1:53`, `[2001:db8::1]:53`). A hostname is refused: resolving the resolver
 * would go through the very host resolver the list exists to avoid (R15).
 */
function isResolverAddress(entry: string) {
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
  const v4WithPort = /^([^:]+):(\d+)$/.exec(entry);
  const [host, port] =
    bracketed !== null
      ? [bracketed[1], bracketed[2]]
      : v4WithPort !== null
        ? [v4WithPort[1], v4WithPort[2]]
        : [entry, undefined];

  if (host === undefined || isIP(host) === 0 || (bracketed !== null && isIP(host) !== 6)) {
    return false;
  }

  return port === undefined || (Number(port) >= 1 && Number(port) <= 65_535);
}

/** True when a PEM imports as an RSA private key — what an RS256 App JWT needs. */
function isRsaPrivateKey(pem: string) {
  try {
    return createPrivateKey(pem).asymmetricKeyType === 'rsa';
  } catch {
    return false;
  }
}

/** §11 mandates Argon2id at 64 MB, t=3, p=1. Lower values are for local test speed only. */
const ARGON2_DEPLOYMENT_FLOOR = {
  ARGON2_MEMORY_KIB: 65_536,
  ARGON2_PARALLELISM: 1,
  ARGON2_TIME_COST: 3,
} as const;

/**
 * A value baked into the image at build. Docker materialises a build argument that was never passed
 * as an empty string rather than leaving it unset, so `''` is read as "not baked" — which routes it
 * to the "required outside DEPLOY_ENV=local" refusal below with its own message, instead of a bare
 * "too small", and lets a plain `docker build` still produce a local image that boots.
 */
const bakedBuildValue = z
  .string()
  .trim()
  .transform((value) => (value === '' ? undefined : value))
  .optional();

export const environmentSchema = z
  .object({
    /** The model id written on every run row (spec 008). Never called until 011 binds an executor. */
    AGENT_DEFAULT_MODEL: z.string().trim().min(1).default('claude-sonnet-5'),
    // Spec 041: the cloud subscription agent (a person's own Claude Code in a private Daytona
    // sandbox, their "agent home"). Defaulted below like LOCAL_AGENT_ENABLED: on under `local`,
    // off elsewhere; it also needs LOCAL_AGENT_ENABLED, whose routes the hosted runner uses.
    AGENT_HOME_ENABLED: booleanString.optional(),
    // The Claude Code version the `agent-home` template installs (the official installer's
    // argument: `stable`, `latest` or an exact version). Part of the template's digest, so a new
    // value is a new snapshot on the next `template:publish agent-home`. Exact (`x.y.z`) outside
    // `local` when homes are on: the binary is run as published, at a version we chose.
    AGENT_HOME_CLAUDE_VERSION: z
      .string()
      .regex(/^(stable|latest|\d+\.\d+\.\d+)$/)
      .default('stable'),
    // Daytona's egress allowlist for every agent home: comma-separated IPv4 CIDRs, at most 10
    // (Daytona's limit). Unset leaves egress open (local dev).
    AGENT_HOME_EGRESS_ALLOW_CIDRS: z
      .string()
      .optional()
      .transform((raw) => (raw === undefined || raw.trim() === '' ? [] : parseCorsOrigins(raw)))
      .pipe(
        z
          .array(
            z.string().regex(/^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/, 'each entry must be an IPv4 CIDR'),
          )
          .max(10),
      ),
    // A running home with no active run is stopped after this long since its last use.
    AGENT_HOME_IDLE_MINUTES: z.coerce.number().int().min(1).default(30),
    // A home not signed in (never, or no longer) and unused this many days is deleted by the sweep.
    AGENT_HOME_UNUSED_DAYS: z.coerce.number().int().min(1).default(14),
    // The companion bundle uploaded into every home on start (`apps/companion/dist/main.js`). Unset
    // resolves it from the repository; a production image must ship it and set this.
    AGENT_HOME_RUNNER_BUNDLE: z.string().trim().min(1).optional(),
    // The API origin as the runner inside a home reaches it. Unset is the local Daytona's view of
    // the host (`http://host.docker.internal:3000`); required outside `local` to be https.
    AGENT_HOME_SERVER_URL: z.url().optional(),
    // The Anthropic API key the agent module's adapter constructs a client with (spec 011). Local
    // only, exactly as DAYTONA_API_KEY is: a key held in the process environment is the plaintext
    // secret §06 and ADR 027 refuse on a real deployment.
    ANTHROPIC_API_KEY: z.string().trim().min(1).optional(),
    // ponytail: a local Anthropic-compatible proxy for the by-hand exit walk — its base URL and the
    // model-id prefix it expects (`cc/`). Refused off `local` like the key; 020/023 own the real one.
    ANTHROPIC_BASE_URL: z.url().optional(),
    ANTHROPIC_MODEL_PREFIX: z.string().trim().min(1).optional(),
    ANTHROPIC_TOOL_SUFFIX: z.string().trim().min(1).optional(),
    API_PREFIX: z.string().trim().min(1).default('api'),
    API_VERSION: z.string().trim().min(1).default('1'),
    APP_URL: z.string().trim().min(1).default('http://localhost:5173'),
    ARGON2_MEMORY_KIB: z.coerce.number().int().positive().default(65_536),
    ARGON2_PARALLELISM: z.coerce.number().int().positive().default(1),
    ARGON2_TIME_COST: z.coerce.number().int().positive().default(3),
    BREACH_CHECK_ENABLED: booleanString.default(true),
    // The broker listener the gateway calls for routes and grants (spec 017 R4). `mtls` is a
    // `node:https` server that requires a client certificate whose CN is in BROKER_CLIENT_CNS;
    // `plain` is `node:http` behind a shared-secret header (defaulted below) and, like
    // `KEK_PROVIDER=env`, is the default for local and refused everywhere else. The four mTLS values are all-or-none and
    // required for `mtls`, in the Daytona/OAuth both-or-neither style.
    BROKER_CLIENT_CNS: z
      .string()
      .transform((raw) => parseCorsOrigins(raw))
      .pipe(z.array(z.string()).min(1))
      .optional(),
    BROKER_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
    BROKER_SHARED_SECRET: z.string().trim().min(1).optional(),
    BROKER_TLS_CA: z.string().trim().min(1).optional(),
    BROKER_TLS_CERT: z.string().trim().min(1).optional(),
    BROKER_TLS_KEY: z.string().trim().min(1).optional(),
    BROKER_TRANSPORT: z.enum(['mtls', 'plain']).default('plain'),
    // Spec 032: the subscription-linking OAuth client per provider, from the provider's documentation.
    // Each set is all-or-none (see BYOS_PROVIDER_PREFIXES below); none means not offered (R13).
    // SCOPES is space-separated.
    BYOS_ANTHROPIC_API_BASE_URL: z.url().optional(),
    BYOS_ANTHROPIC_AUTHORIZE_URL: z.url().optional(),
    BYOS_ANTHROPIC_CLIENT_ID: z.string().trim().min(1).optional(),
    BYOS_ANTHROPIC_CLIENT_SECRET: z.string().trim().min(1).optional(),
    BYOS_ANTHROPIC_DEVICE_URL: z.url().optional(),
    BYOS_ANTHROPIC_REVOKE_URL: z.url().optional(),
    BYOS_ANTHROPIC_SCOPES: z.string().trim().min(1).optional(),
    BYOS_ANTHROPIC_TOKEN_URL: z.url().optional(),
    BYOS_OPENAI_API_BASE_URL: z.url().optional(),
    BYOS_OPENAI_AUTHORIZE_URL: z.url().optional(),
    BYOS_OPENAI_CLIENT_ID: z.string().trim().min(1).optional(),
    BYOS_OPENAI_CLIENT_SECRET: z.string().trim().min(1).optional(),
    BYOS_OPENAI_DEVICE_URL: z.url().optional(),
    BYOS_OPENAI_REVOKE_URL: z.url().optional(),
    BYOS_OPENAI_SCOPES: z.string().trim().min(1).optional(),
    BYOS_OPENAI_TOKEN_URL: z.url().optional(),
    BYOS_REFRESH_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    // Which build is running, baked into the image at build and answered by `GET /api/v1/version`
    // (spec 025 FR-033, research R7). Optional here and required outside `local` by the refinement
    // below — the `PREVIEW_SIGNING_KEY` idiom — because a real deployment that cannot say which
    // artifact it is running cannot be correlated to the build that produced it, while `local`
    // builds from a working tree that has no digest and answers `dev` / `dev` / its boot time.
    BUILD_AT: bakedBuildValue.pipe(z.iso.datetime().optional()),
    BUILD_COMMIT: bakedBuildValue,
    BUILD_DIGEST: bakedBuildValue,
    // The platform's Cloudflare for SaaS zone (spec 028 R15). The token needs only "SSL and
    // Certificates: Edit" on that zone and is held by the API and worker profiles alone, never the
    // gateway (FR-032). The three are all-or-none (below); the URL exists so a test can point the
    // client at a fixture server, and must be https outside local.
    CLOUDFLARE_API_TOKEN: z.string().trim().min(1).optional(),
    CLOUDFLARE_API_URL: z.url().default('https://api.cloudflare.com/client/v4'),
    CLOUDFLARE_ZONE_ID: z.string().trim().min(1).optional(),
    // Spec 030 R12: the Resend API the Resend *connector* calls with a tenant's own key. Prefixed so
    // it is never confused with the platform mail's RESEND_API_KEY. https outside local.
    CONNECTOR_RESEND_API_URL: z.url().default('https://api.resend.com'),
    CORS_ORIGINS: z.string().default('http://localhost:5173'),
    // Which CA Cloudflare asks for a custom hostname's certificate (spec 028 R15).
    CUSTOM_HOSTNAME_CA: z.enum(['lets_encrypt', 'google']).default('lets_encrypt'),
    // The name a tenant's CNAME points at. Never overlapping the preview, site or product domains
    // (below): it is the edge's fallback origin, not a place anything else is served.
    CUSTOM_HOSTNAME_TARGET: z.string().trim().toLowerCase().min(1).optional(),
    CSRF_COOKIE_NAME: z.string().trim().min(1).default('forge_csrf'),
    DATABASE_BYPASS_POOL_MAX: z.coerce.number().int().positive().default(2),
    DATABASE_MIGRATION_URL: postgresUrl,
    DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
    DATABASE_URL: postgresUrl,
    DATABASE_URL_BYPASS_RLS: postgresUrl,
    // The Daytona control plane the sandbox module talks to (spec 010). Both-or-neither, and
    // both are local-only: an API key held in the process environment is exactly the plaintext
    // secret §06 and ADR 027 refuse on a real deployment, so a staging or production boot with
    // these set fails the way `KEK_PROVIDER=env` does. Neither set means the module answers
    // every call as not configured; nothing in the API process reaches for Daytona until 011.
    DAYTONA_API_KEY: z.string().trim().min(1).optional(),
    DAYTONA_API_URL: z.url().optional(),
    // The public resolvers a domain check queries (spec 028 R15), as `ip[:port]`, so a check sees
    // what the internet sees rather than a split-horizon or cached answer from the host.
    DNS_RESOLVERS: z
      .string()
      .default('1.1.1.1,8.8.8.8')
      .transform((raw) => parseCorsOrigins(raw))
      .pipe(
        z
          .array(
            z.string().refine(isResolverAddress, {
              message: 'each entry must be an IP address, optionally with a port (ip[:port])',
            }),
          )
          .min(1),
      ),
    // Deployment identity, deliberately separate from NODE_ENV. NODE_ENV keeps its Node
    // meaning — which build is running — and the local compose stack legitimately runs a
    // production build. Anything that must be refused on a *real* deployment keys on this.
    // Required rather than defaulted: there is no safe guess, and §11 wants a fast failure.
    DEPLOY_ENV: z.enum(['local', 'staging', 'production']),
    // Criterion 2's 24 hours. Long enough that a link found the next morning still works, short
    // enough that a mailbox compromised a week later is not a way in. Configurable because a
    // deployment may want it tighter; the *test* of the boundary drives a fake clock, so shortening
    // this does not make the suite fast or lengthening it slow.
    EMAIL_VERIFICATION_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
    // The gateway's bounds on one proxied exchange (spec 017 R13): upstream headers must arrive
    // within the timeout; an upgraded socket is closed at the ceiling regardless.
    GATEWAY_SOCKET_MAX_MS: z.coerce.number().int().positive().default(3_600_000),
    GATEWAY_UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    // The GitHub App (spec 018 R2): the four GITHUB_APP_* are both-or-neither, neither means
    // "no connector"; the URLs exist so a test can point the one client at the fixture server.
    GITHUB_API_URL: z.url().default('https://api.github.com'),
    GITHUB_APP_CLIENT_ID: z.string().trim().min(1).optional(),
    GITHUB_APP_ID: z.coerce.number().int().positive().optional(),
    // A PEM; a literal backslash-n is accepted for the shells that cannot export a newline.
    GITHUB_APP_PRIVATE_KEY: z
      .string()
      .transform((value) => value.replaceAll('\\n', '\n').trim())
      .refine(isRsaPrivateKey, { message: 'must be a PEM that imports as an RSA private key' })
      .optional(),
    GITHUB_APP_SLUG: z
      .string()
      .regex(/^[a-z0-9-]+$/, { message: 'must be lowercase letters, digits and hyphens' })
      .optional(),
    GITHUB_INSTALL_URL: z.url().default('https://github.com'),
    GITHUB_OAUTH_CLIENT_ID: z.string().trim().min(1).optional(),
    GITHUB_OAUTH_CLIENT_SECRET: z.string().trim().min(1).optional(),
    // The App's webhook signing secret (spec 026 R10). Required, not optional: the verifier has no
    // "no secret configured" path, and a deployment without one would accept nothing or, worse,
    // everything. The published example value is refused outside local, below.
    GITHUB_WEBHOOK_SECRET: z.string().trim().min(1),
    GOOGLE_OAUTH_CLIENT_ID: z.string().trim().min(1).optional(),
    GOOGLE_OAUTH_CLIENT_SECRET: z.string().trim().min(1).optional(),
    HOST: z.string().trim().min(1).default('0.0.0.0'),
    // Spec 029 R2: the hostname inbound webhooks arrive at. Defaulted below to hooks.localhost
    // under local; required elsewhere, and refused when it equals the product host.
    HOOKS_HOST: z.string().trim().toLowerCase().min(1).optional(),
    // A week — the lifetime `TokenService.issue` names for this flow. Longer than a verification
    // link on purpose: the reader of an invitation is often not expecting it, may not have an
    // account yet, and frequently opens it on a different device than the one the mail arrived on.
    // Short enough that an invitation to somebody who left in the meantime has died on its own. The
    // boundary is driven by a fake clock, so this value does not decide how long the suite takes.
    INVITATION_TTL_SECONDS: z.coerce.number().int().positive().default(604_800),
    KEK_ENV_MASTER_KEY: z
      .string()
      .trim()
      .refine((value) => Buffer.from(value, 'base64').length === 32, {
        message: 'must be base64 that decodes to exactly 32 bytes',
      })
      .optional(),
    KEK_PROVIDER: z.enum(['env', 'openbao']).default('env'),
    // Spec 040 § 2: a Codex CLI signed in with a ChatGPT plan may run only where the operator is
    // permitted to offer it (local/open-source, or after provider partner approval). Default deny;
    // a Codex CLI on its own API key is unaffected.
    LOCAL_AGENT_CODEX_CHATGPT_AUTH: z.enum(['allow', 'deny']).default('deny'),
    // Spec 040: the local agent bridge. Defaulted below to on under `local` and off elsewhere, so a
    // deployment opts in deliberately after accepting the providers' terms.
    LOCAL_AGENT_ENABLED: booleanString.optional(),
    // Spec 040 § 6: the longest one turn of a local run may take before it is failed, however busy
    // the device is. Six hours by default; a turn that legitimately runs longer is rare.
    LOCAL_AGENT_MAX_RUN_SECONDS: z.coerce.number().int().min(60).default(21_600),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    // The login throttle (§11, criterion 16). Two buckets, one progression: the account bucket is
    // tight because one person mistypes one password, and the address bucket is loose because a
    // NAT, an office or a mobile carrier is many people behind one address — a per-IP limit as
    // tight as the per-account one locks a building out of the product.
    LOGIN_THROTTLE_ACCOUNT_BURST: z.coerce.number().int().nonnegative().default(5),
    // One failure forgiven per interval of quiet. This is what makes the throttle recover on its
    // own, with nobody in the loop and no operator to page.
    LOGIN_THROTTLE_DECAY_SECONDS: z.coerce.number().int().positive().default(900),
    LOGIN_THROTTLE_DELAY_SECONDS: z.coerce.number().int().positive().default(2),
    LOGIN_THROTTLE_IP_BURST: z.coerce.number().int().nonnegative().default(20),
    // The ceiling, and the reason this is a throttle rather than a lock. Anyone who knows an
    // address can drive its account to this delay; nobody can drive it past this delay.
    LOGIN_THROTTLE_MAX_DELAY_SECONDS: z.coerce.number().int().positive().default(300),
    MAIL_FROM: z.string().trim().min(1).default('Forge <noreply@forge.dev>'),
    MAIL_PROVIDER: z.enum(['console', 'resend']).default('console'),
    // How long a scanned-but-unconfirmed enrolment stays claimable (T20). Long enough to open an
    // authenticator app, scan and type six digits; short enough that a seed minted for a session
    // that wandered off is not sitting in the session store all afternoon. It is not a security
    // boundary on its own — the enrolment is inert until it is confirmed — it bounds how long an
    // unused one lingers.
    // How long the half-authenticated session between the password and the second factor lives
    // (T21, criterion 4). It is the whole of an attacker's handle on a challenge, so it is minutes
    // rather than the session's fortnight — long enough to unlock a phone and read a code, short
    // enough that an abandoned sign-in is not a credential lying around all afternoon. The window
    // does not slide: poking the challenge route does not extend it.
    MFA_CHALLENGE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
    // How many wrong codes one challenge tolerates before the half-authenticated session is thrown
    // away and the caller has to present the password again. The window alone is not enough: six
    // digits is a million guesses, and five minutes of unthrottled attempts is a meaningful slice
    // of that. Generous enough for a phone whose clock drifted and a user who fat-fingered twice.
    MFA_CHALLENGE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
    MFA_ENROLMENT_TTL_SECONDS: z.coerce.number().int().positive().default(600),
    // What an authenticator app displays beside the code. Not a URL: it is rendered on a phone
    // beside every other account the user has enrolled, so it has to read as a name.
    MFA_ISSUER: z.string().trim().min(1).default('Forge'),
    // How long a step-up re-authentication is good for (T21, criterion 12). Five minutes is long
    // enough to remove MFA, change a billing plan or delete a connector without typing a code per
    // click, and short enough that a laptop left unlocked after a step-up is not a standing
    // authorisation to do those things.
    MFA_STEP_UP_TTL_SECONDS: z.coerce.number().int().positive().default(300),
    MFA_TOTP_DIGITS: z.coerce.number().int().min(6).max(10).default(6),
    // §11's drift window, in time steps either side of now, and the one place the number is
    // written down. One step — ±30 seconds — is what RFC 6238 §5.2 recommends: it covers a phone
    // whose clock is a little out and a user who starts typing as the code rolls over, while
    // keeping the number of simultaneously-valid codes at three. Every extra step widens the
    // window an intercepted code stays replayable in, so it is configuration with a default rather
    // than a knob anybody is expected to turn up. `mfa.service.spec.ts` drives both boundaries
    // against a fake clock.
    MFA_TOTP_DRIFT_STEPS: z.coerce.number().int().nonnegative().max(10).default(1),
    MFA_TOTP_PERIOD_SECONDS: z.coerce.number().int().positive().default(30),
    // Spec 030 R12: provider base URLs, each overridable so a test points the adapter at a
    // `node:http` fixture; https outside local, since a tenant credential rides every call.
    NEON_API_URL: z.url().default('https://console.neon.tech/api/v2'),
    NETLIFY_API_URL: z.url().default('https://api.netlify.com/api/v1'),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    // How long a started OAuth flow stays completable (T22, criterion 9). It is the entire window a
    // `state` is worth anything in, so it is minutes rather than hours — long enough to be bounced
    // to GitHub, type a password, answer a second factor and approve the scopes on a phone; short
    // enough that a redirect somebody abandoned in a tab is not a pending authorisation sitting in
    // the session store all afternoon. The window does not slide and the record is spent on first
    // use, so this bounds only the abandoned case.
    OAUTH_STATE_TTL_SECONDS: z.coerce.number().int().positive().default(600),
    // The object-store mirror's credentials (spec 016 FR-024). All four or none, like Daytona —
    // and unlike Daytona, silence is only good enough on `local`: a staging or production boot
    // with the mirror unconfigured is refused rather than quietly skipping it.
    //
    // Spec 027 R7 adds the artifacts bucket deployed sites are uploaded to: same endpoint and write
    // credentials, and part of the same all-or-none group, so it is required outside `local` too.
    OBJECT_STORE_ACCESS_KEY_ID: z.string().trim().min(1).optional(),
    OBJECT_STORE_BUCKET_ARTIFACTS: z.string().trim().min(1).optional(),
    OBJECT_STORE_BUCKET_REPOS: z.string().trim().min(1).optional(),
    OBJECT_STORE_ENDPOINT: z.url().optional(),
    OBJECT_STORE_SECRET_ACCESS_KEY: z.string().trim().min(1).optional(),
    OPENBAO_ADDR: z.string().trim().min(1).optional(),
    OPENBAO_KEY_NAME: z.string().trim().min(1).default('forge-kek'),
    OPENBAO_TOKEN: z.string().trim().min(1).optional(),
    // How often the outbox relay looks for unpublished rows when the last batch was not full
    // (spec 005 FR-012). Production keeps the second spec 005 SC-002 was measured at; the suites
    // set 50 so a test that reads a mail waits on the outcome, not on a timer it cannot see
    // (spec 006 research R8). The floor keeps a typo from turning the relay into a busy loop.
    OUTBOX_RELAY_TICK_MS: z.coerce.number().int().min(10).default(1_000),
    // The reset throttle (T19). Two buckets and one progression, exactly as the login and resend
    // throttles are shaped, and tighter than either per address: asking for a reset link a fourth
    // time in a quarter of an hour is not something a person does, and the mail it would send goes
    // to a mailbox the caller has not proved they own.
    //
    // The bucket is what keeps criterion 7 true under load as well as under inspection. A reset
    // endpoint that answers identically for a known and an unknown address but will send unlimited
    // mail to either is still an amplifier aimed at whoever owns the address somebody typed.
    PASSWORD_RESET_ACCOUNT_BURST: z.coerce.number().int().nonnegative().default(3),
    PASSWORD_RESET_DECAY_SECONDS: z.coerce.number().int().positive().default(900),
    PASSWORD_RESET_DELAY_SECONDS: z.coerce.number().int().positive().default(60),
    // Looser, for the reason the other two give: a NAT, an office or a mobile carrier is many
    // people behind one address, and a per-IP limit as tight as the per-address one locks a
    // building out of resetting their passwords.
    PASSWORD_RESET_IP_BURST: z.coerce.number().int().nonnegative().default(20),
    PASSWORD_RESET_MAX_DELAY_SECONDS: z.coerce.number().int().positive().default(3_600),
    // §11's thirty minutes, and the one place that number is written down. Much shorter than a
    // verification link's 24 hours because the two carry different authority: a verification token
    // proves control of a mailbox, whereas this one *is* the account until it is spent — long
    // enough to walk to the other room for the laptop, short enough that a mail archive read next
    // week is not a way in. The boundary is driven by a fake clock, so shortening this does not
    // make the suite fast and lengthening it does not make it slow.
    PASSWORD_RESET_TTL_SECONDS: z.coerce.number().int().positive().default(1_800),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    // Preview routing (spec 017 R3). Previews are served at `<label>-<port>.<PREVIEW_DOMAIN>`;
    // route records and grants are Ed25519 compact JWS minted with PREVIEW_SIGNING_KEY (base64
    // PKCS8, named by PREVIEW_SIGNING_KEY_ID) and verified by the gateway against the public-only
    // PREVIEW_PUBLIC_JWKS. The key is required outside `local` — the `KEK_PROVIDER === 'env'`
    // idiom inverted — and locally defaults to a pair generated at boot, so a restart invalidates
    // every outstanding route, which is what an ephemeral key is for. The JWKS defaults to the
    // key's own public half; an overlapping rotation (FR-042) sets it explicitly with both keys.
    PREVIEW_DOMAIN: z.string().trim().toLowerCase().min(1).default('forge-preview.localhost'),
    // The local gateway's port (`pnpm dev:gateway`, 3200): set, preview urls are
    // `http://<host>:<port>` instead of `https://<host>`. Refused off `local`, below.
    PREVIEW_GATEWAY_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
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
      .pipe(previewJwks)
      .optional(),
    PREVIEW_SIGNING_KEY: z
      .string()
      .trim()
      .refine((value) => readSigningKey(value) !== undefined, {
        message: 'must be a base64 PKCS8 Ed25519 private key',
      })
      .optional(),
    PREVIEW_SIGNING_KEY_ID: z.string().trim().min(1).optional(),
    REDIS_CACHE_URL: redisUrl,
    // §09's `queue` role: BullMQ jobs and locks, `noeviction` with AOF. Its own instance because
    // evicting a job key silently loses work, which is the opposite of what the cache role's
    // `allkeys-lru` is for.
    REDIS_QUEUE_URL: redisUrl,
    REDIS_SESSION_URL: redisUrl,
    // §09's `stream` role: one capped Redis Stream per run, no persistence. Its own instance
    // because a stream must not share the queue's memory ceiling: a run that streams hard would
    // otherwise be the thing that makes the queue refuse a job.
    REDIS_STREAM_URL: redisUrl,
    RESEND_API_KEY: z.string().trim().min(1).optional(),
    // Domains no tenant may attach, nor any name under them (spec 028 R15): a comma list, each
    // entry lower-cased. Empty by default; the platform's own domains are refused regardless.
    RESERVED_DOMAINS: z
      .string()
      .default('')
      .transform((raw) => parseCorsOrigins(raw).map((domain) => domain.toLowerCase())),
    // The gateway's bounded in-process route cache (spec 017 R5): SC-006's five seconds is the
    // TTL, so a rotated label stops resolving everywhere within it with no invalidation channel.
    ROUTE_CACHE_MAX: z.coerce.number().int().positive().default(1_000),
    ROUTE_CACHE_TTL_MS: z.coerce.number().int().positive().default(5_000),
    // The `__Host-` prefix is what makes the browser enforce "no Domain attribute"
    // rather than trust us to omit it (§03, §11), so the prefix is not optional.
    // There is deliberately no `COOKIE_SECURE` switch: a configurable `Secure` is a
    // configurable way to break the prefix.
    // What this process does (spec 013): a comma-separated set over api | agent | events | cron,
    // required with no default so a container that forgot it fails at boot rather than silently
    // becoming an API with no listener (research R1). The parser is shared with `main.ts`, which
    // picks the factory from the same set; its two refusals are re-raised here verbatim so the
    // boot report names the variable like every other one. The suites start with `api` only —
    // they share one outbox table and one queue Redis, and a relay in every parallel worker would
    // hand one suite's mail to another's fake — and the ones that read mail add the worker
    // profiles under the outbox suite lock.
    RUN_PROFILES: z.string().transform((raw, ctx) => {
      try {
        return parseRunProfiles(raw);
      } catch (error) {
        ctx.addIssue({ code: 'custom', message: (error as Error).message });
        return z.NEVER;
      }
    }),
    // The `forge.owner` label on every sandbox the platform creates (spec 014 R2). Defaulted below
    // to `forge-${DEPLOY_ENV}`; two developers on one shared Daytona set distinct owners.
    SANDBOX_OWNER: z.string().trim().min(1).optional(),
    // Where a sandbox posts its callbacks (spec 017 R11): this API's `POST /api/v1/internal/
    // sandbox-callbacks` as the sandbox network reaches it; delivered beside the token.
    SANDBOX_CALLBACK_URL: z.url().default(SANDBOX_CALLBACK_URL_DEFAULT),
    SESSION_COOKIE_NAME: z.string().trim().startsWith('__Host-').default('__Host-forge_session'),
    // Deployed sites are served at `<site_label>.<SITE_DOMAIN>` (spec 027 R10). Defaulted below to
    // `forge-site.localhost` under `local` and required elsewhere; never overlapping PREVIEW_DOMAIN
    // or the product host, because a site is untrusted code served to the public.
    SITE_DOMAIN: z.string().trim().toLowerCase().min(1).optional(),
    SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(1_209_600),
    SUPABASE_API_URL: z.url().default('https://api.supabase.com'),
    // Spec 030 R12: the Supabase OAuth app, all-or-none; none means Supabase connect answers
    // `oauth-provider-not-configured`. The published example secret is refused outside local.
    SUPABASE_OAUTH_CLIENT_ID: z.string().trim().min(1).optional(),
    SUPABASE_OAUTH_CLIENT_SECRET: z.string().trim().min(1).optional(),
    SWAGGER_ENABLED: booleanString.default(true),
    THROTTLE_LIMIT: z.coerce.number().int().positive().default(100),
    THROTTLE_TTL_MS: z.coerce.number().int().positive().default(60_000),
    TURNSTILE_SECRET_KEY: z.string().trim().min(1).optional(),
    // The resend throttle (T14). Two buckets and one progression, exactly as the login throttle is
    // shaped, and tighter than it in both: a sign-in is something a person does many times a day
    // and a mistyped password is ordinary, whereas asking for the same mail a fourth time is not.
    //
    // The address bucket is what stops one mailbox being flooded on anyone's say-so — the request
    // is unauthenticated, so the "victim" of an unthrottled resend is whoever owns the address
    // somebody typed, not the caller.
    VERIFICATION_RESEND_ACCOUNT_BURST: z.coerce.number().int().nonnegative().default(3),
    VERIFICATION_RESEND_DECAY_SECONDS: z.coerce.number().int().positive().default(900),
    VERIFICATION_RESEND_DELAY_SECONDS: z.coerce.number().int().positive().default(60),
    // Looser than the address bucket for the reason the login comment gives: a NAT, an office or a
    // mobile carrier is many people behind one address, and a per-IP limit as tight as the
    // per-address one locks a building out of confirming their mail.
    VERIFICATION_RESEND_IP_BURST: z.coerce.number().int().nonnegative().default(20),
    VERIFICATION_RESEND_MAX_DELAY_SECONDS: z.coerce.number().int().positive().default(3_600),
    // Spec 029 R2: while true, the inbound paths are still served on the API's own host as well as
    // HOOKS_HOST, so senders configured before the hooks origin keep arriving until moved.
    WEBHOOK_LEGACY_ADDRESS: booleanString.default(true),
  })
  .superRefine((environment, ctx) => {
    const isRealDeployment = environment.DEPLOY_ENV !== 'local';

    // Spec 041: a home's runner carries a device token to this URL, so off a laptop it is https.
    if (
      isRealDeployment &&
      environment.AGENT_HOME_ENABLED === true &&
      !environment.AGENT_HOME_SERVER_URL?.startsWith('https://')
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'must be an https URL when AGENT_HOME_ENABLED=true outside DEPLOY_ENV=local',
        path: ['AGENT_HOME_SERVER_URL'],
      });
    }

    if (
      isRealDeployment &&
      environment.AGENT_HOME_ENABLED === true &&
      !/^\d+\.\d+\.\d+$/.test(environment.AGENT_HOME_CLAUDE_VERSION)
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'must be an exact version (x.y.z) when AGENT_HOME_ENABLED=true outside DEPLOY_ENV=local',
        path: ['AGENT_HOME_CLAUDE_VERSION'],
      });
    }

    // The build identity (FR-033, FR-036). `local` fills these in the transform below; every other
    // environment must have had them baked in at build, so an image that lost its provenance
    // refuses to start rather than serving an unidentifiable `/api/v1/version`.
    for (const key of ['BUILD_AT', 'BUILD_COMMIT', 'BUILD_DIGEST'] as const) {
      if (isRealDeployment && environment[key] === undefined) {
        ctx.addIssue({
          code: 'custom',
          message:
            'is baked into the image at build and is required outside DEPLOY_ENV=local; a build that cannot say which artifact it is refuses to start (FR-033)',
          path: [key],
        });
      }
    }

    if (environment.KEK_PROVIDER === 'env') {
      if (isRealDeployment) {
        ctx.addIssue({
          code: 'custom',
          message: 'the env KEK provider holds the master key in plaintext and is local-only',
          path: ['KEK_PROVIDER'],
        });
      }

      if (environment.KEK_ENV_MASTER_KEY === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: 'is required when KEK_PROVIDER is "env"',
          path: ['KEK_ENV_MASTER_KEY'],
        });
      }
    }

    if (environment.KEK_PROVIDER === 'openbao') {
      for (const key of ['OPENBAO_ADDR', 'OPENBAO_TOKEN'] as const) {
        if (environment[key] === undefined) {
          ctx.addIssue({
            code: 'custom',
            message: 'is required when KEK_PROVIDER is "openbao"',
            path: [key],
          });
        }
      }
    }

    // A ceiling below the first delay throws the progression away and leaves the endpoint with a
    // flat two-second limit that looks configured. Refused at boot, where somebody is watching.
    if (environment.LOGIN_THROTTLE_MAX_DELAY_SECONDS < environment.LOGIN_THROTTLE_DELAY_SECONDS) {
      ctx.addIssue({
        code: 'custom',
        message: `must be at least LOGIN_THROTTLE_DELAY_SECONDS (${environment.LOGIN_THROTTLE_DELAY_SECONDS})`,
        path: ['LOGIN_THROTTLE_MAX_DELAY_SECONDS'],
      });
    }

    // Same check, same reason: a ceiling below the first delay throws the progression away and
    // leaves the endpoint with a flat limit that looks configured.
    if (
      environment.VERIFICATION_RESEND_MAX_DELAY_SECONDS <
      environment.VERIFICATION_RESEND_DELAY_SECONDS
    ) {
      ctx.addIssue({
        code: 'custom',
        message: `must be at least VERIFICATION_RESEND_DELAY_SECONDS (${environment.VERIFICATION_RESEND_DELAY_SECONDS})`,
        path: ['VERIFICATION_RESEND_MAX_DELAY_SECONDS'],
      });
    }

    // And once more for the reset bucket.
    if (environment.PASSWORD_RESET_MAX_DELAY_SECONDS < environment.PASSWORD_RESET_DELAY_SECONDS) {
      ctx.addIssue({
        code: 'custom',
        message: `must be at least PASSWORD_RESET_DELAY_SECONDS (${environment.PASSWORD_RESET_DELAY_SECONDS})`,
        path: ['PASSWORD_RESET_MAX_DELAY_SECONDS'],
      });
    }

    if (environment.MAIL_PROVIDER === 'resend' && environment.RESEND_API_KEY === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'is required when MAIL_PROVIDER is "resend"',
        path: ['RESEND_API_KEY'],
      });
    }

    // A provider configured by halves fails at the redirect rather than at boot,
    // so both-or-neither is checked here. Neither half set means "disabled".
    for (const provider of ['GITHUB', 'GOOGLE'] as const) {
      const id = `${provider}_OAUTH_CLIENT_ID` as const;
      const secret = `${provider}_OAUTH_CLIENT_SECRET` as const;

      if (environment[id] !== undefined && environment[secret] === undefined) {
        ctx.addIssue({ code: 'custom', message: `is required when ${id} is set`, path: [secret] });
      }

      if (environment[secret] !== undefined && environment[id] === undefined) {
        ctx.addIssue({ code: 'custom', message: `is required when ${secret} is set`, path: [id] });
      }
    }

    // The GitHub App by halves fails at the first install rather than at boot: all four or none.
    const githubAppSet = GITHUB_APP_ENV_NAMES.filter((key) => environment[key] !== undefined);

    if (githubAppSet.length > 0 && githubAppSet.length < GITHUB_APP_ENV_NAMES.length) {
      for (const key of GITHUB_APP_ENV_NAMES) {
        if (environment[key] === undefined) {
          ctx.addIssue({
            code: 'custom',
            message: `is required when any GITHUB_APP_* variable is set (${githubAppSet.join(', ')})`,
            path: [key],
          });
        }
      }
    }

    // The `.env.example` key is published: signing App JWTs with it outside local is signing with
    // a key anyone can read — the PREVIEW_SIGNING_KEY_ID refusal again (R2).
    if (isRealDeployment && environment.GITHUB_APP_PRIVATE_KEY === EXAMPLE_GITHUB_APP_PRIVATE_KEY) {
      ctx.addIssue({
        code: 'custom',
        message: 'is the published example key and is local-only (R2)',
        path: ['GITHUB_APP_PRIVATE_KEY'],
      });
    }

    // The `.env.example` webhook secret is published, so a deployment verifying with it verifies
    // nothing — anyone can sign a delivery it will accept. Same refusal, same reason (R10).
    if (isRealDeployment && environment.GITHUB_WEBHOOK_SECRET === EXAMPLE_GITHUB_WEBHOOK_SECRET) {
      ctx.addIssue({
        code: 'custom',
        message: `"${EXAMPLE_GITHUB_WEBHOOK_SECRET}" is the published example secret and is local-only (R10)`,
        path: ['GITHUB_WEBHOOK_SECRET'],
      });
    }

    // Daytona configured by halves fails on the first sandbox call rather than at boot, so
    // both-or-neither is checked here, as for OAuth. Both set on a real deployment is the env
    // KEK refusal again — same shape, same reason (ADR 027).
    if (environment.DAYTONA_API_URL !== undefined && environment.DAYTONA_API_KEY === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'is required when DAYTONA_API_URL is set',
        path: ['DAYTONA_API_KEY'],
      });
    }

    if (environment.DAYTONA_API_KEY !== undefined && environment.DAYTONA_API_URL === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'is required when DAYTONA_API_KEY is set',
        path: ['DAYTONA_API_URL'],
      });
    }

    if (
      isRealDeployment &&
      environment.DAYTONA_API_URL !== undefined &&
      environment.DAYTONA_API_KEY !== undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'a Daytona API key held in the environment is local-only (ADR 027)',
        path: ['DAYTONA_API_KEY'],
      });
    }

    // Object-store credentials (spec 016 FR-024): all-or-none, mirroring Daytona above, plus a
    // real-deployment refusal Daytona doesn't have — there the pair is local-only; here the store
    // is required outside `local`, so an unconfigured mirror fails at boot instead of at the first
    // checkpoint.
    const objectStoreKeys = [
      'OBJECT_STORE_ENDPOINT',
      'OBJECT_STORE_ACCESS_KEY_ID',
      'OBJECT_STORE_SECRET_ACCESS_KEY',
      'OBJECT_STORE_BUCKET_REPOS',
      'OBJECT_STORE_BUCKET_ARTIFACTS',
    ] as const;
    const objectStoreSetCount = objectStoreKeys.filter(
      (key) => environment[key] !== undefined,
    ).length;

    if (objectStoreSetCount > 0 && objectStoreSetCount < objectStoreKeys.length) {
      for (const key of objectStoreKeys) {
        if (environment[key] === undefined) {
          ctx.addIssue({
            code: 'custom',
            message: 'is required when any OBJECT_STORE_* variable is set',
            path: [key],
          });
        }
      }
    }

    if (isRealDeployment && objectStoreSetCount === 0) {
      ctx.addIssue({
        code: 'custom',
        message:
          'the object-store mirror must be configured outside DEPLOY_ENV=local; unset is refused, not silently skipped (FR-024)',
        path: ['OBJECT_STORE_ENDPOINT'],
      });
    }

    // Spec 027 R10: the domain untrusted sites are served under. Required outside `local` like the
    // object store, and refused when it equals, sits under, or sits above PREVIEW_DOMAIN or the
    // product host: a site's script could otherwise set a cookie either of those reads.
    if (isRealDeployment && environment.SITE_DOMAIN === undefined) {
      ctx.addIssue({
        code: 'custom',
        message:
          'is required outside DEPLOY_ENV=local; deployed sites need a domain of their own (R10)',
        path: ['SITE_DOMAIN'],
      });
    }

    const siteDomain = environment.SITE_DOMAIN ?? SITE_DOMAIN_LOCAL_DEFAULT;
    const appHost = productHost(environment.APP_URL);

    if (domainsOverlap(siteDomain, environment.PREVIEW_DOMAIN)) {
      ctx.addIssue({
        code: 'custom',
        message: `must not equal, sit under or sit above PREVIEW_DOMAIN (${environment.PREVIEW_DOMAIN}); a site and a preview never share a cookie scope (R10)`,
        path: ['SITE_DOMAIN'],
      });
    }

    if (appHost !== undefined && domainsOverlap(siteDomain, appHost)) {
      ctx.addIssue({
        code: 'custom',
        message: `must not equal, sit under or sit above the product host APP_URL names (${appHost}); a site never shares a cookie scope with the product (R10)`,
        path: ['SITE_DOMAIN'],
      });
    }

    // Spec 029 R2: the hooks origin. Required outside `local`, and never the product host: an
    // inbound sender must not reach the product's cookie-bearing origin by its own address.
    if (isRealDeployment && environment.HOOKS_HOST === undefined) {
      ctx.addIssue({
        code: 'custom',
        message:
          'is required outside DEPLOY_ENV=local; inbound webhooks need a host of their own (R2)',
        path: ['HOOKS_HOST'],
      });
    }

    const hooksHost = environment.HOOKS_HOST ?? HOOKS_HOST_LOCAL_DEFAULT;

    if (appHost !== undefined && hooksHost === appHost) {
      ctx.addIssue({
        code: 'custom',
        message: `must not equal the product host APP_URL names (${appHost}); inbound webhooks are served on an origin of their own (R2)`,
        path: ['HOOKS_HOST'],
      });
    }

    // Spec 028 R15: the Cloudflare for SaaS group by halves fails at the first registration
    // rather than at boot, so all three or none, naming every one that is missing.
    const cloudflareSet = CLOUDFLARE_ENV_NAMES.filter((key) => environment[key] !== undefined);

    if (cloudflareSet.length > 0 && cloudflareSet.length < CLOUDFLARE_ENV_NAMES.length) {
      for (const key of CLOUDFLARE_ENV_NAMES) {
        if (environment[key] === undefined) {
          ctx.addIssue({
            code: 'custom',
            message: `is required when any of ${CLOUDFLARE_ENV_NAMES.join(', ')} is set (${cloudflareSet.join(', ')})`,
            path: [key],
          });
        }
      }
    }

    // The token rides every request to this URL; plain http would hand it to the network path.
    if (isRealDeployment && new URL(environment.CLOUDFLARE_API_URL).protocol !== 'https:') {
      ctx.addIssue({
        code: 'custom',
        message:
          'must be https outside DEPLOY_ENV=local; the API token travels with every call (R15)',
        path: ['CLOUDFLARE_API_URL'],
      });
    }

    // Spec 030 R12: a tenant's provider credential rides every call to these URLs.
    for (const key of CONNECTOR_API_URL_NAMES) {
      if (isRealDeployment && new URL(environment[key]).protocol !== 'https:') {
        ctx.addIssue({
          code: 'custom',
          message:
            'must be https outside DEPLOY_ENV=local; a tenant credential travels with every call (spec 030 R12)',
          path: [key],
        });
      }
    }

    // Spec 032 R13: a provider's BYOS client is a set. CLIENT_ID, TOKEN_URL, API_BASE_URL and
    // SCOPES require each other, one of AUTHORIZE_URL (redirect) or DEVICE_URL (device) is needed,
    // and every URL is https outside local: a person's subscription token rides these calls.
    for (const prefix of BYOS_PROVIDER_PREFIXES) {
      const core = ['CLIENT_ID', 'TOKEN_URL', 'API_BASE_URL', 'SCOPES'] as const;
      const flow = ['AUTHORIZE_URL', 'DEVICE_URL'] as const;
      const urls = [
        'API_BASE_URL',
        'AUTHORIZE_URL',
        'DEVICE_URL',
        'REVOKE_URL',
        'TOKEN_URL',
      ] as const;
      const all = [...core, ...flow, 'CLIENT_SECRET', 'REVOKE_URL'] as const;
      const value = (name: (typeof all)[number]) => environment[`${prefix}_${name}`];

      if (all.some((name) => value(name) !== undefined)) {
        for (const name of core) {
          if (value(name) === undefined) {
            ctx.addIssue({
              code: 'custom',
              message: `is required when any ${prefix}_* is set (spec 032 R13)`,
              path: [`${prefix}_${name}`],
            });
          }
        }

        if (flow.every((name) => value(name) === undefined)) {
          ctx.addIssue({
            code: 'custom',
            message: `one of ${prefix}_AUTHORIZE_URL or ${prefix}_DEVICE_URL is required (spec 032 R13)`,
            path: [`${prefix}_AUTHORIZE_URL`],
          });
        }
      }

      for (const name of urls) {
        const url = value(name);

        if (isRealDeployment && url !== undefined && new URL(url).protocol !== 'https:') {
          ctx.addIssue({
            code: 'custom',
            message:
              'must be https outside DEPLOY_ENV=local; a subscription token travels with every call (spec 032)',
            path: [`${prefix}_${name}`],
          });
        }
      }
    }

    // The Supabase OAuth app by halves fails at the first connect rather than at boot.
    if (
      environment.SUPABASE_OAUTH_CLIENT_ID !== undefined &&
      environment.SUPABASE_OAUTH_CLIENT_SECRET === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'is required when SUPABASE_OAUTH_CLIENT_ID is set',
        path: ['SUPABASE_OAUTH_CLIENT_SECRET'],
      });
    }

    if (
      environment.SUPABASE_OAUTH_CLIENT_SECRET !== undefined &&
      environment.SUPABASE_OAUTH_CLIENT_ID === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'is required when SUPABASE_OAUTH_CLIENT_SECRET is set',
        path: ['SUPABASE_OAUTH_CLIENT_ID'],
      });
    }

    if (
      isRealDeployment &&
      environment.SUPABASE_OAUTH_CLIENT_SECRET === EXAMPLE_SUPABASE_OAUTH_CLIENT_SECRET
    ) {
      ctx.addIssue({
        code: 'custom',
        message: `"${EXAMPLE_SUPABASE_OAUTH_CLIENT_SECRET}" is the published example secret and is local-only (spec 030 R12)`,
        path: ['SUPABASE_OAUTH_CLIENT_SECRET'],
      });
    }

    // The target is where tenants' CNAMEs land; overlapping a domain the platform serves would let
    // a tenant's hostname be confused with a preview, a site or the product itself (R15).
    if (environment.CUSTOM_HOSTNAME_TARGET !== undefined) {
      const target = environment.CUSTOM_HOSTNAME_TARGET;
      const served = [
        ['PREVIEW_DOMAIN', environment.PREVIEW_DOMAIN],
        ['SITE_DOMAIN', siteDomain],
        ['the product host APP_URL names', appHost],
      ] as const;

      for (const [name, domain] of served) {
        if (domain !== undefined && domainsOverlap(target, domain)) {
          ctx.addIssue({
            code: 'custom',
            message: `must not equal, sit under or sit above ${name} (${domain}); custom hostnames are aimed at a name of their own (R15)`,
            path: ['CUSTOM_HOSTNAME_TARGET'],
          });
        }
      }
    }

    // Same shape for the callback URL (R11): the default names this machine's loopback, which no
    // sandbox on a real deployment can reach, so a boot that forgot it fails here, not at the first
    // callback that goes nowhere.
    if (isRealDeployment && environment.SANDBOX_CALLBACK_URL === SANDBOX_CALLBACK_URL_DEFAULT) {
      ctx.addIssue({
        code: 'custom',
        message:
          'the localhost default is local-only; set the URL sandboxes reach this API at outside DEPLOY_ENV=local (R11)',
        path: ['SANDBOX_CALLBACK_URL'],
      });
    }

    // §13: the API is released blue/green and workers roll with drain; one process cannot be
    // both. The local all-in-one stack is the one place the two lanes share a process.
    if (
      isRealDeployment &&
      environment.RUN_PROFILES.has('api') &&
      hasWorkerProfile(environment.RUN_PROFILES)
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'RUN_PROFILES combines api with a worker profile; the API is released blue/green and workers roll with drain, so one process cannot be both outside DEPLOY_ENV=local (§13)',
        path: ['RUN_PROFILES'],
      });
    }

    if (isRealDeployment && environment.ANTHROPIC_API_KEY !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'an Anthropic API key held in the environment is local-only (ADR 027)',
        path: ['ANTHROPIC_API_KEY'],
      });
    }

    for (const key of [
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_MODEL_PREFIX',
      'ANTHROPIC_TOOL_SUFFIX',
    ] as const) {
      if (isRealDeployment && environment[key] !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message: 'an Anthropic proxy override is local-only (ADR 027)',
          path: [key],
        });
      }
    }

    if (isRealDeployment && environment.PREVIEW_GATEWAY_PORT !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'a plain-HTTP preview gateway port is local-only',
        path: ['PREVIEW_GATEWAY_PORT'],
      });
    }

    // Spec 017: the broker link and the preview signing key, each keyed on DEPLOY_ENV.
    if (environment.BROKER_TRANSPORT === 'plain') {
      if (isRealDeployment) {
        ctx.addIssue({
          code: 'custom',
          message:
            'the plain broker transport is a bearer token that resolves any label and is local-only (R4)',
          path: ['BROKER_TRANSPORT'],
        });
      }
    }

    const mtlsKeys = [
      'BROKER_TLS_CA',
      'BROKER_TLS_CERT',
      'BROKER_TLS_KEY',
      'BROKER_CLIENT_CNS',
    ] as const;
    const mtlsSetCount = mtlsKeys.filter((key) => environment[key] !== undefined).length;

    if (mtlsSetCount > 0 || environment.BROKER_TRANSPORT === 'mtls') {
      for (const key of mtlsKeys) {
        if (environment[key] === undefined) {
          ctx.addIssue({
            code: 'custom',
            message:
              mtlsSetCount > 0
                ? 'is required when any BROKER_TLS_* / BROKER_CLIENT_CNS variable is set'
                : 'is required when BROKER_TRANSPORT is "mtls"',
            path: [key],
          });
        }
      }
    }

    if (environment.PREVIEW_SIGNING_KEY === undefined) {
      if (isRealDeployment) {
        ctx.addIssue({
          code: 'custom',
          message: 'is required outside DEPLOY_ENV=local; the ephemeral pair is local-only (R3)',
          path: ['PREVIEW_SIGNING_KEY'],
        });
      }
    } else if (environment.PREVIEW_SIGNING_KEY_ID === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'is required when PREVIEW_SIGNING_KEY is set',
        path: ['PREVIEW_SIGNING_KEY_ID'],
      });
    }

    // The `.env.example` pair is published, so a deployment signing under its id is signing with
    // a key anyone can read — the env KEK refusal again, keyed on the id the example names.
    if (isRealDeployment && environment.PREVIEW_SIGNING_KEY_ID === EXAMPLE_SIGNING_KEY_ID) {
      ctx.addIssue({
        code: 'custom',
        message: `"${EXAMPLE_SIGNING_KEY_ID}" is the published example key and is local-only (R3)`,
        path: ['PREVIEW_SIGNING_KEY_ID'],
      });
    }

    // Against the *resolved* id, so an explicit JWKS beside the local ephemeral pair is held to
    // the same rule as one beside a configured key: it must carry the key that signs.
    const signingKeyId = environment.PREVIEW_SIGNING_KEY_ID ?? EPHEMERAL_SIGNING_KEY_ID;
    if (
      environment.PREVIEW_PUBLIC_JWKS !== undefined &&
      !environment.PREVIEW_PUBLIC_JWKS.keys.some((key) => key.kid === signingKeyId)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: `must carry the public key PREVIEW_SIGNING_KEY_ID names (${signingKeyId}), or nothing minted verifies`,
        path: ['PREVIEW_PUBLIC_JWKS'],
      });
    }

    if (!isCatalogueModel(environment.AGENT_DEFAULT_MODEL)) {
      ctx.addIssue({
        code: 'custom',
        message: `must be one of the model catalogue's ids`,
        path: ['AGENT_DEFAULT_MODEL'],
      });
    }

    if (isRealDeployment) {
      for (const [key, floor] of Object.entries(ARGON2_DEPLOYMENT_FLOOR)) {
        if (environment[key as keyof typeof ARGON2_DEPLOYMENT_FLOOR] < floor) {
          ctx.addIssue({
            code: 'custom',
            message: `must be at least ${floor} on a real deployment (§11)`,
            path: [key],
          });
        }
      }
    }
  })
  .transform((environment) => {
    // Only local reaches here without a key (the superRefine refused it elsewhere): a fresh pair
    // per boot, exposed in the same shape an explicit one has so the signer never knows which.
    const PREVIEW_SIGNING_KEY =
      environment.PREVIEW_SIGNING_KEY ??
      generateKeyPairSync('ed25519')
        .privateKey.export({ format: 'der', type: 'pkcs8' })
        .toString('base64');
    const PREVIEW_SIGNING_KEY_ID = environment.PREVIEW_SIGNING_KEY_ID ?? EPHEMERAL_SIGNING_KEY_ID;

    return {
      ...environment,
      // Only `local` reaches here without these (the refinement refused them elsewhere): a working
      // tree has no digest and no build time, so the route answers `dev` and this boot's clock and
      // works everywhere rather than being a deployment-only endpoint nobody exercises.
      BUILD_AT: environment.BUILD_AT ?? new Date().toISOString(),
      BUILD_COMMIT: environment.BUILD_COMMIT ?? VERSION_LOCAL_PLACEHOLDER,
      BUILD_DIGEST: environment.BUILD_DIGEST ?? VERSION_LOCAL_PLACEHOLDER,
      LOCAL_AGENT_ENABLED: environment.LOCAL_AGENT_ENABLED ?? environment.DEPLOY_ENV === 'local',
      AGENT_HOME_ENABLED: environment.AGENT_HOME_ENABLED ?? environment.DEPLOY_ENV === 'local',
      AGENT_HOME_SERVER_URL:
        environment.AGENT_HOME_SERVER_URL ??
        (environment.DEPLOY_ENV === 'local' ? 'http://host.docker.internal:3000' : undefined),
      // Plain is local-only (refused above elsewhere), so a well-known default keeps the compose
      // stack and `pnpm dev:gateway` in step without another value to copy between them.
      BROKER_SHARED_SECRET:
        environment.BROKER_SHARED_SECRET ??
        (environment.BROKER_TRANSPORT === 'plain' ? 'local-broker-secret' : undefined),
      PREVIEW_PUBLIC_JWKS:
        environment.PREVIEW_PUBLIC_JWKS ?? deriveJwks(PREVIEW_SIGNING_KEY, PREVIEW_SIGNING_KEY_ID),
      PREVIEW_SIGNING_KEY,
      PREVIEW_SIGNING_KEY_ID,
      SANDBOX_OWNER: environment.SANDBOX_OWNER ?? `forge-${environment.DEPLOY_ENV}`,
      // Only `local` reaches here without one (the refinement refused it elsewhere).
      SITE_DOMAIN: environment.SITE_DOMAIN ?? SITE_DOMAIN_LOCAL_DEFAULT,
      HOOKS_HOST: environment.HOOKS_HOST ?? HOOKS_HOST_LOCAL_DEFAULT,
    };
  });

export type Environment = z.infer<typeof environmentSchema>;

export function validateEnvironment(config: Record<string, unknown>): Environment {
  // A `VITE_*` var is bundled into the browser build; none of 017's names belongs in one.
  const leaked = Object.keys(config).filter(
    (key) => key.startsWith('VITE_') && PREVIEW_ENV_NAMES.some((name) => key.includes(name)),
  );

  if (leaked.length > 0) {
    throw new Error(
      `Invalid environment configuration: ${leaked.join(', ')} would ship a preview-gateway value to the browser`,
    );
  }

  const result = environmentSchema.safeParse(config);

  if (!result.success) {
    throw new Error(`Invalid environment configuration: ${z.prettifyError(result.error)}`);
  }

  return result.data;
}

export function parseCorsOrigins(value: string): string[] {
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}
