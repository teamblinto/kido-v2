import { Controller, Get, Inject, Res, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { MCP_SCOPES } from '@repo/contracts';

import { Public } from '../../identity/decorators/public.decorator';
import { McpOAuthService } from '../oauth/mcp-oauth.service';
import {
  AUTHORIZATION_SERVER_METADATA_PATH,
  PROTECTED_RESOURCE_METADATA_PATH,
} from '../oauth/mcp-urls';

interface CacheableResponse {
  setHeader(name: string, value: string): unknown;
}

/** Discovery documents change only on deploy; an hour keeps clients from re-fetching per sign-in. */
const DISCOVERY_CACHE = 'public, max-age=3600';

/**
 * The two discovery documents an MCP client reads before it can sign in (spec 046). Served at the
 * root, outside `/api/v1` (`configureApplication` excludes `.well-known/*` from the prefix), because
 * RFC 8414 and RFC 9728 fix where a client looks. The protected-resource document is also at the
 * bare path, the fallback the MCP authorization spec tells clients to try.
 */
@ApiExcludeController()
@Public()
@Controller({ path: '.well-known', version: VERSION_NEUTRAL })
export class OAuthMetadataController {
  constructor(@Inject(McpOAuthService) private readonly oauth: McpOAuthService) {}

  @Get(AUTHORIZATION_SERVER_METADATA_PATH.replace('/.well-known/', ''))
  authorizationServer(@Res({ passthrough: true }) response: CacheableResponse): object {
    const { urls } = this.oauth;
    response.setHeader('Cache-Control', DISCOVERY_CACHE);

    return {
      authorization_endpoint: urls.authorizationEndpoint,
      authorization_response_iss_parameter_supported: true,
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      issuer: urls.issuer,
      registration_endpoint: urls.registrationEndpoint,
      response_types_supported: ['code'],
      revocation_endpoint: urls.revocationEndpoint,
      scopes_supported: MCP_SCOPES,
      token_endpoint: urls.tokenEndpoint,
      token_endpoint_auth_methods_supported: ['none'],
    };
  }

  @Get([PROTECTED_RESOURCE_METADATA_PATH.replace('/.well-known/', ''), 'oauth-protected-resource'])
  protectedResource(@Res({ passthrough: true }) response: CacheableResponse): object {
    const { urls } = this.oauth;
    response.setHeader('Cache-Control', DISCOVERY_CACHE);

    return {
      authorization_servers: [urls.issuer],
      bearer_methods_supported: ['header'],
      resource: urls.resource,
      resource_name: 'Projects',
      scopes_supported: MCP_SCOPES,
    };
  }
}
