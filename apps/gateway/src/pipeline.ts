import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

import type { BrokerClient, BrokerDomainResult, BrokerSiteResult } from './broker-client.ts';
import { takeEdgeHeader } from './edge-origin.ts';
import { type Grant, grantCookie } from './grant-check.ts';
import { type Page, REFUSED_PAGE, send } from './pages.ts';
import { GRANT_COOKIE, proxyRequest } from './proxy.ts';
import { resolveHost } from './resolve.ts';
import type { RouteRecord } from './route-verify.ts';
import { serveSite, type SiteServeDeps, type SiteTarget } from './site-serve.ts';
import { proxyUpgrade, refuseSocket } from './upgrade.ts';
import { createWaking, type Waking } from './waking.ts';

/** Broker unreachable and nothing cached for the label (research R4): retry, do not refuse. */
export const BROKER_UNAVAILABLE_PAGE: Page = {
  status: 503,
  body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Try again</title></head><body><h1>Try again</h1><p>Temporarily unavailable. Retrying shortly.</p></body></html>',
  headers: { 'Retry-After': '2' },
};

export interface PipelineOptions {
  broker: Pick<BrokerClient, 'getRoute' | 'redeemGrant'>;
  dialOrigin?: string;
  /**
   * Custom domains (spec 028, contracts/domain-serving.md), present only when
   * `EDGE_ORIGIN_SECRET` and `SITE_DOMAIN` are both set; a domain serves through `site`'s store,
   * so without `site` it is ignored. `fromEdge` checks, and always removes, `X-Forge-Edge`.
   */
  domain?: {
    fromEdge: (req: IncomingMessage) => boolean;
    getDomain: (hostname: string) => Promise<BrokerDomainResult>;
  };
  previewDomain: string;
  /** `PRODUCT_ORIGIN`: where a non-public preview sends the browser for a grant (contract § 4). */
  productOrigin: string;
  /**
   * Deployed sites (spec 027, contracts/site-serving.md), present only when `SITE_DOMAIN` is set.
   * Without it a site host is simply not a host this gateway knows: the uniform 404.
   */
  site?: SiteServeDeps & {
    domain: string;
    getSite: (label: string) => Promise<BrokerSiteResult>;
  };
  socketMaxMs: number;
  upstreamTimeoutMs: number;
  /** T028's local grant check: the cookie's JWS against the JWKS, `aud` = the request host. */
  verifyGrant: (jws: string, host: string) => Promise<Grant | undefined>;
  /** `GATEWAY_WAKE_BUDGET_MS`: how long a label may keep answering `202` before "could not wake". */
  wakeBudgetMs: number;
  /** Bound on labels tracked as waking; `ROUTE_CACHE_MAX` in main. */
  wakeMax?: number;
}

type Decision = { page: Page } | { route: RouteRecord } | { site: SiteTarget };

function redirect(location: string, setCookie?: string): Page {
  return {
    status: 302,
    body: '',
    headers: {
      Location: location,
      ...(setCookie === undefined ? {} : { 'Set-Cookie': setCookie }),
    },
  };
}

/**
 * The grant exchange (contract § 4, research R6). A `?code=` return is redeemed through the broker
 * and pinned to this host as `__Host-preview_grant`, then the browser is sent back to the same
 * path without `code`; otherwise the cookie must verify locally, or the browser is sent to the
 * product origin to obtain one. `org` visibility is private to the gateway: membership was
 * checked when the grant was minted.
 */
async function checkGrant(
  req: IncomingMessage,
  host: string,
  label: string,
  opts: PipelineOptions,
  upgrade: boolean,
): Promise<Page | undefined> {
  const url = new URL(req.url ?? '/', `http://${host}`);
  const code = url.searchParams.get('code');
  // An upgrade cannot carry a Set-Cookie anywhere useful; skipping it keeps a single-use code
  // from being burnt by a WebSocket dial.
  if (code !== null && !upgrade) {
    const answer = await opts.broker.redeemGrant({ code, host });
    if (answer.kind === 'retryable') {
      return BROKER_UNAVAILABLE_PAGE;
    }
    const grant = answer.kind === 'grant' ? await opts.verifyGrant(answer.grant, host) : undefined;
    if (answer.kind !== 'grant' || grant === undefined) {
      return REFUSED_PAGE;
    }
    url.searchParams.delete('code');
    const maxAge = Math.max(0, grant.exp - Math.floor(Date.now() / 1000));
    // In the project page's frame the preview is cross-site to the top level, where a Lax cookie
    // is neither set nor sent. Partitioned keys it to that top level (the product origin), so no
    // other site that frames or posts to the preview carries it; opened in a tab it stays Lax.
    const sameSite =
      req.headers['sec-fetch-dest'] === 'iframe' ? 'SameSite=None; Partitioned' : 'SameSite=Lax';
    return redirect(
      `${url.pathname}${url.search}`,
      `${GRANT_COOKIE}=${answer.grant}; Max-Age=${String(maxAge)}; Path=/; Secure; HttpOnly; ${sameSite}`,
    );
  }
  const jws = grantCookie(req.headers.cookie);
  if (jws !== undefined && (await opts.verifyGrant(jws, host)) !== undefined) {
    return undefined;
  }
  return authorizeRedirect(req, host, label, opts);
}

function authorizeRedirect(
  req: IncomingMessage,
  host: string,
  label: string,
  opts: PipelineOptions,
): Page {
  const authorize = new URL('/preview-authorize', opts.productOrigin);
  authorize.searchParams.set('label', label);
  // `host` is the bare hostname (grant `aud`, broker `host`); `return=` carries the Host
  // authority with its `:port` so the API can send the browser back to the right local origin —
  // but only when the whole header is that hostname plus an optional port; anything else (e.g. a
  // `@userinfo` trick after the port) falls back to the bare hostname.
  const authority = (req.headers.host ?? '').toLowerCase();
  const port = authority.startsWith(host) ? authority.slice(host.length) : '';
  authorize.searchParams.set('return', /^(:\d{1,5})?$/.test(port) ? authority : host);
  return redirect(authorize.href);
}

/**
 * Every check that decides whether to dial at all (contracts/preview.md § 2, FR-003): parse the
 * host → cached route or broker (which verifies) → port declared → visibility. Only a `route`
 * decision reaches the sandbox.
 */
async function decide(
  req: IncomingMessage,
  opts: PipelineOptions,
  waking: Waking,
  upgrade = false,
): Promise<Decision> {
  // `X-Forge-Edge` leaves the request before anything else reads it, whatever the host: it must
  // never reach a sandbox, the store, a response or a log line (contracts/domain-serving.md § 1).
  let fromEdge = false;
  if (opts.domain === undefined) {
    takeEdgeHeader(req);
  } else {
    fromEdge = opts.domain.fromEdge(req);
  }
  const domains = opts.site === undefined ? undefined : opts.domain;
  const host = resolveHost(
    req.headers.host ?? '',
    opts.previewDomain,
    opts.site?.domain,
    domains !== undefined,
  );
  if (!host.ok) {
    return { page: REFUSED_PAGE };
  }
  if (host.kind === 'domain') {
    // Only the edge may send a custom hostname; a site serves no sockets (027), so an upgrade is
    // refused before any broker call. `resolveHost` answers `domain` only when both are set.
    if (!fromEdge || upgrade) {
      return { page: REFUSED_PAGE };
    }
    const answer = await domains!.getDomain(host.hostname);
    switch (answer.kind) {
      case 'refused':
        return { page: REFUSED_PAGE };
      case 'retryable':
        return { page: BROKER_UNAVAILABLE_PAGE };
      case 'domain':
        return { site: answer.domain };
    }
  }
  if (host.kind === 'site') {
    // A site is static files: nothing upgrades, so no broker call is spent on one.
    if (upgrade || opts.site === undefined) {
      return { page: REFUSED_PAGE };
    }
    const answer = await opts.site.getSite(host.label);
    switch (answer.kind) {
      case 'refused':
        return { page: REFUSED_PAGE };
      case 'retryable':
        return { page: BROKER_UNAVAILABLE_PAGE };
      case 'site':
        return { site: answer.site };
    }
  }
  const answer = await waking.resolve(host.label, {
    grant: grantCookie(req.headers.cookie),
    host: host.hostname,
  });
  switch (answer.kind) {
    case 'refused':
      return { page: REFUSED_PAGE };
    case 'unauthorised': {
      // The broker would not resolve (nor resume) for this visitor: a `?code=` return is redeemed
      // and the redirect back re-asks the broker with the fresh cookie; otherwise, to the
      // product origin — even when a cookie verifies locally, because the broker outranks us.
      const page = await checkGrant(req, host.hostname, host.label, opts, upgrade);
      return { page: page ?? authorizeRedirect(req, host.hostname, host.label, opts) };
    }
    case 'page':
      return { page: answer.page };
    case 'retryable':
      return { page: BROKER_UNAVAILABLE_PAGE };
    case 'route':
      break;
  }
  const { route } = answer;
  if (!route.ports.includes(host.port)) {
    return { page: REFUSED_PAGE };
  }
  if (route.visibility !== 'public') {
    // `aud` is the bare host: the gateway's own listening port is not part of it.
    const page = await checkGrant(req, host.hostname, host.label, opts, upgrade);
    if (page !== undefined) {
      return { page };
    }
  }
  // `proxy.ts`'s `outboundHeaders` drops `__Host-preview_grant` from `Cookie` on the dial itself,
  // after this decision: the grant is read here, never forwarded.
  return { route };
}

export function createPipeline(opts: PipelineOptions) {
  const waking = createWaking({
    budgetMs: opts.wakeBudgetMs,
    getRoute: (label, ctx) => opts.broker.getRoute(label, ctx),
    max: opts.wakeMax ?? 1000,
  });
  return {
    waking,
    // A throw anywhere (e.g. `new URL()` on a malformed record) is a refusal, never an
    // unhandled rejection: one bad route must not take the process down.
    async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
      try {
        const decision = await decide(req, opts, waking);
        if ('page' in decision) {
          req.resume();
          send(res, decision.page);
          return;
        }
        if ('site' in decision) {
          // `decide` returns a site (or a domain's release) only when `opts.site` is set; the
          // method check (405) is `serveSite`'s, as for a site.
          await serveSite(req, res, decision.site, opts.site!);
          return;
        }
        await proxyRequest(req, res, decision.route, {
          dialOrigin: opts.dialOrigin,
          upstreamTimeoutMs: opts.upstreamTimeoutMs,
        });
      } catch {
        if (res.headersSent) {
          res.destroy();
        } else {
          send(res, REFUSED_PAGE);
        }
      }
    },
    async onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
      try {
        const decision = await decide(req, opts, waking, true);
        if ('site' in decision) {
          refuseSocket(socket, REFUSED_PAGE);
          return;
        }
        if ('page' in decision) {
          // An upgrade cannot follow a redirect: a non-public route without a grant is a 404.
          refuseSocket(socket, decision.page.status === 302 ? REFUSED_PAGE : decision.page);
          return;
        }
        proxyUpgrade(req, socket, head, decision.route, {
          dialOrigin: opts.dialOrigin,
          socketMaxMs: opts.socketMaxMs,
        });
      } catch {
        if (socket.writable) {
          refuseSocket(socket, REFUSED_PAGE);
        } else {
          socket.destroy();
        }
      }
    },
  };
}
