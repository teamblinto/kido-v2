import { type IncomingMessage, STATUS_CODES } from 'node:http';
import type { Duplex } from 'node:stream';

import { NOT_SERVING_PAGE, type Page } from './pages.ts';
import { dialTarget, inboundHeaders, outboundHeaders } from './proxy.ts';
import type { RouteRecord } from './route-verify.ts';

export interface UpgradeOptions {
  /** As `ProxyOptions.dialOrigin`: the address to dial when the upstream host does not resolve. */
  dialOrigin?: string;
  /** `GATEWAY_SOCKET_MAX_MS`: the piped socket is destroyed at this ceiling regardless (R13). */
  socketMaxMs: number;
}

const BAD_GATEWAY_PAGE: Page = { status: 502, body: '' };

/** Writes `page` as a whole HTTP/1.1 response on a raw (pre-upgrade) socket and closes it. */
export function refuseSocket(socket: Duplex, page: Page): void {
  if (!socket.writable) {
    return;
  }
  const headers = Object.entries({
    Connection: 'close',
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    ...page.headers,
    'Content-Length': String(Buffer.byteLength(page.body)),
  })
    .map(([name, value]) => `${name}: ${value}`)
    .join('\r\n');
  socket.end(
    `HTTP/1.1 ${String(page.status)} ${STATUS_CODES[page.status] ?? ''}\r\n${headers}\r\n\r\n${page.body}`,
  );
}

/**
 * Relays an `Upgrade` request to the verified route's sandbox and, once the upstream answers
 * 101, pipes the two sockets raw for the life of the connection. Everything read from `route`
 * is copied before the dial, so a later rotation (cache eviction, record invalidation) cannot
 * reach an established pipe: the socket drains rather than being torn down (R5).
 */
export function proxyUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  route: RouteRecord,
  opts: UpgradeOptions,
): void {
  const target = dialTarget(route, opts.dialOrigin);
  const visibility = route.visibility;
  // The shared sanitiser drops `Connection`/`Upgrade` as hop-by-hop; an upgrade is the one
  // exchange where this hop forwards them on purpose.
  const headers = outboundHeaders(req, route);
  headers.connection = 'Upgrade';
  headers.upgrade = req.headers.upgrade;

  const upstreamReq = target.request({
    headers,
    host: target.host,
    method: req.method,
    path: req.url,
    port: target.port,
    servername: target.servername,
  });

  upstreamReq.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'ECONNREFUSED') {
      refuseSocket(socket, NOT_SERVING_PAGE);
    } else {
      refuseSocket(socket, BAD_GATEWAY_PAGE);
    }
  });
  upstreamReq.on('response', (res) => {
    res.resume();
    refuseSocket(socket, BAD_GATEWAY_PAGE);
  });
  upstreamReq.on('upgrade', (res, upstreamSocket, upstreamHead) => {
    const clean = inboundHeaders(res.headers, visibility);
    if (clean === undefined) {
      upstreamSocket.destroy();
      refuseSocket(socket, BAD_GATEWAY_PAGE);
      return;
    }
    clean.connection = 'Upgrade';
    clean.upgrade = res.headers.upgrade;
    const lines = [`HTTP/1.1 ${res.statusCode} ${res.statusMessage ?? ''}`];
    for (const [name, value] of Object.entries(clean)) {
      for (const one of Array.isArray(value) ? value : [value]) {
        lines.push(`${name}: ${one}`);
      }
    }
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (upstreamHead.length) {
      socket.write(upstreamHead);
    }
    if (head.length) {
      upstreamSocket.write(head);
    }

    const teardown = () => {
      clearTimeout(cap);
      socket.destroy();
      upstreamSocket.destroy();
    };
    const cap = setTimeout(teardown, opts.socketMaxMs);
    socket.on('error', teardown).on('close', teardown);
    upstreamSocket.on('error', teardown).on('close', teardown);
    socket.pipe(upstreamSocket).pipe(socket);
  });

  // A client that leaves before the upstream answers takes the dial with it.
  socket.on('error', () => upstreamReq.destroy()).on('close', () => upstreamReq.destroy());
  upstreamReq.end();
}
