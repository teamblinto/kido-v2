// Host grammar (contracts/preview.md § 4): `<label>-<port>.<PREVIEW_DOMAIN>`, label
// `[0-9a-f]{20,64}`, port 1024-65535. Anything else is a refusal, never a throw — the caller
// (T023's pipeline) turns a refusal into the standard 404 with no broker call.

export interface ResolvedHost {
  /** Absent for a preview host; see `ResolvedSiteHost`. */
  kind?: 'preview';
  ok: true;
  /** The lowercased hostname with the gateway's own `:port` stripped. */
  hostname: string;
  label: string;
  port: number;
}
export interface RefusedHost {
  ok: false;
}
/** `{label}.{SITE_DOMAIN}` (contracts/site-serving.md § 1). */
export interface ResolvedSiteHost {
  hostname: string;
  kind: 'site';
  label: string;
  ok: true;
}
/**
 * Any other syntactically valid hostname, when custom domains are configured
 * (contracts/domain-serving.md § 1). Only the broker knows whether it is a live domain.
 */
export interface ResolvedDomainHost {
  hostname: string;
  kind: 'domain';
  ok: true;
}
export type ResolveHostResult = ResolvedHost | ResolvedSiteHost | ResolvedDomainHost | RefusedHost;

const SITE_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';

const REFUSED: RefusedHost = { ok: false };

/** The API's R8 syntax (`normalise-hostname.ts`), on the already-normalised form the edge sends. */
const MAX_HOSTNAME = 253;
const LDH_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
/** A numeric (or `0x…`) last label is an IP literal to WHATWG, never a hostname. */
const NUMERIC_LABEL = /^(0x[0-9a-f]*|[0-9]+)$/;

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parses an inbound `Host` header against the preview domain and, when the gateway serves sites,
 * the site domain (checked second), then, when `customDomains` is on (and sites are served), any
 * other valid hostname as a custom domain. Pure: no I/O, no broker call. The domains are passed in
 * rather than imported (the config owns reading the env vars).
 */
export function resolveHost(
  host: string,
  previewDomain: string,
  siteDomain?: string,
  customDomains = false,
): ResolveHostResult {
  // The gateway's own listening port rides along on the Host header (e.g. `...:3200` locally);
  // it is not part of the label-encoded route port and is stripped before matching.
  const hostname = host.split(':', 1)[0]?.toLowerCase() ?? '';
  const pattern = new RegExp(
    `^([0-9a-f]{20,64})-([0-9]{1,5})\\.${escapeForRegExp(previewDomain.toLowerCase())}$`,
  );
  const match = pattern.exec(hostname);
  if (!match) {
    if (siteDomain === undefined) {
      return REFUSED;
    }
    const site = resolveSite(hostname, siteDomain);
    return site.ok || !customDomains ? site : resolveDomain(hostname, [previewDomain, siteDomain]);
  }

  const [, label, portText] = match;
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    return REFUSED;
  }

  return { ok: true, hostname, label: label!, port };
}

function resolveSite(hostname: string, siteDomain: string): ResolveHostResult {
  const pattern = new RegExp(`^(${SITE_LABEL})\\.${escapeForRegExp(siteDomain.toLowerCase())}$`);
  const label = pattern.exec(hostname)?.[1];
  return label === undefined ? REFUSED : { hostname, kind: 'site', label, ok: true };
}

/** `name` is `suffix` or sits under it, by whole labels. */
function isAtOrUnder(name: string, suffix: string): boolean {
  return name === suffix || name.endsWith(`.${suffix}`);
}

/**
 * A custom domain: a valid LDH hostname of two or more labels, not an IP literal, not under
 * `localhost`, and not at or under a platform domain. A malformed preview or site host is refused
 * here rather than asked of the broker, which could never hold it (R8 reserves those domains).
 */
function resolveDomain(hostname: string, platform: string[]): ResolveHostResult {
  const labels = hostname.split('.');
  const tld = labels[labels.length - 1]!;
  if (
    hostname.length > MAX_HOSTNAME ||
    labels.length < 2 ||
    !labels.every((label) => LDH_LABEL.test(label)) ||
    NUMERIC_LABEL.test(tld) ||
    tld === 'localhost' ||
    platform.some((suffix) => isAtOrUnder(hostname, suffix.toLowerCase()))
  ) {
    return REFUSED;
  }
  return { hostname, kind: 'domain', ok: true };
}
