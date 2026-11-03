import { request as httpRequest } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';

import type { RouteCache } from './route-cache.ts';
import type { DomainRecord, RouteRecord, SiteRecord } from './route-verify.ts';

/**
 * The gateway's side of the broker protocol (contract § 3): `GET /broker/routes/:label` and
 * `POST /broker/grants`, over mTLS or, in `local`, plain HTTP behind `x-broker-secret`. Every
 * network failure is a `retryable` result, never a throw, so a broker outage is a `503` upstream
 * and cached routes keep serving (research R4/R5).
 */
export type BrokerRouteResult =
  | { kind: 'route'; route: RouteRecord }
  | { kind: 'refused' }
  | { kind: 'waking' }
  | { kind: 'unauthorised' }
  | { kind: 'retryable'; reason: string };

/** Who is asking (fix round 1): the bare preview hostname always, the visitor's grant JWS if any. */
export interface RouteRequestContext {
  grant?: string;
  host: string;
}

/** `GET /broker/sites/:label` (contracts/site-serving.md § 2): live, or one `404` for the rest. */
export type BrokerSiteResult =
  { kind: 'site'; site: SiteRecord } | { kind: 'refused' } | { kind: 'retryable'; reason: string };

/** `GET /broker/domains/:hostname` (contracts/domain-serving.md § 2): live, or one `404`. */
export type BrokerDomainResult =
  | { kind: 'domain'; domain: DomainRecord }
  | { kind: 'refused' }
  | { kind: 'retryable'; reason: string };

export type BrokerGrantResult =
  { kind: 'grant'; grant: string } | { kind: 'refused' } | { kind: 'retryable'; reason: string };

export type BrokerClientOptions = {
  cache: RouteCache;
  /** `https://broker:3001` for mtls, `http://…` for plain; no trailing slash. */
  origin: string;
  timeoutMs?: number;
  verify: (jws: string) => Promise<RouteRecord | undefined>;
  /** Custom domains (spec 028); absent unless configured, where every domain is refused. */
  verifyDomain?: (jws: string, hostname: string) => Promise<DomainRecord | undefined>;
  /** Site records (spec 027); absent on a preview-only gateway, where every site is refused. */
  verifySite?: (jws: string) => Promise<SiteRecord | undefined>;
} & (
  | { sharedSecret: string; transport: 'plain' }
  | { tls: { ca: string; cert: string; key: string }; transport: 'mtls' }
);

export interface BrokerClient {
  getDomain: (hostname: string) => Promise<BrokerDomainResult>;
  getRoute: (label: string, ctx: RouteRequestContext) => Promise<BrokerRouteResult>;
  getSite: (label: string) => Promise<BrokerSiteResult>;
  redeemGrant: (input: { code: string; host: string }) => Promise<BrokerGrantResult>;
}

type Answer = { ok: true; body: unknown; status: number } | { ok: false; reason: string };

export function createBrokerClient(options: BrokerClientOptions): BrokerClient {
  const { cache, origin, verify, verifyDomain, verifySite } = options;
  const timeoutMs = options.timeoutMs ?? 5000;
  const url = new URL(origin);
  const send = options.transport === 'mtls' ? httpsRequest : httpRequest;
  const base: RequestOptions =
    options.transport === 'mtls'
      ? { ...options.tls, host: url.hostname, port: url.port, rejectUnauthorized: true }
      : {
          headers: { 'x-broker-secret': options.sharedSecret },
          host: url.hostname,
          port: url.port,
        };

  function call(
    method: 'GET' | 'POST',
    path: string,
    body?: string,
    extra: Record<string, string> = {},
  ): Promise<Answer> {
    return new Promise((resolve) => {
      const headers = {
        ...base.headers,
        ...extra,
        ...(body === undefined
          ? {}
          : { 'content-length': Buffer.byteLength(body), 'content-type': 'application/json' }),
      };
      const req = send({ ...base, headers, method, path, timeout: timeoutMs }, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          raw += chunk;
        });
        res.on('error', (error: Error) => resolve({ ok: false, reason: error.message }));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          // Only a `200` carries a body worth reading; `404` and `202` are answers whatever they
          // carry (contract § 3), so a malformed refusal never turns into a retryable outage.
          if (status !== 200) {
            resolve({ body: undefined, ok: true, status });
            return;
          }
          try {
            resolve({ body: JSON.parse(raw) as unknown, ok: true, status });
          } catch {
            resolve({ ok: false, reason: `broker sent a non-JSON body (${String(status)})` });
          }
        });
      });
      req.on('timeout', () => req.destroy(new Error('broker timed out')));
      req.on('error', (error: Error) => resolve({ ok: false, reason: error.message }));
      req.end(body);
    });
  }

  function field(answer: Answer, name: string): string | undefined {
    const value =
      answer.ok && typeof answer.body === 'object' && answer.body !== null
        ? (answer.body as Record<string, unknown>)[name]
        : undefined;
    return typeof value === 'string' ? value : undefined;
  }

  return {
    async getRoute(label, ctx) {
      const cached = cache.get(label);
      // Only a preview record (no `kind`) serves as a route, whatever sits under the key.
      if (cached !== undefined && cached.kind === undefined) {
        return { kind: 'route', route: cached };
      }
      // The broker gates the resume on entitlement (US4 AC-6): it sees the host and, when the
      // visitor carries one, the grant. The gateway forwards the cookie unverified — the broker
      // verifies it — and still verifies locally before serving (pipeline `checkGrant`).
      const answer = await call('GET', `/broker/routes/${encodeURIComponent(label)}`, undefined, {
        'x-preview-host': ctx.host,
        ...(ctx.grant === undefined ? {} : { 'x-preview-grant': ctx.grant }),
      });
      if (!answer.ok) {
        return { kind: 'retryable', reason: answer.reason };
      }
      if (answer.status === 404) {
        return { kind: 'refused' };
      }
      if (answer.status === 401) {
        return { kind: 'unauthorised' };
      }
      if (answer.status === 202) {
        return { kind: 'waking' };
      }
      const jws = field(answer, 'route');
      if (answer.status !== 200 || jws === undefined) {
        return { kind: 'retryable', reason: `broker answered ${String(answer.status)}` };
      }
      const route = await verify(jws);
      if (route?.label !== label) {
        return { kind: 'refused' };
      }
      cache.set(route);
      return { kind: 'route', route };
    },

    async getSite(label) {
      if (verifySite === undefined) {
        return { kind: 'refused' };
      }
      const key = `site:${label}`;
      const cached = cache.get(key);
      if (cached !== undefined) {
        // Only `getSite` writes `site:` keys; a preview record there would be a bug, not a site.
        return cached.kind === 'site' ? { kind: 'site', site: cached } : { kind: 'refused' };
      }
      const answer = await call('GET', `/broker/sites/${encodeURIComponent(label)}`);
      if (!answer.ok) {
        return { kind: 'retryable', reason: answer.reason };
      }
      if (answer.status === 404) {
        return { kind: 'refused' };
      }
      const jws = field(answer, 'site');
      if (answer.status !== 200 || jws === undefined) {
        return { kind: 'retryable', reason: `broker answered ${String(answer.status)}` };
      }
      const site = await verifySite(jws);
      if (site?.label !== label) {
        return { kind: 'refused' };
      }
      cache.set(site, key);
      return { kind: 'site', site };
    },

    async getDomain(hostname) {
      if (verifyDomain === undefined) {
        return { kind: 'refused' };
      }
      const key = `domain:${hostname}`;
      const cached = cache.get(key);
      if (cached !== undefined) {
        // Only `getDomain` writes `domain:` keys, and only for a record bound to that hostname.
        return cached.kind === 'domain' && cached.hostname === hostname
          ? { domain: cached, kind: 'domain' }
          : { kind: 'refused' };
      }
      const answer = await call('GET', `/broker/domains/${encodeURIComponent(hostname)}`);
      if (!answer.ok) {
        return { kind: 'retryable', reason: answer.reason };
      }
      if (answer.status === 404) {
        return { kind: 'refused' };
      }
      const jws = field(answer, 'domain');
      if (answer.status !== 200 || jws === undefined) {
        return { kind: 'retryable', reason: `broker answered ${String(answer.status)}` };
      }
      // The verifier refuses a record signed for any hostname but this one.
      const domain = await verifyDomain(jws, hostname);
      if (domain === undefined) {
        return { kind: 'refused' };
      }
      cache.set(domain, key);
      return { domain, kind: 'domain' };
    },

    async redeemGrant(input) {
      const answer = await call('POST', '/broker/grants', JSON.stringify(input));
      if (!answer.ok) {
        return { kind: 'retryable', reason: answer.reason };
      }
      if (answer.status === 404) {
        return { kind: 'refused' };
      }
      const grant = field(answer, 'grant');
      if (answer.status !== 200 || grant === undefined) {
        return { kind: 'retryable', reason: `broker answered ${String(answer.status)}` };
      }
      return { grant, kind: 'grant' };
    },
  };
}
