import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

import { buildEvents, type ScriptedReply } from './fake-anthropic';

/**
 * A loopback double of a subscription provider (spec 032 research R16), in the `fake-anthropic.ts`
 * shape: one `node:http` listener, controls, and logs. It is the sheet-shaped contract every
 * automated BYOS path runs against — never a real provider:
 *
 * - `GET /authorize` — RFC 6749 code grant with RFC 7636 PKCE S256; `deny()` answers
 *   `error=access_denied` instead;
 * - `POST /token` — `authorization_code`, `refresh_token` and the RFC 8628 device grant. Refresh
 *   **rotates**: each refresh issues a new refresh token and invalidates the old one, and redeeming
 *   an old one answers `400 invalid_grant` and revokes the whole family (reuse detection);
 * - `POST /revoke` — RFC 7009;
 * - `POST /device` — the device authorisation request; polling answers `authorization_pending`
 *   until `approveDevice()`;
 * - model calls under `/api` (the `apiBaseURL`) that accept only `Authorization: Bearer`:
 *   `…/models` answers a list, `…/messages` a scripted-free Anthropic SSE reply.
 */
export interface FakeByosProvider {
  readonly clientId: string;
  readonly baseURL: string;
  readonly authorizeURL: string;
  readonly tokenURL: string;
  readonly revokeURL: string;
  readonly deviceURL: string;
  readonly apiBaseURL: string;
  /** The account the next authorisation (or device approval) signs in as. */
  signInAs(email: string): void;
  /** The next authorisation is refused with `access_denied`. */
  deny(): void;
  approveDevice(): void;
  /** Revokes every grant of `user` (the provider-side "disconnect this app"). */
  revoke(user: string): void;
  /** Model calls answer 429 until cleared; `resetInSeconds` rides as `retry-after`. */
  rateLimit(options?: { resetInSeconds?: number } | false): void;
  setAccessLifetime(seconds: number): void;
  /**
   * Queues the next authorised `…/messages` answers, FIFO: a scripted reply, or `hang` (headers
   * flushed, body never written) for a cancel mid-stream, or `wait` (the reply, default "ok",
   * written once the promise settles) to hold a run mid-call. With none queued the reply is "ok".
   */
  script(...next: readonly Scripted[]): void;
  refreshCount(): number;
  /** The bearer token each model call carried, `null` when none. */
  callLog(): readonly (string | null)[];
  /** Tokens received on `/revoke`, in order. */
  revocations(): readonly string[];
  /**
   * Every secret byte string the double has issued or been shown: codes, verifiers, device codes,
   * access and refresh tokens. The redaction sweep (T061) asserts none of them reaches a sink.
   */
  secrets(): readonly string[];
  start(): Promise<void>;
  close(): Promise<void>;
}

type Scripted =
  | ScriptedReply
  | { readonly hang: true }
  | { readonly wait: Promise<void>; readonly reply?: ScriptedReply };

const OK: ScriptedReply = {
  stopReason: 'end_turn',
  text: 'ok',
  usage: { inputTokens: 1, outputTokens: 1 },
};

interface Family {
  readonly user: string;
  refresh: string;
  readonly retired: Set<string>;
  revoked: boolean;
}

interface Code {
  readonly challenge: string;
  readonly redirectUri: string;
  readonly user: string;
}

const issued: string[] = [];
const token = (prefix: string) => {
  const value = `${prefix}_${randomBytes(24).toString('base64url')}`;
  issued.push(value);
  return value;
};

function idToken(email: string): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none', typ: 'JWT' })}.${part({ email, sub: email })}.`;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function json(response: ServerResponse, status: number, body: unknown, headers = {}): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

export function startFakeByosProvider(
  options: { clientId?: string; port?: number } = {},
): FakeByosProvider {
  const clientId = options.clientId ?? 'fake-byos-client';
  const sockets = new Set<Socket>();
  const codes = new Map<string, Code>();
  const families = new Set<Family>();
  const access = new Map<string, { family: Family; expiresAt: number }>();
  const devices = new Map<string, { approved: boolean }>();
  const calls: (string | null)[] = [];
  const revoked: string[] = [];
  let user = 'ada@example.com';
  let denyNext = false;
  let limited: { resetInSeconds?: number } | false = false;
  let lifetime = 3600;
  let refreshes = 0;
  const scripts: Scripted[] = [];

  function issue(family: Family) {
    const accessToken = token('fake_at');
    access.set(accessToken, { family, expiresAt: Date.now() + lifetime * 1000 });
    return {
      access_token: accessToken,
      expires_in: lifetime,
      id_token: idToken(family.user),
      refresh_token: family.refresh,
      scope: 'user:inference',
      token_type: 'Bearer',
    };
  }

  function newFamily(owner: string): Family {
    const family: Family = {
      user: owner,
      refresh: token('fake_rt'),
      retired: new Set(),
      revoked: false,
    };
    families.add(family);
    return family;
  }

  function revokeFamily(family: Family): void {
    family.revoked = true;
  }

  function onToken(fields: URLSearchParams, response: ServerResponse): void {
    const grant = fields.get('grant_type');
    const invalid = () => json(response, 400, { error: 'invalid_grant' });

    if (grant === 'authorization_code') {
      const code = codes.get(fields.get('code') ?? '');
      codes.delete(fields.get('code') ?? '');
      const verifier = fields.get('code_verifier') ?? '';
      if (verifier !== '') issued.push(verifier);
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (code?.challenge !== challenge || code.redirectUri !== fields.get('redirect_uri')) {
        return invalid();
      }
      return json(response, 200, issue(newFamily(code.user)));
    }

    if (grant === 'refresh_token') {
      const presented = fields.get('refresh_token') ?? '';
      for (const family of families) {
        if (family.retired.has(presented)) {
          revokeFamily(family);
          return invalid();
        }
        if (family.refresh === presented) {
          if (family.revoked) return invalid();
          refreshes += 1;
          family.retired.add(family.refresh);
          family.refresh = token('fake_rt');
          return json(response, 200, issue(family));
        }
      }
      return invalid();
    }

    if (grant === 'urn:ietf:params:oauth:grant-type:device_code') {
      const device = devices.get(fields.get('device_code') ?? '');
      if (device === undefined) return json(response, 400, { error: 'expired_token' });
      if (!device.approved) return json(response, 400, { error: 'authorization_pending' });
      devices.delete(fields.get('device_code') ?? '');
      return json(response, 200, issue(newFamily(user)));
    }

    return json(response, 400, { error: 'unsupported_grant_type' });
  }

  function onModel(request: IncomingMessage, path: string, response: ServerResponse): void {
    const header = request.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
    calls.push(bearer);
    const live = bearer === null ? undefined : access.get(bearer);
    if (live === undefined || live.family.revoked || live.expiresAt <= Date.now()) {
      return json(response, 401, {
        type: 'error',
        error: { type: 'authentication_error', message: 'invalid bearer' },
      });
    }
    if (limited !== false) {
      return json(
        response,
        429,
        { type: 'error', error: { type: 'rate_limit_error', message: 'limited' } },
        limited.resetInSeconds === undefined
          ? {}
          : { 'retry-after': String(limited.resetInSeconds) },
      );
    }
    if (path.endsWith('/models')) {
      return json(response, 200, {
        data: [{ id: 'claude-fake', type: 'model' }],
        has_more: false,
        object: 'list',
      });
    }
    if (path.endsWith('/messages')) {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const next = scripts.shift() ?? OK;
      if ('hang' in next) {
        response.flushHeaders();
        return;
      }
      const write = (reply: ScriptedReply) => {
        for (const event of buildEvents(reply)) {
          response.write(event);
        }
        response.end();
      };
      if ('wait' in next) {
        response.flushHeaders();
        void next.wait.then(() => write(next.reply ?? OK));
        return;
      }
      write(next);
      return;
    }
    json(response, 404, { error: 'not_found' });
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const body = await readBody(request);
    const fields = new URLSearchParams(body);

    if (request.method === 'GET' && url.pathname === '/authorize') {
      const query = url.searchParams;
      const back = new URL(query.get('redirect_uri') ?? 'http://invalid.local/');
      back.searchParams.set('state', query.get('state') ?? '');
      if (denyNext) {
        denyNext = false;
        back.searchParams.set('error', 'access_denied');
      } else if (
        query.get('client_id') !== clientId ||
        query.get('code_challenge_method') !== 'S256' ||
        !query.get('code_challenge')
      ) {
        back.searchParams.set('error', 'invalid_request');
      } else {
        const code = token('fake_code');
        codes.set(code, {
          challenge: query.get('code_challenge')!,
          redirectUri: query.get('redirect_uri')!,
          user,
        });
        back.searchParams.set('code', code);
      }
      response.writeHead(302, { location: back.toString() });
      response.end();
      return;
    }
    if (request.method === 'POST' && url.pathname === '/token') return onToken(fields, response);
    if (request.method === 'POST' && url.pathname === '/revoke') {
      const presented = fields.get('token') ?? '';
      revoked.push(presented);
      for (const family of families) {
        if (family.refresh === presented || family.retired.has(presented)) revokeFamily(family);
      }
      const live = access.get(presented);
      if (live !== undefined) revokeFamily(live.family);
      response.writeHead(200);
      response.end();
      return;
    }
    if (request.method === 'POST' && url.pathname === '/device') {
      const deviceCode = token('fake_dc');
      devices.set(deviceCode, { approved: false });
      return json(response, 200, {
        device_code: deviceCode,
        expires_in: 600,
        interval: 5,
        user_code: 'WDJB-MJHT',
        verification_uri: `${address()}/activate`,
      });
    }
    if (url.pathname.startsWith('/api/')) return onModel(request, url.pathname, response);
    json(response, 404, { error: 'not_found' });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  function address(): string {
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  return {
    clientId,
    get baseURL() {
      return address();
    },
    get authorizeURL() {
      return `${address()}/authorize`;
    },
    get tokenURL() {
      return `${address()}/token`;
    },
    get revokeURL() {
      return `${address()}/revoke`;
    },
    get deviceURL() {
      return `${address()}/device`;
    },
    get apiBaseURL() {
      return `${address()}/api`;
    },
    signInAs: (email) => {
      user = email;
    },
    deny: () => {
      denyNext = true;
    },
    approveDevice: () => {
      for (const device of devices.values()) device.approved = true;
    },
    revoke: (owner) => {
      for (const family of families) if (family.user === owner) revokeFamily(family);
    },
    rateLimit: (next = {}) => {
      limited = next;
    },
    setAccessLifetime: (seconds) => {
      lifetime = seconds;
    },
    script: (...next) => {
      scripts.push(...next);
    },
    refreshCount: () => refreshes,
    callLog: () => [...calls],
    revocations: () => [...revoked],
    secrets: () => [...issued],
    start: () =>
      new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve)),
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (!server.listening) return resolve();
        for (const socket of sockets) socket.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
