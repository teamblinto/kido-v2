import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { type Plaintext, revealPlaintext } from '../../../../common/crypto/branded';
import type { Environment } from '../../../../config/environment';
import {
  failureFromStatus,
  ProviderFailure,
  type ProviderVerifier,
  retryAfterHeader,
  type VerifyResult,
  verifyFailure,
} from '../provider';
import { providerFetch } from '../provider-fetch';
import { endpoint, providerJson } from '../provider-request';
import type { SupabaseProjectPage } from '@repo/contracts';

import {
  supabaseApiKeysSchema,
  supabaseOrganizationsSchema,
  supabaseProjectsSchema,
  supabaseProfileSchema,
  supabaseTokenSchema,
} from './supabase.schemas';

export const SUPABASE_CLIENT = Symbol('forge.connectors.supabaseClient');

/**
 * R6: the grant's scopes — the project list, the (unrevealed) API-keys read, and the database write
 * the migrations panel runs SQL with. Scopes are set on the OAuth app in Supabase's dashboard; a
 * grant made before `database:write` was added answers 403 there, which reads as `missing-scope`.
 */
const SUPABASE_SCOPES = ['projects:read', 'secrets:read', 'database:write'] as const;

/** A migration may take a while; the SQL endpoint holds the request until it is done. */
const QUERY_TIMEOUT_MS = 120_000;

export type SqlOutcome =
  | { readonly ok: true; readonly rows: readonly Record<string, unknown>[] }
  | { readonly ok: false; readonly message: string };

/** The web page Supabase sends the browser back to (apps/web `routes.supabaseCallback`). */
export const SUPABASE_CALLBACK_PATH = '/connectors/supabase/callback';

export interface SupabaseGrant {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
  readonly refreshToken: string;
}

/**
 * Supabase's Management API over OAuth with PKCE (contracts/provider-adapters.md § 4, research R1,
 * R10). The client pair is per deployment (ask-first 1); without it `isConfigured` is false and
 * the install answers 501.
 */
@Injectable()
export class SupabaseClient implements ProviderVerifier {
  private readonly appUrl: string;
  private readonly baseUrl: string;
  private readonly clientId: string | undefined;
  private readonly clientSecret: string | undefined;

  constructor(@Inject(ConfigService) config: ConfigService<Environment, true>) {
    this.appUrl = config.get('APP_URL', { infer: true });
    this.baseUrl = config.get('SUPABASE_API_URL', { infer: true });
    this.clientId = config.get('SUPABASE_OAUTH_CLIENT_ID', { infer: true });
    this.clientSecret = config.get('SUPABASE_OAUTH_CLIENT_SECRET', { infer: true });
  }

  isConfigured(): boolean {
    return this.clientId !== undefined && this.clientSecret !== undefined;
  }

  /** One expression, so the authorize and the exchange cannot send different values. */
  redirectUri(): string {
    return new URL(SUPABASE_CALLBACK_PATH, `${this.appUrl.replace(/\/+$/, '')}/`).toString();
  }

  authorizeUrl(state: string, challenge: string): string {
    const url = new URL(endpoint(this.baseUrl, '/v1/oauth/authorize'));
    url.searchParams.set('client_id', this.clientId ?? '');
    url.searchParams.set('redirect_uri', this.redirectUri());
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');

    return url.toString();
  }

  exchange(code: string, verifier: string): Promise<SupabaseGrant> {
    return this.token({
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: this.redirectUri(),
    });
  }

  /** A refused grant (400 / 401) is `unauthorized` — the connection needs re-authorisation. */
  refresh(refreshToken: string): Promise<SupabaseGrant> {
    return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  /** Best effort (the endpoint is beta): any 4xx means there is nothing left to revoke. */
  async revoke(refreshToken: string): Promise<void> {
    const response = await providerFetch(endpoint(this.baseUrl, '/v1/oauth/revoke'), {
      body: new URLSearchParams({
        client_id: this.clientId ?? '',
        client_secret: this.clientSecret ?? '',
        refresh_token: refreshToken,
      }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      method: 'POST',
    });

    if (response.kind === 'ok' || (response.kind === 'status' && response.status < 500)) return;

    throw new ProviderFailure('unavailable');
  }

  async verify(accessToken: Plaintext): Promise<VerifyResult> {
    try {
      await providerJson(endpoint(this.baseUrl, '/v1/profile'), accessToken, supabaseProfileSchema);
      const organizations = await providerJson(
        endpoint(this.baseUrl, '/v1/organizations'),
        accessToken,
        supabaseOrganizationsSchema,
      );
      const organization = organizations[0];

      if (organization === undefined) return { kind: 'missing-scope', missing: ['projects:read'] };

      return {
        accountName: organization.name,
        accountRef: organization.id,
        kind: 'verified',
        scopes: [...SUPABASE_SCOPES],
      };
    } catch (error) {
      return verifyFailure(error, SUPABASE_SCOPES);
    }
  }

  /** The bind form's list (contracts/bindings.md § 1). */
  async listProjects(accessToken: Plaintext): Promise<SupabaseProjectPage> {
    const projects = await providerJson(
      endpoint(this.baseUrl, '/v1/projects'),
      accessToken,
      supabaseProjectsSchema,
    );

    return {
      items: projects.map((project) => ({
        name: project.name === '' ? project.id : project.name,
        ref: project.id,
        region: project.region === '' ? 'unknown' : project.region,
        status: project.status === '' ? 'unknown' : project.status,
      })),
    };
  }

  /**
   * R10: the key a browser may hold. Never asks `reveal`, so no secret key's value is ever sent to
   * us; the `publishable` key, else the legacy `anon` key, else `not-found`.
   */
  async publishableKey(accessToken: Plaintext, projectRef: string): Promise<string> {
    const keys = await providerJson(
      endpoint(this.baseUrl, `/v1/projects/${encodeURIComponent(projectRef)}/api-keys`),
      accessToken,
      supabaseApiKeysSchema,
    );
    const chosen =
      keys.find((key) => key.type === 'publishable') ??
      keys.find((key) => key.name === 'anon' && (key.type ?? 'legacy') === 'legacy');

    if (chosen?.api_key === undefined || chosen.api_key === null || chosen.api_key === '') {
      throw new ProviderFailure('not-found');
    }

    return chosen.api_key;
  }

  /**
   * Runs `sql` on the project's database (`POST /v1/projects/{ref}/database/query`). The SQL's own
   * error — a 400 with the database's message — is the person's to read, so it is answered, not
   * thrown; a refused credential or an unavailable provider is a {@link ProviderFailure}.
   */
  async query(accessToken: Plaintext, projectRef: string, sql: string): Promise<SqlOutcome> {
    const response = await providerFetch(
      endpoint(this.baseUrl, `/v1/projects/${encodeURIComponent(projectRef)}/database/query`),
      {
        body: JSON.stringify({ query: sql }),
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${revealPlaintext(accessToken).toString('utf8')}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      },
      { readErrorBody: true, timeoutMs: QUERY_TIMEOUT_MS },
    );

    switch (response.kind) {
      case 'unreachable':
      case 'unparseable':
        throw new ProviderFailure('unavailable');
      case 'status':
        if (response.status === 400) return { message: sqlMessage(response.errorBody), ok: false };
        throw failureFromStatus(response.status, retryAfterHeader(response.headers));
      case 'ok':
        return {
          ok: true,
          rows: Array.isArray(response.body)
            ? (response.body.filter((row) => typeof row === 'object' && row !== null) as Record<
                string,
                unknown
              >[])
            : [],
        };
    }
  }

  private async token(form: Record<string, string>): Promise<SupabaseGrant> {
    const basic = Buffer.from(`${this.clientId ?? ''}:${this.clientSecret ?? ''}`).toString(
      'base64',
    );
    const response = await providerFetch(endpoint(this.baseUrl, '/v1/oauth/token'), {
      body: new URLSearchParams(form).toString(),
      headers: {
        accept: 'application/json',
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      method: 'POST',
    });

    switch (response.kind) {
      case 'unreachable':
      case 'unparseable':
        throw new ProviderFailure('unavailable');
      case 'status':
        throw response.status === 400 || response.status === 401
          ? new ProviderFailure('unauthorized')
          : failureFromStatus(response.status, retryAfterHeader(response.headers));
      case 'ok': {
        const parsed = supabaseTokenSchema.safeParse(response.body);
        if (!parsed.success) throw new ProviderFailure('unavailable');

        return {
          accessToken: parsed.data.access_token,
          expiresInSeconds: parsed.data.expires_in,
          refreshToken: parsed.data.refresh_token,
        };
      }
    }
  }
}

/** The database's message from a 400 body (`{ "message": "ERROR: …" }`), else the body itself. */
function sqlMessage(body: string | undefined): string {
  if (body === undefined || body === '') return 'The database refused the SQL.';
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed === 'object' && parsed !== null && 'message' in parsed) {
      const { message } = parsed;
      if (typeof message === 'string' && message !== '') return message;
    }
  } catch {
    // Not JSON: the text is the message.
  }
  return body;
}
