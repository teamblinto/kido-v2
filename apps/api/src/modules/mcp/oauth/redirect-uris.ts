const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Schemes a browser would execute or read locally rather than hand to an application. */
const REFUSED_SCHEMES = new Set(['about:', 'blob:', 'data:', 'file:', 'javascript:', 'vbscript:']);

/**
 * Whether a client may register this redirect URI (RFC 7591 §2, OAuth 2.1 §2.3.1, RFC 8252).
 * HTTPS anywhere; plain HTTP only on loopback, where a native client such as Claude Code or VS
 * Code listens; a private-use scheme for desktop apps that register one. Never a fragment.
 */
export function isAcceptableRedirectUri(value: string): boolean {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.hash !== '' || value.includes('#')) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') return LOOPBACK_HOSTS.has(url.hostname);

  return !REFUSED_SCHEMES.has(url.protocol) && /^[a-z][a-z0-9+.-]*:$/.test(url.protocol);
}

/**
 * Exact string match against a registered URI, except that a loopback HTTP URI matches on any port
 * (RFC 8252 §7.3): a native client picks a free port per sign-in and cannot know it in advance.
 */
export function redirectUriMatches(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;

  let wanted: URL;

  try {
    wanted = new URL(requested);
  } catch {
    return false;
  }

  if (wanted.protocol !== 'http:' || !LOOPBACK_HOSTS.has(wanted.hostname)) return false;

  return registered.some((candidate) => {
    try {
      const url = new URL(candidate);

      return (
        url.protocol === 'http:' &&
        url.hostname === wanted.hostname &&
        url.pathname === wanted.pathname &&
        url.search === wanted.search
      );
    } catch {
      return false;
    }
  });
}
