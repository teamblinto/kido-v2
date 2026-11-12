/**
 * Every public URL the MCP authorization flow names (spec 046). The product is served from one
 * origin (Caddy sends `/api/*` and `/.well-known/oauth-*` to the API, everything else to the web
 * app), so all of them hang off `APP_URL`'s origin. The issuer has no path, which puts its RFC 8414
 * metadata at the root `/.well-known/oauth-authorization-server` every client tries first.
 */
export interface McpUrls {
  readonly authorizationEndpoint: string;
  readonly issuer: string;
  /** The MCP endpoint itself: the RFC 8707 resource, and the audience every token is bound to. */
  readonly resource: string;
  readonly resourceMetadata: string;
  readonly registrationEndpoint: string;
  readonly revocationEndpoint: string;
  readonly tokenEndpoint: string;
}

export const MCP_RESOURCE_PATH = '/api/v1/mcp';
export const PROTECTED_RESOURCE_METADATA_PATH = `/.well-known/oauth-protected-resource${MCP_RESOURCE_PATH}`;
export const AUTHORIZATION_SERVER_METADATA_PATH = '/.well-known/oauth-authorization-server';

export function mcpUrls(appUrl: string): McpUrls {
  const origin = new URL(appUrl).origin;

  return {
    // A web page, not an API route: consent needs the person's session and a screen.
    authorizationEndpoint: `${origin}/oauth/authorize`,
    issuer: origin,
    registrationEndpoint: `${origin}/api/v1/oauth/register`,
    resource: `${origin}${MCP_RESOURCE_PATH}`,
    resourceMetadata: `${origin}${PROTECTED_RESOURCE_METADATA_PATH}`,
    revocationEndpoint: `${origin}/api/v1/oauth/revoke`,
    tokenEndpoint: `${origin}/api/v1/oauth/token`,
  };
}

/** RFC 8707 §2: compare resources without a trailing slash or fragment. */
export function sameResource(a: string, b: string): boolean {
  const normalise = (value: string): string => {
    const url = new URL(value);
    url.hash = '';

    return url.href.replace(/\/$/, '');
  };

  try {
    return normalise(a) === normalise(b);
  } catch {
    return false;
  }
}
