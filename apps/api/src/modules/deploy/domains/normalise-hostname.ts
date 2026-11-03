import { domainToASCII, domainToUnicode } from 'node:url';

/**
 * A member's custom hostname, reduced to the one form the platform stores, compares and registers
 * at the edge (spec 028 research R8). Pure: the SOA apex probe that follows it at add time is I/O
 * and lives with the caller.
 *
 * In order:
 *
 * 1. Trim, drop one trailing `.`, lowercase.
 * 2. `node:url` `domainToASCII` (UTS #46), so an IDN becomes its `xn--` form. An empty result is
 *    invalid: that is how the WHATWG algorithm reports a name it cannot encode.
 * 3. `invalid-hostname` for: over 253 characters; any label outside the LDH rule
 *    `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$` (which also refuses `*`, `_`, brackets and empty
 *    labels); an `xn--` label that does not decode; an IP literal; fewer than two labels; and
 *    `localhost` or anything under it (RFC 6761).
 * 4. `apex-not-supported` for exactly two labels: a CNAME cannot sit at a zone apex.
 * 5. `reserved-hostname` for a name equal to or under a platform-owned domain, compared by whole
 *    labels, so `notforge.app` is not under `forge.app`.
 *
 * **Rejected: a Public Suffix List** (`tldts`, or a vendored copy). It would be a new dependency or
 * a data file to keep fresh, and it answers "what is the registrable domain", which is not the
 * question. The question is "is this a zone apex", because that is where a CNAME is impossible.
 * Step 4 catches the common two-label apex without any list; a deeper apex (`acme.co.uk`) or a
 * delegated sub-zone is caught by the add-time SOA probe and the check's apex status (R6), which
 * answer exactly that question and which a suffix list would get wrong for delegated sub-zones.
 */

export type HostnameRefusal = 'apex-not-supported' | 'invalid-hostname' | 'reserved-hostname';

export type NormalisedHostname =
  | { readonly ok: true; readonly hostname: string; readonly displayHostname: string }
  | { readonly ok: false; readonly reason: HostnameRefusal };

const MAX_HOSTNAME = 253;
const LDH_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const ACE_PREFIX = 'xn--';
/** WHATWG treats a name whose last label is numeric (or `0x…`) as an IPv4 attempt. */
const NUMERIC_LABEL = /^(0x[0-9a-f]*|[0-9]+)$/;

/** Trim, one trailing dot, lowercase: step 1, shared by the input and the reserved entries. */
function tidy(value: string): string {
  const trimmed = value.trim();
  return (trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed).toLowerCase();
}

/** `name` is `suffix` or sits under it, by whole labels. */
function isAtOrUnder(name: string, suffix: string): boolean {
  return name === suffix || name.endsWith(`.${suffix}`);
}

/** An `xn--` label is valid only when it decodes to Unicode and encodes back to itself. */
function isValidAceLabel(label: string): boolean {
  const unicode = domainToUnicode(label);
  return unicode !== label && domainToASCII(unicode) === label;
}

function isValidLabel(label: string): boolean {
  return LDH_LABEL.test(label) && (!label.startsWith(ACE_PREFIX) || isValidAceLabel(label));
}

export function normaliseHostname(input: string, reserved: readonly string[]): NormalisedHostname {
  const hostname = domainToASCII(tidy(input));
  if (hostname === '' || hostname.length > MAX_HOSTNAME) {
    return { ok: false, reason: 'invalid-hostname' };
  }

  const labels = hostname.split('.');
  const tld = labels[labels.length - 1]!;
  if (
    labels.length < 2 ||
    !labels.every(isValidLabel) ||
    NUMERIC_LABEL.test(tld) ||
    tld === 'localhost'
  ) {
    return { ok: false, reason: 'invalid-hostname' };
  }

  if (labels.length === 2) return { ok: false, reason: 'apex-not-supported' };

  if (reserved.some((suffix) => isAtOrUnder(hostname, suffix))) {
    return { ok: false, reason: 'reserved-hostname' };
  }

  return { ok: true, hostname, displayHostname: domainToUnicode(hostname) };
}

/** The environment values R8 step 5 reserves; each is optional because each group is. */
export interface ReservedSources {
  /** `APP_URL`: its host is the product's own origin. */
  readonly appUrl?: string;
  /** `CUSTOM_HOSTNAME_TARGET`: its parent zone is reserved, the target included. */
  readonly customHostnameTarget?: string;
  readonly previewDomain?: string;
  /** `RESERVED_DOMAINS`, already split on commas. */
  readonly reservedDomains?: readonly string[];
  readonly siteDomain?: string;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function parentOf(hostname: string): string {
  return hostname.slice(hostname.indexOf('.') + 1);
}

/**
 * The platform-owned suffixes a custom hostname may not equal or sit under, tidied to the stored
 * form. A single-label entry (`localhost`, or the target's top-level parent) is dropped: every name
 * under `localhost` is already invalid, and reserving a whole top-level domain is never intended.
 */
export function reservedSuffixes(sources: ReservedSources): string[] {
  const target =
    sources.customHostnameTarget === undefined ? undefined : tidy(sources.customHostnameTarget);
  const candidates = [
    sources.appUrl === undefined ? undefined : hostOf(sources.appUrl),
    sources.previewDomain,
    sources.siteDomain,
    target === undefined ? undefined : parentOf(target),
    ...(sources.reservedDomains ?? []),
  ];
  return candidates
    .filter((entry): entry is string => entry !== undefined)
    .map((entry) => domainToASCII(tidy(entry)))
    .filter((entry) => entry.includes('.'));
}
