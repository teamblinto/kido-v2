import { createHash, randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MCP_ACCESS_TOKEN_PREFIX,
  MCP_REFRESH_TOKEN_PREFIX,
  MCP_SCOPES,
  type McpAuthorizationDecision,
  type McpAuthorizationPreview,
  type McpAuthorizationRequest,
  type McpClientRegistrationRequest,
  type McpGrant,
  type McpScope,
  type McpTokenRequest,
  mcpAccessTokenSchema,
  mcpRefreshTokenSchema,
} from '@repo/contracts';
import type { McpClientRow, McpGrantRow } from '@repo/db';
import type { Redis } from 'ioredis';

import { CLOCK, type ClockPort } from '../../../common/clock/clock.port';
import { secretsMatch } from '../../../common/crypto/constant-time';
import { DomainError, NotFoundError } from '../../../common/errors/domain-error';
import { SESSION_REDIS } from '../../../common/redis/redis.constants';
import type { Environment } from '../../../config/environment';
import type { TenantTransaction } from '../../../database/database.types';
import { TenantTransactionRunner } from '../../../database/tenant-transaction';
import { AuditService } from '../../audit/audit.service';
import { PermissionDeniedError } from '../../rbac/guards/require-permission.guard';
import { PermissionResolutionService } from '../../rbac/permission-resolution.service';
import { McpGrantRepository, type McpTokenHashes } from './mcp-grant.repository';
import { type McpUrls, mcpUrls, sameResource } from './mcp-urls';
import { OAuthWireError } from './oauth-wire-error';
import { isAcceptableRedirectUri, redirectUriMatches } from './redirect-uris';

/**
 * One hour. Long enough that an agent's multi-step build does not refresh mid-task, short enough
 * that a leaked token dies on its own; revocation is immediate either way (every request reads the
 * grant).
 */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

/** Thirty days, sliding: each rotation issues a fresh one. An idle connection expires. */
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/** The code is redeemed by the client's own callback, within seconds; 60 s is the preview code's. */
export const AUTHORIZATION_CODE_TTL_SECONDS = 60;

/** `last_used_at` is for a person reading the settings page, not an audit trail: once a minute. */
const TOUCH_INTERVAL_MS = 60_000;

const codeKey = (code: string): string => `mcp:code:${sha256(code)}`;

interface CodeRecord {
  readonly clientId: string;
  readonly codeChallenge: string;
  readonly orgId: string;
  readonly redirectUri: string;
  readonly scopes: McpScope[];
  readonly userId: string;
}

/** What a verified access token stands for on the MCP endpoint. */
export interface McpPrincipal {
  readonly clientId: string;
  readonly expiresAt: Date;
  readonly grantId: string;
  readonly orgId: string;
  readonly scopes: readonly McpScope[];
  readonly userId: string;
}

/** RFC 6749 §5.1. */
export interface McpTokenResponse {
  readonly access_token: string;
  readonly expires_in: number;
  readonly refresh_token: string;
  readonly scope: string;
  readonly token_type: 'Bearer';
}

/** RFC 7591 §3.2.1. */
export interface McpClientRegistrationResponse {
  readonly client_id: string;
  readonly client_id_issued_at: number;
  readonly client_name: string;
  readonly client_uri?: string;
  readonly grant_types: string[];
  readonly redirect_uris: string[];
  readonly response_types: string[];
  readonly token_endpoint_auth_method: 'none';
}

/**
 * The OAuth 2.1 authorization server in front of the MCP endpoint (spec 046). It issues one kind
 * of credential — an opaque access token and a rotating refresh token, bound to one person, one
 * client, one organisation and this one resource — and keeps nothing a stolen database row could
 * replay: tokens are stored as SHA-256 digests, codes as Redis keys that are read once.
 *
 * A token is never more than the person: every MCP tool call resolves the person's RBAC
 * permissions afresh, and the scopes on the grant can only remove from them.
 */
@Injectable()
export class McpOAuthService {
  private readonly logger = new Logger(McpOAuthService.name);
  readonly urls: McpUrls;

  constructor(
    @Inject(McpGrantRepository) private readonly grants: McpGrantRepository,
    @Inject(TenantTransactionRunner) private readonly transactions: TenantTransactionRunner,
    @Inject(PermissionResolutionService) private readonly permissions: PermissionResolutionService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SESSION_REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(ConfigService) config: ConfigService<Environment, true>,
  ) {
    this.urls = mcpUrls(config.get('APP_URL', { infer: true }));
  }

  /** RFC 7591 dynamic registration. Public clients only: there is no client secret to issue. */
  async register(request: McpClientRegistrationRequest): Promise<McpClientRegistrationResponse> {
    const method = request.token_endpoint_auth_method ?? 'none';

    if (method !== 'none') {
      throw new OAuthWireError(
        'invalid_client_metadata',
        'Only public clients are supported: token_endpoint_auth_method must be "none".',
      );
    }

    const unsupportedGrant = (request.grant_types ?? []).find(
      (grant) => grant !== 'authorization_code' && grant !== 'refresh_token',
    );

    if (unsupportedGrant !== undefined) {
      throw new OAuthWireError(
        'invalid_client_metadata',
        `Unsupported grant type "${unsupportedGrant}".`,
      );
    }

    const refused = request.redirect_uris.find((uri) => !isAcceptableRedirectUri(uri));

    if (refused !== undefined) {
      throw new OAuthWireError(
        'invalid_redirect_uri',
        `Redirect URI "${refused}" is not allowed: use https, a loopback http address, or an app scheme.`,
      );
    }

    const client = await this.grants.createClient({
      clientName: request.client_name ?? 'MCP client',
      clientUri: request.client_uri ?? null,
      redirectUris: request.redirect_uris,
    });

    return {
      client_id: client.id,
      client_id_issued_at: Math.floor(client.createdAt.getTime() / 1_000),
      client_name: client.clientName,
      ...(client.clientUri === null ? {} : { client_uri: client.clientUri }),
      grant_types: ['authorization_code', 'refresh_token'],
      redirect_uris: client.redirectUris,
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  /** What the consent screen shows. Refuses a request that could not be answered safely. */
  async preview(request: McpAuthorizationRequest): Promise<McpAuthorizationPreview> {
    const client = await this.validated(request);

    return {
      clientName: client.clientName,
      clientUri: client.clientUri,
      redirectHost: new URL(request.redirectUri).host || request.redirectUri,
      scopes: requestedScopes(request.scope),
    };
  }

  /**
   * The person's answer. Either way the browser goes back to the client's verified redirect URI —
   * with a code, or with `access_denied` — carrying the client's `state` and our `iss` (RFC 9207).
   */
  async decide(userId: string, decision: McpAuthorizationDecision): Promise<string> {
    const { request } = decision;
    await this.validated(request);
    const redirect = new URL(request.redirectUri);

    if (request.state !== undefined) redirect.searchParams.set('state', request.state);
    redirect.searchParams.set('iss', this.urls.issuer);

    if (decision.decision === 'deny') {
      redirect.searchParams.set('error', 'access_denied');

      return redirect.href;
    }

    if (decision.orgId === undefined) {
      throw new DomainError('validation-failed', 'Choose the organization to connect.');
    }

    if ((await this.permissions.for(decision.orgId, userId)).size === 0) {
      throw new PermissionDeniedError();
    }

    const code = randomBytes(32).toString('base64url');
    const record: CodeRecord = {
      clientId: request.clientId,
      codeChallenge: request.codeChallenge,
      orgId: decision.orgId,
      redirectUri: request.redirectUri,
      scopes: requestedScopes(request.scope),
      userId,
    };

    await this.redis.set(
      codeKey(code),
      JSON.stringify(record),
      'EX',
      AUTHORIZATION_CODE_TTL_SECONDS,
    );
    redirect.searchParams.set('code', code);

    return redirect.href;
  }

  async token(request: McpTokenRequest): Promise<McpTokenResponse> {
    if (request.resource !== undefined && !sameResource(request.resource, this.urls.resource)) {
      throw new OAuthWireError(
        'invalid_request',
        'Unknown resource; this server issues tokens for its MCP endpoint only.',
      );
    }

    return request.grant_type === 'authorization_code'
      ? this.redeemCode(request)
      : this.refresh(request);
  }

  /** RFC 7009: answers the same whether or not the token existed, so it cannot be probed. */
  async revokeToken(token: string, clientId: string | undefined): Promise<void> {
    const hash = sha256(token);
    const grant =
      (await this.grants.byAccessTokenHash(hash)) ??
      (await this.grants.byRefreshTokenHash(hash))?.grant;

    if (grant === undefined || (clientId !== undefined && grant.clientId !== clientId)) return;

    await this.transactions.runInTenantScope(
      { orgId: grant.orgId, userId: grant.userId },
      async (tx) => {
        if (await this.grants.revoke(tx, grant.id, this.clock.now())) {
          await this.audit.record(tx, {
            action: 'mcp.client-revoked',
            actorId: grant.userId,
            metadata: { by: 'client', clientId: grant.clientId },
            orgId: grant.orgId,
            target: grant.id,
          });
        }
      },
    );
  }

  /**
   * The MCP endpoint's bearer check. `undefined` for anything that is not a live token for a live
   * grant — malformed, unknown, expired or revoked are indistinguishable to the caller.
   */
  async authenticate(token: string | undefined): Promise<McpPrincipal | undefined> {
    if (token === undefined || !mcpAccessTokenSchema.safeParse(token).success) return undefined;

    const grant = await this.grants.byAccessTokenHash(sha256(token));
    const now = this.clock.now();

    if (grant?.revokedAt !== null || grant.accessExpiresAt <= now) {
      return undefined;
    }

    if (
      grant.lastUsedAt === null ||
      now.getTime() - grant.lastUsedAt.getTime() > TOUCH_INTERVAL_MS
    ) {
      await this.transactions.runInTenantScope({ orgId: grant.orgId, userId: grant.userId }, (tx) =>
        this.grants.touch(tx, grant.id, now),
      );
    }

    return {
      clientId: grant.clientId,
      expiresAt: grant.accessExpiresAt,
      grantId: grant.id,
      orgId: grant.orgId,
      scopes: grant.scopes.filter(isScope),
      userId: grant.userId,
    };
  }

  async listGrants(tx: TenantTransaction, userId: string): Promise<McpGrant[]> {
    const rows = await this.grants.liveForUser(tx, userId);

    return rows.map(({ client, grant }) => ({
      clientName: client.clientName,
      clientUri: client.clientUri,
      createdAt: grant.createdAt.toISOString(),
      id: grant.id,
      lastUsedAt: grant.lastUsedAt?.toISOString() ?? null,
      scopes: grant.scopes.filter(isScope),
    }));
  }

  /** A person revokes one of their own grants from the settings page. */
  async revokeGrant(
    tx: TenantTransaction,
    orgId: string,
    userId: string,
    grantId: string,
  ): Promise<void> {
    if (!(await this.grants.revoke(tx, grantId, this.clock.now(), userId))) {
      throw new NotFoundError('No such connected agent.');
    }

    await this.audit.record(tx, {
      action: 'mcp.client-revoked',
      actorId: userId,
      metadata: { by: 'user' },
      orgId,
      target: grantId,
    });
  }

  private async validated(request: McpAuthorizationRequest): Promise<McpClientRow> {
    const client = await this.grants.clientById(request.clientId);

    if (client === undefined) {
      throw new DomainError('mcp-authorization-invalid', 'Unknown client.');
    }

    if (!redirectUriMatches(client.redirectUris, request.redirectUri)) {
      throw new DomainError(
        'mcp-authorization-invalid',
        'The redirect URI is not one this client registered.',
      );
    }

    if (request.resource !== undefined && !sameResource(request.resource, this.urls.resource)) {
      throw new DomainError('mcp-authorization-invalid', 'Unknown resource.');
    }

    return client;
  }

  private async redeemCode(
    request: Extract<McpTokenRequest, { grant_type: 'authorization_code' }>,
  ): Promise<McpTokenResponse> {
    const raw = await this.redis.getdel(codeKey(request.code));
    const record = raw === null ? undefined : (JSON.parse(raw) as CodeRecord);

    if (
      record?.clientId !== request.client_id ||
      record.redirectUri !== request.redirect_uri ||
      !secretsMatch(pkceChallenge(request.code_verifier), record.codeChallenge)
    ) {
      // One answer for unknown, used, expired, wrong client and wrong verifier (RFC 6749 §5.2).
      throw new OAuthWireError('invalid_grant', 'The authorization code is invalid or expired.');
    }

    const issued = this.issue();
    const grant = await this.transactions.runInTenantScope(
      { orgId: record.orgId, userId: record.userId },
      async (tx) => {
        const row = await this.grants.insertGrant(tx, {
          ...issued.hashes,
          clientId: record.clientId,
          orgId: record.orgId,
          scopes: record.scopes,
          userId: record.userId,
        });

        await this.audit.record(tx, {
          action: 'mcp.client-authorized',
          actorId: record.userId,
          metadata: { clientId: record.clientId, scopes: record.scopes },
          orgId: record.orgId,
          target: row.id,
        });

        return row;
      },
    );

    return this.tokenResponse(issued, grant.scopes);
  }

  private async refresh(
    request: Extract<McpTokenRequest, { grant_type: 'refresh_token' }>,
  ): Promise<McpTokenResponse> {
    const invalid = new OAuthWireError('invalid_grant', 'The refresh token is invalid or expired.');

    if (!mcpRefreshTokenSchema.safeParse(request.refresh_token).success) throw invalid;

    const hash = sha256(request.refresh_token);
    const found = await this.grants.byRefreshTokenHash(hash);

    if (found?.grant.clientId !== request.client_id) throw invalid;

    const { grant } = found;

    if (found.replayed) {
      // A rotated-out token came back: one of the two holders is not the client. Kill the grant.
      this.logger.warn(`mcp refresh token replayed; revoking grant=${grant.id}`);
      await this.revokeAsReplayed(grant);
      throw invalid;
    }

    if (grant.revokedAt !== null || grant.refreshExpiresAt <= this.clock.now()) throw invalid;

    // The person may have left the organisation since consenting.
    if ((await this.permissions.for(grant.orgId, grant.userId)).size === 0) throw invalid;

    const issued = this.issue();
    const rotated = await this.transactions.runInTenantScope(
      { orgId: grant.orgId, userId: grant.userId },
      (tx) => this.grants.rotate(tx, grant.id, hash, issued.hashes),
    );

    if (!rotated) throw invalid;

    return this.tokenResponse(issued, grant.scopes);
  }

  private async revokeAsReplayed(grant: McpGrantRow): Promise<void> {
    await this.transactions.runInTenantScope(
      { orgId: grant.orgId, userId: grant.userId },
      async (tx) => {
        if (await this.grants.revoke(tx, grant.id, this.clock.now())) {
          await this.audit.record(tx, {
            action: 'mcp.client-revoked',
            actorId: grant.userId,
            metadata: { by: 'refresh-replay', clientId: grant.clientId },
            orgId: grant.orgId,
            target: grant.id,
          });
        }
      },
    );
  }

  private issue(): { accessToken: string; hashes: McpTokenHashes; refreshToken: string } {
    const now = this.clock.now().getTime();
    const accessToken = mint(MCP_ACCESS_TOKEN_PREFIX);
    const refreshToken = mint(MCP_REFRESH_TOKEN_PREFIX);

    return {
      accessToken,
      hashes: {
        accessExpiresAt: new Date(now + ACCESS_TOKEN_TTL_SECONDS * 1_000),
        accessTokenHash: sha256(accessToken),
        refreshExpiresAt: new Date(now + REFRESH_TOKEN_TTL_SECONDS * 1_000),
        refreshTokenHash: sha256(refreshToken),
      },
      refreshToken,
    };
  }

  private tokenResponse(
    issued: { accessToken: string; refreshToken: string },
    scopes: string[],
  ): McpTokenResponse {
    return {
      access_token: issued.accessToken,
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: issued.refreshToken,
      scope: scopes.join(' '),
      token_type: 'Bearer',
    };
  }
}

/**
 * The scopes a request asks for. Unknown values are dropped rather than refused, because clients
 * routinely add their own (`openid`, `offline_access`); asking for none of ours means all of them,
 * which the consent screen spells out before anything is granted.
 */
export function requestedScopes(scope: string | undefined): McpScope[] {
  const asked = (scope ?? '').split(' ').filter(isScope);

  return asked.length === 0 ? [...MCP_SCOPES] : MCP_SCOPES.filter((one) => asked.includes(one));
}

function isScope(value: string): value is McpScope {
  return (MCP_SCOPES as readonly string[]).includes(value);
}

function mint(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** RFC 7636 §4.2, S256. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}
