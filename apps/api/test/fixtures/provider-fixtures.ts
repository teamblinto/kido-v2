import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * The five spec 030 providers' APIs in memory (T026): one `node:http` server each, answering the
 * endpoints the adapters call from state a spec sets and reads back. Not a mock of an adapter — the
 * real adapter is pointed at `url` through its `*_API_URL` — so what a suite proves is the wire.
 *
 * `mode` switches every authenticated answer at once: `good` routes; `revoked`, `missing-scope`,
 * `rate-limited` and `unavailable` answer as that provider does for each (research R5). A request
 * whose bearer is not `token` is answered as revoked. `requests` records every call in order.
 */
export type FixtureMode = 'good' | 'missing-scope' | 'rate-limited' | 'revoked' | 'unavailable';

export interface RecordedRequest {
  readonly authorization: string | undefined;
  readonly body: unknown;
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  /** The body's bytes as sent (an upload's digest is of these, not of the decoded `body`). */
  readonly raw: Buffer;
}

export interface Answer {
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  readonly status: number;
}

export type RouteHandler = (params: Record<string, string>, request: RecordedRequest) => Answer;

export interface ProviderFixture {
  readonly url: string;
  /** The credential the fixture accepts. */
  token: string;
  mode: FixtureMode;
  readonly requests: RecordedRequest[];
  /** Adds (or, registered later, overrides) an endpoint. */
  route(method: string, pattern: string, handler: RouteHandler): void;
  /** Back to `good`, the default token, no recorded requests, no spec-added routes. */
  reset(): void;
  close(): Promise<void>;
}

interface Route {
  readonly handler: RouteHandler;
  readonly keys: string[];
  readonly method: string;
  readonly regex: RegExp;
}

/** How one provider answers the non-`good` modes; `undefined` routes as `good`. */
type ModeAnswers = (
  mode: Exclude<FixtureMode, 'good'>,
  request: RecordedRequest,
) => Answer | undefined;

function readBody(request: IncomingMessage): Promise<{ body: unknown; raw: Buffer }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];

    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks);
      const text = raw.toString('utf8');
      const type = request.headers['content-type'] ?? '';

      if (text === '') return resolve({ body: undefined, raw });
      if (type.includes('application/x-www-form-urlencoded')) {
        return resolve({ body: Object.fromEntries(new URLSearchParams(text)), raw });
      }
      if (type.includes('application/octet-stream')) return resolve({ body: undefined, raw });

      try {
        resolve({ body: JSON.parse(text), raw });
      } catch {
        resolve({ body: text, raw });
      }
    });
  });
}

function write(response: ServerResponse, answer: Answer): void {
  const payload = answer.body === undefined ? '' : JSON.stringify(answer.body);

  response.writeHead(answer.status, {
    'Content-Length': Buffer.byteLength(payload),
    'Content-Type': 'application/json',
    ...answer.headers,
  });
  response.end(payload);
}

function bearer(request: RecordedRequest): string | undefined {
  return request.authorization?.replace(/^Bearer /i, '');
}

/** A fixed port, for a suite whose `*_API_URL` must be settled before `AppModule` loads. */
export interface FixtureOptions {
  readonly port?: number;
}

async function startFixture(options: {
  readonly port?: number;
  readonly defaultToken: string;
  readonly modes: ModeAnswers;
  /** Paths answered without the bearer check (OAuth endpoints authenticate otherwise). */
  readonly open?: (request: RecordedRequest) => boolean;
  readonly routes: (fixture: ProviderFixture) => void;
}): Promise<ProviderFixture> {
  const routes: Route[] = [];
  const requests: RecordedRequest[] = [];

  const server = createServer((incoming, response) => {
    void (async () => {
      const url = new URL(incoming.url ?? '/', 'http://fixture');
      const { body, raw } = await readBody(incoming);
      const request: RecordedRequest = {
        authorization: incoming.headers.authorization,
        body,
        raw,
        method: incoming.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
      };
      requests.push(request);

      const isOpen = options.open?.(request) === true;

      if (!isOpen && fixture.mode !== 'good') {
        const answer = options.modes(fixture.mode, request);
        if (answer !== undefined) return write(response, answer);
      }

      if (!isOpen && bearer(request) !== fixture.token) {
        const answer = options.modes('revoked', request);
        if (answer !== undefined) return write(response, answer);
      }

      // Latest registration wins, so a spec can override a default endpoint.
      for (const route of [...routes].reverse()) {
        if (route.method !== request.method) continue;
        const match = route.regex.exec(request.path);
        if (match === null) continue;

        const params = Object.fromEntries(
          route.keys.map((key, index) => [key, decodeURIComponent(match[index + 1]!)]),
        );

        return write(response, route.handler(params, request));
      }

      write(response, { body: { message: 'Not Found' }, status: 404 });
    })();
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const fixture: ProviderFixture = {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    mode: 'good',
    requests,
    reset() {
      fixture.mode = 'good';
      fixture.token = options.defaultToken;
      requests.length = 0;
      routes.length = defaults;
    },
    route(method, pattern, handler) {
      const keys: string[] = [];
      // `:key` is one segment; `*key` is the rest of the path (a deploy's file path).
      const source = pattern.replace(/([:*])([A-Za-z_]+)/g, (_, kind: string, key: string) => {
        keys.push(key);
        return kind === '*' ? '(.+)' : '([^/]+)';
      });
      routes.push({ handler, keys, method, regex: new RegExp(`^${source}$`) });
    },
    token: options.defaultToken,
    url: `http://127.0.0.1:${port}`,
  };

  options.routes(fixture);
  const defaults = routes.length;

  return fixture;
}

const unavailable: Answer = { body: { message: 'Service Unavailable' }, status: 503 };

// ─── Netlify (contracts/provider-adapters.md § 2) ─────────────────────────────────────────────

export const NETLIFY_TOKEN = 'nfp_fixtureNetlifyToken0123456789abcdef';

export interface NetlifySite {
  readonly id: string;
  readonly name: string;
  readonly url: string;
}

export interface NetlifyDeploy {
  readonly id: string;
  readonly siteId: string;
  readonly title: string;
  /** `path → sha1` as the create named them. */
  readonly files: Record<string, string>;
  /** The digests Netlify asked for; each goes when its bytes arrive. */
  required: string[];
  state: string;
  /** Polls still to answer `processing` once every file is in. */
  processingPolls: number;
}

export interface NetlifyFixture extends ProviderFixture {
  /** The token's sites; `site-1` / `acme-site` by default. */
  sites: NetlifySite[];
  /** Every deploy created, in order. */
  readonly deploys: NetlifyDeploy[];
  /** `deployId → path → sha1 of the bytes uploaded`. */
  readonly uploads: Map<string, Map<string, string>>;
  /** Each site's stored digests: a later deploy does not ask for them again. */
  readonly stored: Map<string, Set<string>>;
  /** A deploy whose files are all in answers `error` rather than `ready`. */
  failDeploys: boolean;
}

function sha1(bytes: Buffer): string {
  return createHash('sha1').update(bytes).digest('hex');
}

export async function startNetlifyFixture({ port }: FixtureOptions = {}): Promise<NetlifyFixture> {
  const defaultSites = (): NetlifySite[] => [
    { id: 'site-1', name: 'acme-site', url: 'https://acme-site.netlify.app' },
  ];
  let sites = defaultSites();
  const deploys: NetlifyDeploy[] = [];
  const uploads = new Map<string, Map<string, string>>();
  const stored = new Map<string, Set<string>>();
  let failDeploys = false;
  let nextId = 0;

  const toSite = (site: NetlifySite) => ({
    id: site.id,
    name: site.name,
    ssl_url: site.url,
    url: site.url.replace(/^https:/, 'http:'),
  });
  const toDeploy = (deploy: NetlifyDeploy) => ({
    id: deploy.id,
    required: deploy.required,
    site_id: deploy.siteId,
    state: deploy.state,
    title: deploy.title,
  });
  const notFound: Answer = { body: { code: 404, message: 'Not Found' }, status: 404 };

  const fixture = (await startFixture({
    port,
    defaultToken: NETLIFY_TOKEN,
    modes: (mode) => {
      switch (mode) {
        case 'revoked':
          return { body: { code: 401, message: 'Access Denied' }, status: 401 };
        case 'missing-scope':
          return { body: { code: 403, message: 'Forbidden' }, status: 403 };
        case 'rate-limited':
          return {
            body: { message: 'Rate limit exceeded' },
            headers: { 'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 30) },
            status: 429,
          };
        case 'unavailable':
          return unavailable;
      }
    },
    routes: (f) => {
      f.route('GET', '/user', () => ({
        body: { email: 'owner@acme.test', full_name: 'Acme Owner', id: 'user-1' },
        status: 200,
      }));
      f.route('GET', '/accounts', () => ({
        body: [{ id: 'acct-1', name: 'Acme', slug: 'acme-team' }],
        status: 200,
      }));
      f.route('GET', '/sites', (_params, request) => {
        const name = request.query.get('name') ?? '';

        return { body: sites.filter((s) => s.name.includes(name)).map(toSite), status: 200 };
      });
      f.route('POST', '/:accountSlug/sites', (_params, request) => {
        const { name } = request.body as { name: string };
        if (sites.some((s) => s.name === name)) {
          return { body: { errors: { subdomain: ['must be unique'] } }, status: 422 };
        }
        nextId += 1;
        const site = { id: `site-new-${nextId}`, name, url: `https://${name}.netlify.app` };
        sites.push(site);

        return { body: toSite(site), status: 201 };
      });
      f.route('GET', '/sites/:siteId', ({ siteId }) => {
        const site = sites.find((s) => s.id === siteId);

        return site === undefined ? notFound : { body: toSite(site), status: 200 };
      });
      f.route('POST', '/sites/:siteId/deploys', ({ siteId }, request) => {
        if (!sites.some((s) => s.id === siteId)) return notFound;

        const body = request.body as { files: Record<string, string>; title: string };
        const have = stored.get(siteId!) ?? new Set<string>();
        const deploy: NetlifyDeploy = {
          files: body.files,
          id: `deploy-${deploys.length + 1}`,
          processingPolls: 1,
          required: [...new Set(Object.values(body.files))].filter((d) => !have.has(d)),
          siteId: siteId!,
          state: 'uploading',
          title: body.title,
        };
        deploys.push(deploy);

        return { body: toDeploy(deploy), status: 200 };
      });
      f.route('GET', '/sites/:siteId/deploys', ({ siteId }) => {
        if (!sites.some((s) => s.id === siteId)) return notFound;

        return {
          body: deploys
            .filter((d) => d.siteId === siteId)
            .reverse()
            .map(toDeploy),
          status: 200,
        };
      });
      f.route('GET', '/deploys/:deployId', ({ deployId }) => {
        const deploy = deploys.find((d) => d.id === deployId);
        if (deploy === undefined) return notFound;

        if (deploy.state === 'uploading' && deploy.required.length === 0) {
          deploy.state = 'processing';
        } else if (deploy.state === 'processing') {
          if (deploy.processingPolls > 0) deploy.processingPolls -= 1;
          else deploy.state = failDeploys ? 'error' : 'ready';
        }

        return { body: toDeploy(deploy), status: 200 };
      });
      f.route('PUT', '/deploys/:deployId/files/*path', ({ deployId, path }, request) => {
        const deploy = deploys.find((d) => d.id === deployId);
        if (deploy === undefined) return notFound;

        const key = `/${path!}`;
        const digest = sha1(request.raw);
        if (deploy.files[key] !== digest) {
          return { body: { message: 'digest mismatch' }, status: 422 };
        }

        const files = uploads.get(deploy.id) ?? new Map<string, string>();
        files.set(key, digest);
        uploads.set(deploy.id, files);
        deploy.required = deploy.required.filter((d) => d !== digest);
        const have = stored.get(deploy.siteId) ?? new Set<string>();
        have.add(digest);
        stored.set(deploy.siteId, have);

        return { body: { id: key, sha: digest }, status: 200 };
      });
    },
  })) as NetlifyFixture;

  const reset = fixture.reset.bind(fixture);
  Object.defineProperty(fixture, 'sites', {
    get: () => sites,
    set: (value: NetlifySite[]) => {
      sites = value;
    },
  });
  Object.defineProperty(fixture, 'failDeploys', {
    get: () => failDeploys,
    set: (value: boolean) => {
      failDeploys = value;
    },
  });
  Object.defineProperty(fixture, 'deploys', { get: () => deploys });
  Object.defineProperty(fixture, 'uploads', { get: () => uploads });
  Object.defineProperty(fixture, 'stored', { get: () => stored });
  fixture.reset = () => {
    reset();
    sites = defaultSites();
    deploys.length = 0;
    uploads.clear();
    stored.clear();
    failDeploys = false;
    nextId = 0;
  };

  return fixture;
}

// ─── Neon (§ 3) ───────────────────────────────────────────────────────────────────────────────

export const NEON_KEY = 'napi_fixtureNeonKey0123456789abcdefghijklmnopqrstuv';

export function startNeonFixture({ port }: FixtureOptions = {}): Promise<ProviderFixture> {
  return startFixture({
    port,
    defaultToken: NEON_KEY,
    modes: (mode) => {
      switch (mode) {
        case 'revoked':
          return { body: { code: '', message: 'authorization failed' }, status: 401 };
        // An org key that sees no project: the key is alive, but proves nothing to bind.
        case 'missing-scope':
          return { body: { projects: [] }, status: 200 };
        case 'rate-limited':
          return { body: { message: 'rate limit' }, headers: { 'Retry-After': '5' }, status: 429 };
        case 'unavailable':
          return unavailable;
      }
    },
    routes: (fixture) => {
      fixture.route('GET', '/projects', () => ({
        body: { projects: [{ id: 'proj-1', name: 'acme-db', org_id: 'org-neon-1' }] },
        status: 200,
      }));
    },
  });
}

// ─── Resend (§ 5; R5's inverted pair) ────────────────────────────────────────────────────────

export const RESEND_KEY = 're_fixtureFullAccess_0123456789abcdef';
/** A sending-only key: Resend answers `401 restricted_api_key` to anything but sending. */
export const RESEND_SENDING_KEY = 're_fixtureSendingOnly_0123456789abcdef';

export function startResendFixture({ port }: FixtureOptions = {}): Promise<ProviderFixture> {
  const restricted: Answer = {
    body: {
      message: 'This API key is restricted to only send emails',
      name: 'restricted_api_key',
      statusCode: 401,
    },
    status: 401,
  };

  return startFixture({
    port,
    defaultToken: RESEND_KEY,
    modes: (mode, request) => {
      switch (mode) {
        case 'revoked':
          // A sending-only key is alive; anything else unknown is "not active".
          return bearer(request) === RESEND_SENDING_KEY
            ? restricted
            : {
                body: {
                  message: 'This API key is not active',
                  name: 'restricted_api_key',
                  statusCode: 403,
                },
                status: 403,
              };
        case 'missing-scope':
          return restricted;
        case 'rate-limited':
          return {
            body: { message: 'Too many requests', name: 'rate_limit_exceeded', statusCode: 429 },
            headers: { 'Retry-After': '1' },
            status: 429,
          };
        case 'unavailable':
          return {
            body: { message: 'Internal', name: 'internal_server_error', statusCode: 500 },
            status: 500,
          };
      }
    },
    routes: (fixture) => {
      fixture.route('GET', '/domains', () => ({
        body: {
          data: [{ id: 'dom-1', name: 'mail.acme.test', region: 'us-east-1', status: 'verified' }],
          object: 'list',
        },
        status: 200,
      }));
    },
  });
}

// ─── Cloudflare (§ 6) ────────────────────────────────────────────────────────────────────────

export const CLOUDFLARE_TOKEN = 'cfFixtureToken_0123456789abcdefghijklmnopq';

export interface CloudflareDnsRecord {
  readonly id: string;
  readonly zoneId: string;
  readonly type: string;
  readonly name: string;
  readonly content: string;
  readonly comment: string | null;
  readonly proxied: boolean;
  readonly ttl: number;
}

export interface CloudflareFixture extends ProviderFixture {
  /** The DNS list answers 403 (Zone Read granted, DNS Read not). */
  dnsDenied: boolean;
  /** A record create answers 403 (DNS Read granted, DNS Edit not). */
  dnsWriteDenied: boolean;
  /** The token's zones; `zone-1` / `acme.test` by default. */
  zones: { id: string; name: string; status: string }[];
  /** Every record in every zone, as the API would list it; spec-seeded and written through. */
  records: CloudflareDnsRecord[];
}

function cloudflareError(status: number, code: number, message: string): Answer {
  return {
    body: { errors: [{ code, message }], messages: [], result: null, success: false },
    status,
  };
}

export async function startCloudflareFixture({
  port,
}: FixtureOptions = {}): Promise<CloudflareFixture> {
  let dnsDenied = false;
  let dnsWriteDenied = false;
  let nextId = 0;
  const defaultZones = () => [{ id: 'zone-1', name: 'acme.test', status: 'active' }];
  let zones = defaultZones();
  let records: CloudflareDnsRecord[] = [];
  const fixture = (await startFixture({
    port,
    defaultToken: CLOUDFLARE_TOKEN,
    modes: (mode, request) => {
      switch (mode) {
        case 'revoked':
          return cloudflareError(401, 10000, 'Authentication error');
        // A token with no Zone Read sees no zones.
        case 'missing-scope':
          return request.path === '/zones'
            ? { body: { errors: [], result: [], success: true }, status: 200 }
            : cloudflareError(403, 10000, 'Authentication error');
        case 'rate-limited':
          return {
            ...cloudflareError(429, 971, 'Please wait and consider throttling your request speed'),
            headers: { 'Retry-After': '300' },
          };
        case 'unavailable':
          return cloudflareError(503, 1000, 'Service unavailable');
      }
    },
    routes: (f) => {
      const toApi = (record: CloudflareDnsRecord) => ({
        comment: record.comment,
        content: record.content,
        id: record.id,
        name: record.name,
        proxied: record.proxied,
        ttl: record.ttl,
        type: record.type,
      });
      const ok = (result: unknown, status = 200): Answer => ({
        body: { errors: [], messages: [], result, success: true },
        status,
      });

      f.route('GET', '/zones', (_params, request) => {
        const name = request.query.get('name');
        const status = request.query.get('status');

        return ok(
          zones
            .filter(
              (z) => (name === null || z.name === name) && (status === null || z.status === status),
            )
            .map((z) => ({ account: { id: 'cf-acct-1', name: 'Acme DNS' }, ...z })),
        );
      });
      f.route('GET', '/zones/:zoneId/dns_records', ({ zoneId }, request) => {
        if (dnsDenied) return cloudflareError(403, 10000, 'Authentication error');

        const name = request.query.get('name.exact') ?? request.query.get('name');
        const type = request.query.get('type');

        return ok(
          records
            .filter(
              (r) =>
                r.zoneId === zoneId &&
                (name === null || r.name === name) &&
                (type === null || r.type === type),
            )
            .map(toApi),
        );
      });
      f.route('GET', '/zones/:zoneId/dns_records/:recordId', ({ recordId, zoneId }) => {
        const record = records.find((r) => r.zoneId === zoneId && r.id === recordId);
        if (record === undefined) return cloudflareError(404, 81044, 'Record does not exist.');
        return ok(toApi(record));
      });
      f.route('POST', '/zones/:zoneId/dns_records', ({ zoneId }, request) => {
        if (dnsWriteDenied) return cloudflareError(403, 10000, 'Authentication error');

        const body = request.body as Omit<CloudflareDnsRecord, 'id' | 'zoneId'>;
        nextId += 1;
        const record: CloudflareDnsRecord = {
          comment: body.comment ?? null,
          content: body.content,
          id: `rec-${nextId}`,
          name: body.name,
          proxied: body.proxied ?? false,
          ttl: body.ttl ?? 1,
          type: body.type,
          zoneId: zoneId!,
        };
        records.push(record);
        return ok(toApi(record));
      });
      f.route('DELETE', '/zones/:zoneId/dns_records/:recordId', ({ recordId, zoneId }) => {
        const index = records.findIndex((r) => r.zoneId === zoneId && r.id === recordId);
        if (index < 0) return cloudflareError(404, 81044, 'Record does not exist.');
        records.splice(index, 1);

        return ok({ id: recordId });
      });
    },
  })) as CloudflareFixture;

  const reset = fixture.reset.bind(fixture);
  Object.defineProperty(fixture, 'dnsDenied', {
    get: () => dnsDenied,
    set: (value: boolean) => {
      dnsDenied = value;
    },
  });
  Object.defineProperty(fixture, 'dnsWriteDenied', {
    get: () => dnsWriteDenied,
    set: (value: boolean) => {
      dnsWriteDenied = value;
    },
  });
  Object.defineProperty(fixture, 'zones', {
    get: () => zones,
    set: (value: typeof zones) => {
      zones = value;
    },
  });
  Object.defineProperty(fixture, 'records', {
    get: () => records,
    set: (value: CloudflareDnsRecord[]) => {
      records = value;
    },
  });
  fixture.reset = () => {
    reset();
    dnsDenied = false;
    dnsWriteDenied = false;
    zones = defaultZones();
    records = [];
  };

  return fixture;
}

// ─── Supabase (§ 4, OAuth with PKCE) ─────────────────────────────────────────────────────────

export const SUPABASE_CLIENT_ID = 'fixture-supabase-client';
export const SUPABASE_CLIENT_SECRET = 'fixture-supabase-client-secret-0123456789';

export interface SupabaseFixture extends ProviderFixture {
  /** Access tokens the fixture accepts, besides `token`. */
  readonly accessTokens: Set<string>;
  /** Live refresh tokens. */
  readonly refreshTokens: Set<string>;
  /** Pending codes → the challenge and redirect they were issued for. */
  readonly codes: Map<string, { challenge: string; redirectUri: string }>;
  /** `expires_in` of every token issued. */
  expiresIn: number;
  /** How many refresh grants were answered — the single-flight probe. */
  refreshCount: number;
  /** Issues a code for a challenge, as the authorize page does once the user consents. */
  authorize(challenge: string, redirectUri: string): string;
}

function issued(): string {
  return `sbp_${randomBytes(20).toString('hex')}`;
}

export async function startSupabaseFixture({
  port,
}: FixtureOptions = {}): Promise<SupabaseFixture> {
  const accessTokens = new Set<string>();
  const refreshTokens = new Set<string>();
  const codes = new Map<string, { challenge: string; redirectUri: string }>();
  const expected = `Basic ${Buffer.from(`${SUPABASE_CLIENT_ID}:${SUPABASE_CLIENT_SECRET}`).toString('base64')}`;
  const isOauth = (request: RecordedRequest) => request.path.startsWith('/v1/oauth/');

  // The bearer check accepts every access token issued, not only `token`.
  const fixture = (await startFixture({
    port,
    defaultToken: 'sbp_fixtureDefaultAccessToken0123456789',
    modes: (mode, request) => {
      switch (mode) {
        case 'revoked':
          return accessTokens.has(bearer(request) ?? '') && fixture.mode === 'good'
            ? undefined
            : { body: { message: 'Unauthorized' }, status: 401 };
        case 'missing-scope':
          return { body: { message: 'Forbidden resource' }, status: 403 };
        case 'rate-limited':
          return { body: { message: 'Too many requests' }, status: 429 };
        case 'unavailable':
          return unavailable;
      }
    },
    open: isOauth,
    routes: (f) => {
      f.route('GET', '/v1/profile', () => ({
        body: { gotrue_id: 'user-sb-1', primary_email: 'owner@acme.test' },
        status: 200,
      }));
      f.route('GET', '/v1/organizations', () => ({
        body: [{ id: 'sb-org-1', name: 'Acme Supabase' }],
        status: 200,
      }));
      f.route('GET', '/v1/oauth/authorize', (_params, request) => {
        const redirectUri = request.query.get('redirect_uri') ?? '';
        const code = fixture.authorize(request.query.get('code_challenge') ?? '', redirectUri);
        const target = new URL(redirectUri);
        target.searchParams.set('code', code);
        target.searchParams.set('state', request.query.get('state') ?? '');

        return { headers: { Location: target.toString() }, status: 302 };
      });
      f.route('POST', '/v1/oauth/token', (_params, request) => {
        if (request.authorization !== expected) {
          return { body: { error: 'invalid_client' }, status: 401 };
        }
        const body = (request.body ?? {}) as Record<string, string>;

        if (body.grant_type === 'authorization_code') {
          const pending = codes.get(body.code ?? '');
          codes.delete(body.code ?? '');
          const challenge = createHash('sha256')
            .update(body.code_verifier ?? '')
            .digest('base64url');

          if (pending?.challenge !== challenge || pending.redirectUri !== body.redirect_uri) {
            return { body: { error: 'invalid_grant' }, status: 400 };
          }
        } else if (body.grant_type === 'refresh_token') {
          if (fixture.mode === 'revoked' || !refreshTokens.delete(body.refresh_token ?? '')) {
            return { body: { error: 'invalid_grant' }, status: 400 };
          }
          fixture.refreshCount += 1;
        } else {
          return { body: { error: 'unsupported_grant_type' }, status: 400 };
        }

        const access = issued();
        const refresh = `sbr_${randomBytes(20).toString('hex')}`;
        accessTokens.add(access);
        refreshTokens.add(refresh);

        return {
          body: {
            access_token: access,
            expires_in: fixture.expiresIn,
            refresh_token: refresh,
            token_type: 'Bearer',
          },
          status: 201,
        };
      });
      f.route('POST', '/v1/oauth/revoke', (_params, request) => {
        const body = (request.body ?? {}) as Record<string, string>;
        refreshTokens.delete(body.refresh_token ?? '');

        return { status: 204 };
      });
    },
  })) as SupabaseFixture;

  Object.assign(fixture, {
    accessTokens,
    authorize(challenge: string, redirectUri: string) {
      const code = randomBytes(16).toString('hex');
      codes.set(code, { challenge, redirectUri });
      return code;
    },
    codes,
    expiresIn: 3600,
    refreshCount: 0,
    refreshTokens,
  });

  // An issued access token passes the bearer check exactly as `token` does.
  const reset = fixture.reset.bind(fixture);
  fixture.reset = () => {
    reset();
    accessTokens.clear();
    refreshTokens.clear();
    codes.clear();
    fixture.expiresIn = 3600;
    fixture.refreshCount = 0;
  };

  return fixture;
}
