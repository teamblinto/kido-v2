import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { z } from 'zod';

import type { Environment } from '../../config/environment';
import { DomainRouteService } from '../deploy/domains/domain-route.service';
import { SiteRouteService } from '../deploy/site-route.service';
import { GrantService } from './grant.service';
import { BROKER_TRANSPORT, ROUTE_SIGNER } from './preview.constants';
import { RouteBrokerService } from './route-broker.service';
import type { RouteSigner } from './route-signer';

/** One broker request, already authenticated by the transport; the body is raw JSON, parsed per path. */
export interface BrokerRequest {
  readonly body: string;
  /** Lower-cased names; only the two `x-preview-*` headers are read. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly method: string;
  readonly path: string;
}

/** `body` is serialised as JSON; the wire carries nothing else (contract § 3). */
export interface BrokerAnswer {
  readonly body: unknown;
  readonly status: number;
}

export type BrokerHandler = (request: BrokerRequest) => Promise<BrokerAnswer>;

export interface Closeable {
  /** The bound address: `HOST` for mTLS, always loopback for plain. */
  readonly address: string;
  close(): Promise<void>;
  /** The bound port — `BROKER_PORT`, or the free one a suite asked for with `0`. */
  readonly port: number;
}

/** Contract § 7: one method. The transport authenticates the peer; the handler never sees who it was. */
export interface BrokerTransport {
  serve(handler: BrokerHandler): Promise<Closeable>;
}

const BODY_CAP_BYTES = 16 * 1024;

/** A body that is not JSON is `undefined`, which the schema then refuses like any other shape. */
function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}
const logger = new Logger('BrokerListener');

/** A header sent twice names nothing. */
const single = (value: string | string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

/** The one place a Node server is bound and answered: both transports share it. */
async function listen(
  server: Server,
  port: number,
  host: string,
  authorised: (request: IncomingMessage) => boolean,
  handler: BrokerHandler,
): Promise<Closeable> {
  server.on('request', (request, response) => {
    void answer(request, response, authorised, handler);
  });
  // A client certificate the CA does not vouch for fails the handshake before `request` fires;
  // noted at debug so the peer is not an unhandled `error` on the server and not silent either.
  server.on('tlsClientError', (error: Error) => {
    logger.debug(`broker handshake refused: ${error.message}`);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const { address, port: bound } = server.address() as AddressInfo;
  return {
    address,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    port: bound,
  };
}

async function answer(
  request: IncomingMessage,
  response: ServerResponse,
  authorised: (request: IncomingMessage) => boolean,
  handler: BrokerHandler,
): Promise<void> {
  // Refused peers get the same empty `404` as an unknown path: nothing on this listener tells a
  // caller whether it exists (contract § 3).
  if (!authorised(request)) {
    response.writeHead(404, { 'content-type': 'application/json' }).end('{}');
    return;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > BODY_CAP_BYTES) {
      response.writeHead(413).end();
      return;
    }
    chunks.push(chunk as Buffer);
  }

  let answered: BrokerAnswer;
  try {
    answered = await handler({
      body: Buffer.concat(chunks).toString('utf8'),
      headers: {
        'x-preview-grant': single(request.headers['x-preview-grant']),
        'x-preview-host': single(request.headers['x-preview-host']),
      },
      method: request.method ?? 'GET',
      path: (request.url ?? '/').split('?')[0] ?? '/',
    });
  } catch (error) {
    // The handler's failure is logged by whoever owns it; the wire gets a bare 500, no reason.
    logger.error(error instanceof Error ? error.message : String(error));
    answered = { body: {}, status: 500 };
  }

  response
    .writeHead(answered.status, { 'content-type': 'application/json' })
    .end(JSON.stringify(answered.body));
}

/**
 * The real link (research R4): `node:https` with `requestCert: true, rejectUnauthorized: true`
 * against `BROKER_TLS_CA`, so a peer without a certificate the CA signed never completes the
 * handshake, and the peer's CN checked against `BROKER_CLIENT_CNS` on every request after it did.
 */
export class MtlsBrokerTransport implements BrokerTransport {
  constructor(
    private readonly options: {
      readonly ca: string;
      readonly cert: string;
      readonly clientCns: readonly string[];
      readonly host: string;
      readonly key: string;
      readonly port: number;
    },
  ) {}

  serve(handler: BrokerHandler): Promise<Closeable> {
    const { ca, cert, clientCns, host, key, port } = this.options;
    const server = createHttpsServer({
      ca,
      cert,
      key,
      rejectUnauthorized: true,
      requestCert: true,
    });
    const allowed = new Set(clientCns);
    return listen(
      server,
      port,
      host,
      (request) => {
        const socket = request.socket as TLSSocket;
        // Node types `CN` as `string | string[]`; a multi-valued CN names nobody on the allowlist.
        const cn = socket.getPeerCertificate().subject?.CN;
        return socket.authorized && typeof cn === 'string' && allowed.has(cn);
      },
      handler,
    );
  }
}

/** Where the plain transport binds, whatever `HOST` says: the secret never leaves this machine. */
export const PLAIN_BROKER_HOST = '127.0.0.1';

/**
 * The `local`-only link: `node:http` behind an `x-broker-secret` header compared in constant
 * time. A bearer token that resolves any label is a tenant-wide credential, which is why the
 * constructor refuses to exist off `local` — the environment schema refuses the same thing for the
 * configured path (R4), and a container built by a test or a script reaches none of that — and
 * why it binds loopback regardless of `HOST`: the API's `0.0.0.0` must not put the secret on the LAN.
 */
export class PlainBrokerTransport implements BrokerTransport {
  private readonly secret: Buffer;

  constructor(
    private readonly options: {
      readonly port: number;
      readonly secret: string;
    },
    deployEnv: Environment['DEPLOY_ENV'],
  ) {
    if (deployEnv !== 'local') {
      throw new Error(
        `BROKER_TRANSPORT=plain is local-only; DEPLOY_ENV=${deployEnv} needs the mtls transport (spec 017 R4).`,
      );
    }
    this.secret = Buffer.from(options.secret);
  }

  serve(handler: BrokerHandler): Promise<Closeable> {
    return listen(
      createHttpServer(),
      this.options.port,
      PLAIN_BROKER_HOST,
      (request) => {
        const presented = Buffer.from(String(request.headers['x-broker-secret'] ?? ''));
        return presented.length === this.secret.length && timingSafeEqual(presented, this.secret);
      },
      handler,
    );
  }
}

/** Picks the transport the environment names; the schema already made the values all-or-none. */
export function brokerTransportFor(config: ConfigService<Environment, true>): BrokerTransport {
  const host = config.get('HOST', { infer: true });
  const port = config.get('BROKER_PORT', { infer: true });

  if (config.get('BROKER_TRANSPORT', { infer: true }) === 'mtls') {
    const ca = config.get('BROKER_TLS_CA', { infer: true });
    const cert = config.get('BROKER_TLS_CERT', { infer: true });
    const key = config.get('BROKER_TLS_KEY', { infer: true });
    const clientCns = config.get('BROKER_CLIENT_CNS', { infer: true });
    if (ca === undefined || cert === undefined || key === undefined || clientCns === undefined) {
      throw new Error(
        'BROKER_TLS_CA, BROKER_TLS_CERT, BROKER_TLS_KEY and BROKER_CLIENT_CNS are required for the mtls transport.',
      );
    }
    return new MtlsBrokerTransport({ ca, cert, clientCns, host, key, port });
  }

  const secret = config.get('BROKER_SHARED_SECRET', { infer: true });
  if (secret === undefined) {
    throw new Error('BROKER_SHARED_SECRET is required for the plain transport.');
  }
  return new PlainBrokerTransport({ port, secret }, config.get('DEPLOY_ENV', { infer: true }));
}

const ROUTE_PATH = /^\/broker\/routes\/([^/]+)$/;
const SITE_PATH = /^\/broker\/sites\/([^/]+)$/;
const DOMAIN_PATH = /^\/broker\/domains\/([^/]+)$/;
const GRANT_PATH = '/broker/grants';

/** A path segment the gateway URI-encoded; one that does not decode names nothing. */
function decodeSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/** `POST /broker/grants` (contract § 3): `{ code, host }` as `broker-client.ts` sends it. */
const grantBodySchema = z.object({ code: z.string(), host: z.string() });

/**
 * The broker paths, hand-routed (contract § 3): `GET /broker/routes/:label` to the route broker,
 * `GET /broker/sites/:label` to `deploy`'s `SiteRouteService` and the signer (spec 027,
 * contract site-serving.md § 2), `GET /broker/domains/:hostname` to `deploy`'s `DomainRouteService`
 * and the signer (spec 028, contract domain-serving.md § 2), `POST /broker/grants` to the grant service. Every refusal is `404 {}` with no reason — the gateway
 * has nothing to do with the difference and a body would be a probe oracle. Bound by `main.ts` as
 * a second listener beside the Nest one, never `NestFactory.create({ httpsOptions })` (R4), and
 * closed with the application.
 */
@Injectable()
export class BrokerListener implements OnApplicationShutdown {
  private readonly logger = new Logger(BrokerListener.name);
  private listening: Closeable | undefined;

  constructor(
    @Inject(BROKER_TRANSPORT) private readonly transport: BrokerTransport,
    @Inject(RouteBrokerService) private readonly routes: RouteBrokerService,
    @Inject(GrantService) private readonly grants: GrantService,
    @Inject(SiteRouteService) private readonly sites: SiteRouteService,
    @Inject(ROUTE_SIGNER) private readonly signer: RouteSigner,
    @Inject(DomainRouteService) private readonly domains: DomainRouteService,
  ) {}

  async listen(): Promise<void> {
    this.listening ??= await this.transport.serve((request) => this.handle(request));
  }

  /** The bound port while listening; `undefined` before `listen()` and after shutdown. */
  get port(): number | undefined {
    return this.listening?.port;
  }

  /** The bound address while listening, for the boot log and the suite that checks it. */
  get address(): string | undefined {
    return this.listening?.address;
  }

  async onApplicationShutdown(): Promise<void> {
    const { listening } = this;
    this.listening = undefined;
    await listening?.close();
  }

  async handle(request: BrokerRequest): Promise<BrokerAnswer> {
    const label = ROUTE_PATH.exec(request.path)?.[1];
    if (request.method === 'GET' && label !== undefined) {
      const answer = await this.routes.resolve(label, {
        grant: request.headers['x-preview-grant'],
        host: request.headers['x-preview-host'],
      });
      if (answer.kind === 'route') return { body: { route: answer.route }, status: 200 };
      // Contract § 3: a resume was triggered, so the gateway renders the waking page.
      if (answer.because === 'resuming') return { body: { waking: true }, status: 202 };
      // A cold non-public preview asked for without a grant: nothing woken, the gateway bounces.
      if (answer.because === 'unauthorised') return { body: {}, status: 401 };
      // The label is caller-supplied and is the secret half of a private preview's address: a
      // prefix is enough to correlate a log line, and never enough to visit.
      this.logger.log(`route refused: label=${label.slice(0, 8)}… because=${answer.because}`);
      return { body: {}, status: 404 };
    }

    const siteLabel = SITE_PATH.exec(request.path)?.[1];
    if (request.method === 'GET' && siteLabel !== undefined) {
      const site = await this.sites.resolve(siteLabel);
      if (site !== undefined) {
        return {
          body: { site: await this.signer.signSite({ ...site, kind: 'site', label: siteLabel }) },
          status: 200,
        };
      }
      // A site label is a public host name, unlike a preview's; bounded because it is caller-supplied.
      this.logger.log(`site refused: label=${siteLabel.slice(0, 63)}`);
      return { body: {}, status: 404 };
    }

    const domainSegment = DOMAIN_PATH.exec(request.path)?.[1];
    if (request.method === 'GET' && domainSegment !== undefined) {
      const hostname = decodeSegment(domainSegment);
      const domain = hostname === undefined ? undefined : await this.domains.resolve(hostname);
      if (hostname !== undefined && domain !== undefined) {
        return {
          body: { domain: await this.signer.signDomain({ ...domain, hostname, kind: 'domain' }) },
          status: 200,
        };
      }
      // A custom hostname is a public host name; bounded because it is caller-supplied.
      this.logger.log(`domain refused: hostname=${domainSegment.slice(0, 253)}`);
      return { body: {}, status: 404 };
    }

    if (request.method === 'POST' && request.path === GRANT_PATH) {
      const body = grantBodySchema.safeParse(parseJson(request.body));
      const grant = body.success
        ? await this.grants.redeem(body.data.code, body.data.host)
        : undefined;
      if (grant !== undefined) return { body: { grant }, status: 200 };
      // The host is caller-supplied: bounded before it reaches a log line.
      this.logger.log(`grant refused: host=${body.success ? body.data.host.slice(0, 128) : '?'}`);
      return { body: {}, status: 404 };
    }

    return { body: {}, status: 404 };
  }
}
