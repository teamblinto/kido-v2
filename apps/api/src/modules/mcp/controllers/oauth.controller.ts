import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Res,
  UseFilters,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  type McpAuthorizationPreview,
  type McpAuthorizationRedirect,
  mcpClientRegistrationRequestSchema,
  mcpTokenRequestSchema,
} from '@repo/contracts';
import { z } from 'zod';

import { CurrentUser } from '../../identity/decorators/current-user.decorator';
import { Public } from '../../identity/decorators/public.decorator';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import {
  McpAuthorizationDecisionDto,
  McpAuthorizationPreviewDto,
  McpAuthorizationRedirectDto,
  McpAuthorizationRequestDto,
} from '../dto/mcp.dto';
import {
  type McpClientRegistrationResponse,
  McpOAuthService,
  type McpTokenResponse,
} from '../oauth/mcp-oauth.service';
import { OAuthWireError, OAuthWireErrorFilter } from '../oauth/oauth-wire-error';

interface NoStoreResponse {
  setHeader(name: string, value: string): unknown;
}

const revocationRequestSchema = z.object({
  client_id: z.string().max(100).optional(),
  token: z.string().min(1).max(200),
  token_type_hint: z.string().optional(),
});

/**
 * The machine half of the MCP authorization server (spec 046): what OAuth client libraries call
 * directly, with no session and no cookie. `@Public()` to the session guard and exempt from CSRF
 * by path (`DEVICE_TOKEN_PATHS`); each request authenticates by what its body proves. Errors are
 * RFC 6749 `{ error, error_description }`, through this controller's own filter.
 *
 * Throttled per address, below the app-wide ceiling: registration writes a row and is
 * unauthenticated by design, and the token endpoint is where a code or a refresh token is guessed.
 */
@ApiTags('mcp')
@Public()
@UseFilters(OAuthWireErrorFilter)
@Controller({ path: 'oauth', version: '1' })
export class OAuthController {
  constructor(@Inject(McpOAuthService) private readonly oauth: McpOAuthService) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Register an MCP client (RFC 7591)' })
  async register(
    @Body() body: unknown,
    @Res({ passthrough: true }) response: NoStoreResponse,
  ): Promise<McpClientRegistrationResponse> {
    const parsed = mcpClientRegistrationRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new OAuthWireError('invalid_client_metadata', describe(parsed.error));
    }

    response.setHeader('Cache-Control', 'no-store');

    return this.oauth.register(parsed.data);
  }

  @Post('token')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Exchange an authorization code or a refresh token (RFC 6749 §3.2)' })
  async token(
    @Body() body: unknown,
    @Res({ passthrough: true }) response: NoStoreResponse,
  ): Promise<McpTokenResponse> {
    const grantType = (body as { grant_type?: unknown } | undefined)?.grant_type;

    if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
      throw new OAuthWireError(
        'unsupported_grant_type',
        'grant_type must be authorization_code or refresh_token.',
      );
    }

    const parsed = mcpTokenRequestSchema.safeParse(body);

    if (!parsed.success) throw new OAuthWireError('invalid_request', describe(parsed.error));

    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Pragma', 'no-cache');

    return this.oauth.token(parsed.data);
  }

  @Post('revoke')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Revoke an access or refresh token (RFC 7009)' })
  async revoke(@Body() body: unknown): Promise<Record<string, never>> {
    const parsed = revocationRequestSchema.safeParse(body);

    if (!parsed.success) throw new OAuthWireError('invalid_request', describe(parsed.error));

    await this.oauth.revokeToken(parsed.data.token, parsed.data.client_id);

    return {};
  }
}

/**
 * The person-facing half: the consent page relays the client's request here under the person's own
 * session, so these are ordinary product routes — session, CSRF and problem details as everywhere.
 */
@ApiTags('mcp')
@Controller({ path: 'oauth/authorize', version: '1' })
export class OAuthConsentController {
  constructor(@Inject(McpOAuthService) private readonly oauth: McpOAuthService) {}

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Describe an MCP authorization request for the consent screen' })
  @ApiResponse({ status: 200, type: McpAuthorizationPreviewDto })
  async preview(@Body() body: McpAuthorizationRequestDto): Promise<McpAuthorizationPreview> {
    return this.oauth.preview(body);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Record the person's decision and get the client redirect" })
  @ApiResponse({ status: 200, type: McpAuthorizationRedirectDto })
  async decide(
    @CurrentUser() caller: AuthenticatedUser,
    @Body() body: McpAuthorizationDecisionDto,
  ): Promise<McpAuthorizationRedirect> {
    return { redirectUrl: await this.oauth.decide(caller.userId, body) };
  }
}

function describe(error: z.ZodError): string {
  const issue = error.issues[0];

  return issue === undefined
    ? 'The request is malformed.'
    : `${issue.path.join('.') || 'request'}: ${issue.message}`;
}
