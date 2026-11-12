import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { ThrottlerGuard, type ThrottlerRequest } from '@nestjs/throttler';
import { MCP_SCOPES } from '@repo/contracts';

import { DomainError } from '../../common/errors/domain-error';
import { McpOAuthService, type McpPrincipal } from './oauth/mcp-oauth.service';

export const MCP_PRINCIPAL = Symbol('forge.mcp.principal');

/** Calls per grant per minute. An agent's read bursts are a few dozen calls; this is headroom. */
export const MCP_GRANT_CALLS_PER_MINUTE = 300;

interface McpRequest {
  [MCP_PRINCIPAL]?: McpPrincipal;
  headers: Record<string, string | string[] | undefined>;
}

interface ChallengeResponse {
  setHeader(name: string, value: string): unknown;
}

/**
 * The MCP endpoint's only credential (spec 046): `Authorization: Bearer mcp_at_…`, no cookie. The
 * route is `@Public()` to the session guard and CSRF-exempt by path, so this is its gate. A
 * failure answers 401 with the RFC 9728 challenge — `WWW-Authenticate: Bearer resource_metadata=…`
 * — which is how an MCP client discovers where to sign in, so it must be on every 401.
 */
@Injectable()
export class McpBearerGuard implements CanActivate {
  constructor(@Inject(McpOAuthService) private readonly oauth: McpOAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<McpRequest>();
    const header = request.headers.authorization;
    const token =
      typeof header === 'string' && /^Bearer /i.test(header) ? header.slice(7).trim() : undefined;
    const principal = await this.oauth.authenticate(token);

    if (principal === undefined) {
      const challenge = [
        `resource_metadata="${this.oauth.urls.resourceMetadata}"`,
        `scope="${MCP_SCOPES.join(' ')}"`,
        ...(token === undefined ? [] : ['error="invalid_token"']),
      ];
      context
        .switchToHttp()
        .getResponse<ChallengeResponse>()
        .setHeader('WWW-Authenticate', `Bearer ${challenge.join(', ')}`);

      throw new DomainError('unauthorized', 'A valid MCP access token is required.');
    }

    request[MCP_PRINCIPAL] = principal;

    return true;
  }
}

/**
 * The per-grant budget, beside the app-wide per-address one: hosted clients (claude.ai, ChatGPT)
 * call from a handful of shared egress addresses, so the address cannot be the unit — the grant is.
 */
@Injectable()
export class McpGrantThrottlerGuard extends ThrottlerGuard {
  protected override getTracker(request: Record<string, unknown>): Promise<string> {
    const principal = (request as unknown as McpRequest)[MCP_PRINCIPAL];

    return principal === undefined
      ? super.getTracker(request)
      : Promise.resolve(`mcp-grant:${principal.grantId}`);
  }

  protected override handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    return super.handleRequest({ ...requestProps, limit: MCP_GRANT_CALLS_PER_MINUTE, ttl: 60_000 });
  }
}
