import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  NeonProjectPage,
  ResendBindingConfig,
  ResendDomainPage,
  NetlifyBindingConfig,
  NetlifyBindRequest,
  NetlifySitePage,
  SupabaseProjectPage,
} from '@repo/contracts';
import type { Connection } from '@repo/db';

import { ConflictError, NotFoundError } from '../../common/errors/domain-error';
import type { Environment } from '../../config/environment';
import type { TenantTransaction } from '../../database/database.types';
import { ConnectionService } from './connection.service';
import { connectorRefusal, providerUnavailable } from './connectors.errors';
import { NEON_CLIENT, type NeonClient } from './providers/neon/neon.client';
import { NETLIFY_CLIENT, type NetlifyClient } from './providers/netlify/netlify.client';
import { ProviderFailure } from './providers/provider';
import {
  RESEND_CLIENT,
  type ResendClient,
  type ResendDomain,
} from './providers/resend/resend.client';
import { SUPABASE_CLIENT, type SupabaseClient } from './providers/supabase/supabase.client';

/**
 * FR-021: the platform's own sending domain — `MAIL_FROM`'s — and every name under it. User mail
 * and platform auth mail never share a domain, so no binding may offer or use it.
 */
export function platformSendingDomain(mailFrom: string): string {
  const address = /<([^>]+)>/u.exec(mailFrom)?.[1] ?? mailFrom;

  return (address.split('@').at(-1) ?? '').trim().toLowerCase();
}

export function isPlatformDomain(name: string, platform: string): boolean {
  const candidate = name.trim().toLowerCase();

  return platform !== '' && (candidate === platform || candidate.endsWith(`.${platform}`));
}

/**
 * The bind form's lists (contracts/bindings.md § 1): read through the named connection, which must
 * be of that provider and usable. A provider's failure is re-stated in the § 5 vocabulary, never
 * passed through.
 */
@Injectable()
export class ConnectorListings {
  constructor(
    @Inject(ConnectionService) private readonly connections: ConnectionService,
    @Inject(NEON_CLIENT) private readonly neon: NeonClient,
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    @Inject(NETLIFY_CLIENT) private readonly netlify: NetlifyClient,
    @Inject(RESEND_CLIENT) private readonly resend: ResendClient,
    @Inject(ConfigService) private readonly config: ConfigService<Environment, true>,
  ) {}

  /** `GET …/resend/domains`: every domain of the account but the platform's own (FR-021). */
  async resendDomains(
    tx: TenantTransaction,
    orgId: string,
    connectionId: string,
  ): Promise<ResendDomainPage> {
    const row = await this.usable(tx, orgId, connectionId, 'resend');
    const key = await this.connections.openCredential(tx, row);
    const domains = await this.restated('resend', () => this.resend.listDomains(key));

    return { items: domains.filter((domain) => !this.isPlatform(domain)) };
  }

  /**
   * A Resend bind's domain, read now so the binding stores its name and the bind knows whether to
   * mint. The platform's own domain answers as a missing one (FR-021).
   */
  async resendDomain(
    tx: TenantTransaction,
    connection: Connection,
    domainId: string,
  ): Promise<ResendBindingConfig & { readonly status: string }> {
    const key = await this.connections.openCredential(tx, connection);
    const domain = await this.restated('resend', () => this.resend.domain(key, domainId));

    if (this.isPlatform(domain)) throw new NotFoundError('No such Resend domain.');

    return { domainId: domain.id, domainName: domain.name, status: domain.status };
  }

  /** A bound domain's status, read with the connection's key (the bindings read, T095). */
  async resendDomainStatus(
    tx: TenantTransaction,
    connection: Connection,
    domainId: string,
  ): Promise<string> {
    const key = await this.connections.openCredential(tx, connection);

    return this.resend.domainStatus(key, domainId);
  }

  private isPlatform(domain: ResendDomain): boolean {
    return isPlatformDomain(
      domain.name,
      platformSendingDomain(this.config.get('MAIL_FROM', { infer: true })),
    );
  }

  /** `GET …/netlify/sites?q=`: the cursor is the next page's number. */
  async netlifySites(
    tx: TenantTransaction,
    orgId: string,
    connectionId: string,
    query?: string,
    cursor?: string,
  ): Promise<NetlifySitePage> {
    const row = await this.usable(tx, orgId, connectionId, 'netlify');
    const token = await this.connections.openCredential(tx, row);
    const page = cursor === undefined ? 1 : Math.max(1, Number.parseInt(cursor, 10) || 1);

    return this.restated('netlify', async () => {
      const result = await this.netlify.listSites(token, { page, q: query });

      return result.items.length < 50 ? result : { ...result, nextCursor: String(page + 1) };
    });
  }

  /**
   * A Netlify bind's site (contracts/bindings.md § 2): the chosen one read back, or a new one
   * created now under the connection's account — one synchronous call, no operation.
   */
  async netlifySite(
    tx: TenantTransaction,
    connection: Connection,
    request: NetlifyBindRequest,
  ): Promise<NetlifyBindingConfig> {
    const token = await this.connections.openCredential(tx, connection);
    const site = await this.restated('netlify', () =>
      'siteId' in request
        ? this.netlify.site(token, request.siteId)
        : this.netlify.createSite(token, connection.accountRef ?? '', request.createSite.name),
    );

    return { siteId: site.id, siteName: site.name, siteUrl: site.url };
  }

  async neonProjects(
    tx: TenantTransaction,
    orgId: string,
    connectionId: string,
    query?: string,
  ): Promise<NeonProjectPage> {
    const row = await this.usable(tx, orgId, connectionId, 'neon');
    const key = await this.connections.openCredential(tx, row);

    return this.restated('neon', () => this.neon.listProjects(key, query));
  }

  async supabaseProjects(
    tx: TenantTransaction,
    orgId: string,
    connectionId: string,
  ): Promise<SupabaseProjectPage> {
    await this.usable(tx, orgId, connectionId, 'supabase');
    const token = await this.connections.currentToken(tx, orgId, 'supabase');

    return this.restated('supabase', () => this.supabase.listProjects(token));
  }

  private async usable(
    tx: TenantTransaction,
    orgId: string,
    connectionId: string,
    provider: 'neon' | 'netlify' | 'resend' | 'supabase',
  ) {
    const row = await this.connections.byId(tx, orgId, connectionId);

    if (row.provider !== provider) throw new NotFoundError('No such connection.');

    return this.connections.ensureUsable(tx, orgId, provider);
  }

  private async restated<T>(
    provider: 'neon' | 'netlify' | 'resend' | 'supabase',
    work: () => Promise<T>,
  ): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof ProviderFailure)) throw error;

      switch (error.category) {
        case 'unauthorized':
          throw connectorRefusal('needs-reauth');
        case 'forbidden-scope':
          throw connectorRefusal('missing-scope');
        case 'not-found':
          throw connectorRefusal('not-found');
        case 'conflict':
          throw new ConflictError('The provider already has a resource by that name.', {
            reason: 'provider-refused',
          });
        default:
          throw providerUnavailable(error.retryAfterSeconds ?? 60, provider);
      }
    }
  }
}
