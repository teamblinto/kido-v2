import { randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/**
 * Cloudflare for SaaS custom hostnames in one process (spec 028 research R2,
 * contracts/domain-serving.md § 3), as `fake-daytona.ts` is for Daytona: a loopback `node:http`
 * server the real `CloudflareForSaasAdapter` is pointed at through `CLOUDFLARE_API_URL`, so the
 * adapter's `fetch`, headers, envelope parsing and error mapping are the real code path.
 *
 * Routes, under `/client/v4/zones/{zone}/custom_hostnames`:
 *
 * - `POST` registers `{hostname, ssl}` and answers the custom hostname object. A hostname already
 *   registered answers the duplicate error (`409`, code `1406`) — seed one with `seed()`.
 * - `GET /{id}` answers the object, advancing that hostname's scripted status sequence one step.
 * - `GET ?hostname=` answers the list holding the match, or an empty list.
 * - `DELETE /{id}` removes it and answers `{id}`; an unknown id answers `404`.
 *
 * Bodies use the vendor's envelope, `{success, errors: [{code, message}], messages, result}`, and
 * the vendor's own state strings (`pending`, `active`, `pending_validation`, …), so the adapter's
 * R2 mapping is exercised rather than assumed. The status and code values are **verify** items
 * against the live API, as R2 says.
 *
 * Every request lands in `requests`, the `Authorization` header included, so a spec can assert
 * the token was sent and that it appears nowhere else. A wrong bearer token answers `403`.
 */
export interface FakeCloudflareRequest {
  readonly body: string;
  readonly headers: IncomingHttpHeaders;
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
}

/**
 * One answer of `GET /{id}`, in the vendor's vocabulary. Omitted fields keep their previous value;
 * a new registration starts at `pending` / `pending_validation` with no records or errors.
 */
export interface FakeHostnameStatus {
  /** The hostname's `status`: `pending`, `active`, `moved`, `blocked`, `deleted`, … */
  readonly status?: string;
  /** `ssl.status`: `initializing`, `pending_validation`, `active`, `validation_timed_out`, … */
  readonly ssl?: string;
  /** `ssl.validation_records`, as TXT pairs. */
  readonly validationRecords?: readonly { readonly txt_name: string; readonly txt_value: string }[];
  /** `verification_errors`: the vendor's messages about the hostname. */
  readonly verificationErrors?: readonly string[];
}

export interface FakeCustomHostname {
  readonly id: string;
  readonly hostname: string;
  /** The `ssl` object the adapter sent on `POST`, verbatim (`undefined` for a seeded one). */
  readonly sslRequested: unknown;
  status: string;
  ssl: string;
  validationRecords: readonly { readonly txt_name: string; readonly txt_value: string }[];
  verificationErrors: readonly string[];
}

/** A one-shot failure for the next request, whatever it is. */
export type FakeCloudflareFailure = 429 | 503 | 'hang';

export interface FakeCloudflare {
  /** `CLOUDFLARE_API_URL` for the adapter: `http://127.0.0.1:<port>/client/v4`. */
  readonly apiUrl: string;
  readonly apiToken: string;
  readonly zoneId: string;
  readonly requests: FakeCloudflareRequest[];
  /** Every live registration, by edge id. */
  readonly hostnames: Map<string, FakeCustomHostname>;
  /** The live registration for `hostname`, if any. */
  find(hostname: string): FakeCustomHostname | undefined;
  /**
   * A registration made outside this test's adapter — the adoption case (R9). Returns its id. Its
   * status is `pending` / `pending_validation` unless given.
   */
  seed(hostname: string, status?: FakeHostnameStatus): string;
  /**
   * The answers the next `GET /{id}` calls for `hostname` give, one per call, oldest first; the
   * last one repeats. Applies whether or not `hostname` is registered yet, and replaces any script
   * not yet consumed.
   */
  scriptStatus(hostname: string, steps: readonly FakeHostnameStatus[]): void;
  /** The next `POST` answers this `4xx` with `message`, once: an edge refusal (`EdgeRefused`). */
  refuseNext(status: number, message: string): void;
  /**
   * The next request, whatever it is, answers `429` or `503`, or is accepted and never answered
   * (`hang`; `close()` releases it). Once.
   */
  failNext(failure: FakeCloudflareFailure): void;
  close(): Promise<void>;
}

export interface FakeCloudflareOptions {
  readonly apiToken?: string;
  /** A fixed port, for a suite that must name the URL before the fake can be started. */
  readonly port?: number;
  readonly zoneId?: string;
}

const API_PREFIX = '/client/v4';
const DUPLICATE_CODE = 1406;

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function envelope(response: ServerResponse, status: number, result: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ errors: [], messages: [], result, success: true }));
}

function refusal(response: ServerResponse, status: number, code: number, message: string): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({ errors: [{ code, message }], messages: [], result: null, success: false }),
  );
}

function vendorObject(record: FakeCustomHostname) {
  return {
    created_at: '2026-01-01T00:00:00Z',
    hostname: record.hostname,
    id: record.id,
    ssl: {
      method: 'http',
      status: record.ssl,
      type: 'dv',
      validation_records: record.validationRecords,
    },
    status: record.status,
    verification_errors: record.verificationErrors,
  };
}

export async function startFakeCloudflare(
  options: FakeCloudflareOptions = {},
): Promise<FakeCloudflare> {
  const apiToken = options.apiToken ?? 'cf_fake_token';
  const zoneId = options.zoneId ?? 'zone-fake-0001';
  const requests: FakeCloudflareRequest[] = [];
  const hostnames = new Map<string, FakeCustomHostname>();
  const scripts = new Map<string, FakeHostnameStatus[]>();
  let failure: FakeCloudflareFailure | undefined;
  let refusalNext: { status: number; message: string } | undefined;

  const find = (hostname: string) =>
    [...hostnames.values()].find((record) => record.hostname === hostname);

  const apply = (record: FakeCustomHostname, step: FakeHostnameStatus) => {
    record.status = step.status ?? record.status;
    record.ssl = step.ssl ?? record.ssl;
    record.validationRecords = step.validationRecords ?? record.validationRecords;
    record.verificationErrors = step.verificationErrors ?? record.verificationErrors;
  };

  const register = (hostname: string, sslRequested: unknown): FakeCustomHostname => {
    const record: FakeCustomHostname = {
      hostname,
      id: randomUUID(),
      ssl: 'pending_validation',
      sslRequested,
      status: 'pending',
      validationRecords: [],
      verificationErrors: [],
    };
    hostnames.set(record.id, record);
    return record;
  };

  /** Advances `record`'s script one step; the last step stays for every later call. */
  const advance = (record: FakeCustomHostname) => {
    const steps = scripts.get(record.hostname);
    if (steps === undefined || steps.length === 0) return;
    apply(record, steps.length === 1 ? steps[0]! : steps.shift()!);
  };

  const collection = `${API_PREFIX}/zones/${zoneId}/custom_hostnames`;

  const route = (
    method: string,
    path: string,
    query: Record<string, string>,
    body: string,
    response: ServerResponse,
  ): void => {
    if (path === collection && method === 'POST') {
      if (refusalNext !== undefined) {
        const { status, message } = refusalNext;
        refusalNext = undefined;
        return refusal(response, status, 1400, message);
      }
      let parsed: { hostname?: unknown; ssl?: unknown };
      try {
        parsed = JSON.parse(body) as { hostname?: unknown; ssl?: unknown };
      } catch {
        return refusal(response, 400, 1400, 'Invalid JSON body.');
      }
      if (typeof parsed.hostname !== 'string' || parsed.hostname === '') {
        return refusal(response, 400, 1400, 'Hostname is required.');
      }
      if (find(parsed.hostname) !== undefined) {
        return refusal(response, 409, DUPLICATE_CODE, 'Duplicate custom hostname found.');
      }
      return envelope(response, 201, vendorObject(register(parsed.hostname, parsed.ssl)));
    }

    if (path === collection && method === 'GET') {
      const match = query.hostname === undefined ? undefined : find(query.hostname);
      const result = query.hostname === undefined ? [...hostnames.values()] : match ? [match] : [];
      return envelope(response, 200, result.map(vendorObject));
    }

    const id = path.startsWith(`${collection}/`) ? path.slice(collection.length + 1) : undefined;
    const record = id === undefined ? undefined : hostnames.get(id);
    if (id !== undefined && record === undefined && (method === 'GET' || method === 'DELETE')) {
      return refusal(response, 404, 1436, 'Custom hostname not found.');
    }
    if (record !== undefined && method === 'GET') {
      advance(record);
      return envelope(response, 200, vendorObject(record));
    }
    if (record !== undefined && method === 'DELETE') {
      hostnames.delete(record.id);
      return envelope(response, 200, { id: record.id });
    }

    return refusal(response, 404, 7003, `fake cloudflare: no route ${method} ${path}`);
  };

  const sockets = new Set<Socket>();

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const body = (await readBody(request)).toString('utf8');
    const query = Object.fromEntries(url.searchParams);
    const method = request.method ?? 'GET';
    requests.push({ body, headers: request.headers, method, path: url.pathname, query });

    if (failure !== undefined) {
      const once = failure;
      failure = undefined;
      if (once === 'hang') return; // never answered; `close()` destroys the socket
      return refusal(response, once, once === 429 ? 10429 : 10500, `fake cloudflare: ${once}`);
    }

    if (request.headers.authorization !== `Bearer ${apiToken}`) {
      return refusal(response, 403, 10000, 'Authentication error');
    }

    return route(method, url.pathname, query, body, response);
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    apiToken,
    apiUrl: `http://127.0.0.1:${port}${API_PREFIX}`,
    // Idempotent, as the Daytona fake's is.
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (!server.listening) return resolve();
        for (const socket of sockets) socket.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    failNext: (next) => {
      failure = next;
    },
    find,
    hostnames,
    refuseNext: (status, message) => {
      refusalNext = { message, status };
    },
    requests,
    scriptStatus: (hostname, steps) => {
      scripts.set(hostname, [...steps]);
    },
    seed: (hostname, status = {}) => {
      const record = register(hostname, undefined);
      apply(record, status);
      return record.id;
    },
    zoneId,
  };
}
