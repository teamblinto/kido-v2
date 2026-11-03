import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';

import { NOT_SERVING_PAGE, send } from './pages.ts';
import type { RouteRecord } from './route-verify.ts';

/** The grant cookie (contracts/preview.md § 4); never forwarded to a sandbox. */
export const GRANT_COOKIE = '__Host-preview_grant';

/**
 * Proxies in front of the gateway whose `X-Forwarded-*` entries are believed — the same
 * deployment-topology constant as the API's `TRUSTED_PROXY_HOPS` (apps/api/src/bootstrap.ts),
 * and a constant rather than a setting for the same reason (plan § Constitution Check).
 */
const TRUSTED_PROXY_HOPS = 1;

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Request headers that describe the hop and are ours to set, never the client's. */
const CLIENT_SUPPLIED_HOP = new Set([
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
]);

export interface ProxyOptions {
  /**
   * Address to dial instead of `route.upstream`'s host when that host does not resolve from the
   * gateway (research R19: `proxy.localhost` on Windows). `Host` is always the upstream's own.
   */
  dialOrigin?: string;
  upstreamTimeoutMs: number;
}

/** Splits an origin into what `http.request` dials; `servername` stays the upstream's own. */
export function dialTarget(route: RouteRecord, dialOrigin: string | undefined) {
  const upstream = new URL(route.upstream);
  const dial = new URL(dialOrigin ?? route.upstream);
  return {
    host: dial.hostname,
    port: dial.port || (dial.protocol === 'https:' ? 443 : 80),
    request: dial.protocol === 'https:' ? httpsRequest : httpRequest,
    servername: upstream.hostname,
    upstream,
  };
}

/**
 * Removes the fixed hop-by-hop set, every name the `Connection` header lists, and `X-Forge-*`
 * (contracts/preview.md § 5). Used on both directions.
 */
export function stripHopByHop(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const listed = new Set(
    String(headers.connection ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
  const out: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (
      value === undefined ||
      HOP_BY_HOP.has(name) ||
      listed.has(name) ||
      name.startsWith('x-forge-')
    ) {
      continue;
    }
    out[name] = value;
  }
  return out;
}

/** Rewrites a `Cookie` header with the grant cookie removed; `undefined` when nothing remains. */
export function stripGrantCookie(cookie: string): string | undefined {
  const kept = cookie
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => pair && !pair.startsWith(`${GRANT_COOKIE}=`));
  return kept.length > 0 ? kept.join('; ') : undefined;
}

/** The entry a trusted hop appended: N-th from the right, or `undefined` when there is none. */
function trustedEntry(value: string | string[] | undefined): string | undefined {
  const entries = (Array.isArray(value) ? value.join(',') : (value ?? ''))
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries[entries.length - TRUSTED_PROXY_HOPS];
}

/**
 * The header set that leaves for the sandbox (contracts/preview.md § 5): hop-by-hop, `X-Forge-*`
 * and every forwarded header dropped, `Host` set to the upstream's own, the provider token
 * attached, `X-Forwarded-*` set from the trusted hop or the connection (never appended to a
 * client-supplied value), the grant cookie removed.
 */
export function outboundHeaders(req: IncomingMessage, route: RouteRecord): IncomingHttpHeaders {
  const headers = stripHopByHop(req.headers);
  for (const name of CLIENT_SUPPLIED_HOP) {
    delete headers[name];
  }
  const socket = req.socket;
  headers.host = new URL(route.upstream).host;
  headers['x-daytona-preview-token'] = route.upstreamToken;
  headers['x-forwarded-for'] =
    trustedEntry(req.headers['x-forwarded-for']) ?? socket.remoteAddress ?? '';
  headers['x-forwarded-proto'] =
    trustedEntry(req.headers['x-forwarded-proto']) ??
    ('encrypted' in socket && socket.encrypted ? 'https' : 'http');
  headers['x-forwarded-host'] = req.headers.host ?? '';
  const cookie = headers.cookie === undefined ? undefined : stripGrantCookie(headers.cookie);
  if (cookie === undefined) {
    delete headers.cookie;
  } else {
    headers.cookie = cookie;
  }
  return headers;
}

/**
 * Daytona's proxy pins `daytona-sandbox-auth-<token>; Domain=<upstream host>` to every response
 * through a signed origin (T052, v0.189.0). It is provider plumbing carrying the upstream token:
 * stripped here, never relayed, never a reason to refuse. `undefined` when nothing remains.
 */
function withoutProviderCookies(setCookie: string | string[] | undefined): string[] | undefined {
  const kept = [setCookie ?? []]
    .flat()
    .filter((value) => !value.trim().toLowerCase().startsWith('daytona-sandbox-auth-'));
  return kept.length === 0 ? undefined : kept;
}

/** A `Set-Cookie` that widens scope with `Domain`, or that names the grant cookie itself. */
export function setCookieWidensDomain(setCookie: string | string[] | undefined): boolean {
  const values = setCookie === undefined ? [] : Array.isArray(setCookie) ? setCookie : [setCookie];
  return values.some((value) => {
    const [pair = '', ...attributes] = value.split(';');
    if (pair.trim().startsWith(`${GRANT_COOKIE}=`)) {
      return true;
    }
    return attributes.some((attribute) => {
      const a = attribute.trim().toLowerCase();
      return a === 'domain' || a.startsWith('domain=');
    });
  });
}

/**
 * The header set relayed from the sandbox (contracts/preview.md § 5), or `undefined` when the
 * whole response must be refused with `502`. Hop-by-hop and `X-Forge-*` stripped, the provider
 * token never echoed back, `X-Robots-Tag: noindex` on public previews.
 */
export function inboundHeaders(
  headers: IncomingHttpHeaders,
  visibility: RouteRecord['visibility'],
): IncomingHttpHeaders | undefined {
  const setCookie = withoutProviderCookies(headers['set-cookie']);
  if (setCookieWidensDomain(setCookie)) {
    return undefined;
  }
  const clean = stripHopByHop(headers);
  delete clean['x-daytona-preview-token'];
  if (setCookie === undefined) {
    delete clean['set-cookie'];
  } else {
    clean['set-cookie'] = setCookie;
  }
  if (visibility === 'public') {
    clean['x-robots-tag'] = 'noindex';
  }
  return clean;
}

function fail(res: ServerResponse, status: number, body: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

/**
 * Proxies one already-authorised request to the route's upstream (contracts/preview.md § 5).
 * Every check that decides whether to dial at all (verify, port, grant) happens before this.
 */
export function proxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  route: RouteRecord,
  opts: ProxyOptions,
): Promise<void> {
  const target = dialTarget(route, opts.dialOrigin);

  return new Promise((resolve) => {
    const outbound = target.request(
      {
        headers: outboundHeaders(req, route),
        host: target.host,
        method: req.method,
        path: req.url,
        port: target.port,
        servername: target.servername,
        // Socket inactivity, not wall clock: it bounds the wait for headers and any stall
        // mid-body, while a body that keeps trickling is allowed to finish (R13).
        timeout: opts.upstreamTimeoutMs,
      },
      (inbound) => {
        const clean = inboundHeaders(inbound.headers, route.visibility);
        if (clean === undefined) {
          inbound.resume();
          fail(res, 502, 'Bad gateway');
          return;
        }
        // A parsed response always carries a status line.
        res.writeHead(inbound.statusCode!, clean);
        inbound.pipe(res);
      },
    );

    outbound.on('timeout', () =>
      outbound.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })),
    );
    outbound.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED') {
        // A refused connect precedes any response byte: nothing has been sent yet.
        send(res, NOT_SERVING_PAGE);
      } else if (error.code === 'ETIMEDOUT') {
        fail(res, 504, 'Gateway timeout');
      } else {
        fail(res, 502, 'Bad gateway');
      }
    });
    res.on('close', () => {
      outbound.destroy();
      resolve();
    });

    req.pipe(outbound);
  });
}
