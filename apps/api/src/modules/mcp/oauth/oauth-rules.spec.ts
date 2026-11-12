import { describe, expect, it } from 'vitest';

import { pkceChallenge, requestedScopes } from './mcp-oauth.service';
import { mcpUrls, sameResource } from './mcp-urls';
import { isAcceptableRedirectUri, redirectUriMatches } from './redirect-uris';

describe('redirect URI rules (spec 046)', () => {
  it.each([
    ['https://claude.ai/api/mcp/auth_callback', true],
    ['http://localhost:33418/callback', true],
    ['http://127.0.0.1:8787/callback', true],
    ['http://[::1]:9000/cb', true],
    ['cursor://anysphere.cursor-mcp/oauth/callback', true],
    ['http://evil.example.com/callback', false],
    ['https://claude.ai/cb#fragment', false],
    ['javascript:alert(1)', false],
    ['data:text/html,hi', false],
    ['file:///etc/passwd', false],
    ['not a url', false],
  ])('%s registrable: %s', (uri, expected) => {
    expect(isAcceptableRedirectUri(uri)).toBe(expected);
  });

  it('matches registered URIs exactly, except a loopback port (RFC 8252 §7.3)', () => {
    const registered = [
      'https://claude.ai/api/mcp/auth_callback',
      'http://127.0.0.1:1234/callback',
    ];

    expect(redirectUriMatches(registered, 'https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(redirectUriMatches(registered, 'http://127.0.0.1:55555/callback')).toBe(true);
    expect(redirectUriMatches(registered, 'http://127.0.0.1:55555/other')).toBe(false);
    expect(redirectUriMatches(registered, 'http://localhost:1234/callback')).toBe(false);
    expect(redirectUriMatches(registered, 'https://claude.ai/api/mcp/auth_callback?x=1')).toBe(
      false,
    );
    expect(redirectUriMatches(registered, 'https://claude.ai:8443/api/mcp/auth_callback')).toBe(
      false,
    );
  });
});

describe('scope and PKCE rules (spec 046)', () => {
  it('drops unknown scopes and reads "none of ours" as all of them', () => {
    expect(requestedScopes('projects:read openid offline_access')).toEqual(['projects:read']);
    expect(requestedScopes('projects:deploy projects:read')).toEqual([
      'projects:read',
      'projects:deploy',
    ]);
    expect(requestedScopes(undefined)).toEqual([
      'projects:read',
      'projects:write',
      'projects:deploy',
    ]);
    expect(requestedScopes('openid')).toHaveLength(3);
  });

  it('computes the RFC 7636 appendix B S256 challenge', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });
});

describe('MCP URLs (spec 046)', () => {
  it('hangs every endpoint off the product origin', () => {
    expect(mcpUrls('https://app.example.com/some/path')).toEqual({
      authorizationEndpoint: 'https://app.example.com/oauth/authorize',
      issuer: 'https://app.example.com',
      registrationEndpoint: 'https://app.example.com/api/v1/oauth/register',
      resource: 'https://app.example.com/api/v1/mcp',
      resourceMetadata: 'https://app.example.com/.well-known/oauth-protected-resource/api/v1/mcp',
      revocationEndpoint: 'https://app.example.com/api/v1/oauth/revoke',
      tokenEndpoint: 'https://app.example.com/api/v1/oauth/token',
    });
  });

  it('compares resources without a trailing slash or fragment, and nothing else', () => {
    const resource = 'https://app.example.com/api/v1/mcp';

    expect(sameResource(`${resource}/`, resource)).toBe(true);
    expect(sameResource(`${resource}#x`, resource)).toBe(true);
    expect(sameResource('https://evil.example.com/api/v1/mcp', resource)).toBe(false);
    expect(sameResource('https://app.example.com/api/v1/mcpx', resource)).toBe(false);
    expect(sameResource('garbage', resource)).toBe(false);
  });
});
