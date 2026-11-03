import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { z } from 'zod';

import {
  type CloudflareFailures,
  errors,
  failure,
  result,
  send,
} from '../../../../common/cloudflare/cloudflare-envelope';
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
import { PROVIDER_TIMEOUT_MS } from '../provider-fetch';
import {
  cloudflareDeletedSchema,
  cloudflareDnsRecordSchema,
  cloudflareDnsRecordsSchema,
  cloudflareZonesSchema,
} from './cloudflare.schemas';

export const CLOUDFLARE_DNS_CLIENT = Symbol('forge.connectors.cloudflareDnsClient');

export interface CloudflareZone {
  readonly id: string;
  readonly name: string;
}

export interface CloudflareRecord {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly content: string;
  readonly comment: string | null;
}

export interface NewCloudflareRecord {
  readonly type: string;
  readonly name: string;
  readonly content: string;
  readonly comment: string;
}

const CLOUDFLARE_SCOPES = ['zone:read', 'dns:read'] as const;

/** The shared envelope's failures, in the connector's vocabulary (R5). */
const FAILURES: CloudflareFailures = {
  refused: (status) => failureFromStatus(status),
  retryable: (status) =>
    status === 429 ? new ProviderFailure('rate-limited') : new ProviderFailure('unavailable'),
  unreachable: () => new ProviderFailure('unavailable'),
  unreadable: () => new ProviderFailure('unavailable'),
};

/**
 * A customer's Cloudflare DNS (contracts/provider-adapters.md § 6), over the v4 envelope shared
 * with 028's Cloudflare for SaaS adapter: `verify` (US1), the zone and record calls (US2, R13).
 */
@Injectable()
export class CloudflareDnsClient implements ProviderVerifier {
  private readonly baseUrl: string;

  constructor(@Inject(ConfigService) config: ConfigService<Environment, true>) {
    this.baseUrl = config.get('CLOUDFLARE_API_URL', { infer: true }).replace(/\/+$/, '');
  }

  /** R6: Zone Read proved by a listed zone, DNS Read by reading the first zone's records. */
  async verify(token: Plaintext): Promise<VerifyResult> {
    let zones: z.infer<typeof cloudflareZonesSchema>;

    try {
      zones = await this.get(token, '/zones?per_page=50', cloudflareZonesSchema);
    } catch (error) {
      return verifyFailure(error, ['zone:read']);
    }

    const zone = zones[0];
    if (zone === undefined) return { kind: 'missing-scope', missing: ['zone:read'] };

    try {
      await this.get(
        token,
        `/zones/${encodeURIComponent(zone.id)}/dns_records?per_page=1`,
        cloudflareDnsRecordsSchema,
      );
    } catch (error) {
      return verifyFailure(error, ['dns:read']);
    }

    return {
      accountName: zone.account?.name ?? zone.name,
      accountRef: zone.account?.id ?? zone.id,
      kind: 'verified',
      scopes: [...CLOUDFLARE_SCOPES],
    };
  }

  /** The token's active zone that is the longest suffix of `hostname`, or `undefined`. */
  async zoneFor(token: Plaintext, hostname: string): Promise<CloudflareZone | undefined> {
    const labels = hostname.toLowerCase().replace(/\.$/, '').split('.');

    // A zone is at least two labels; the hostname itself may be one (an apex).
    for (let start = 0; start <= labels.length - 2; start += 1) {
      const suffix = labels.slice(start).join('.');
      const zones = await this.get(
        token,
        `/zones?name=${encodeURIComponent(suffix)}&status=active`,
        cloudflareZonesSchema,
      );
      const zone = zones.find((z) => z.name.toLowerCase() === suffix);

      if (zone !== undefined) return { id: zone.id, name: zone.name };
    }

    return undefined;
  }

  /** The zone's records of exactly this name and type. */
  async records(
    token: Plaintext,
    zoneId: string,
    filter: { readonly name: string; readonly type: string },
  ): Promise<CloudflareRecord[]> {
    const query = new URLSearchParams({
      'name.exact': filter.name,
      per_page: '100',
      type: filter.type,
    });
    const rows = await this.get(
      token,
      `/zones/${encodeURIComponent(zoneId)}/dns_records?${query.toString()}`,
      cloudflareDnsRecordsSchema,
    );

    return rows.map((row) => ({ ...row, comment: row.comment ?? null }));
  }

  /** One record by id; `undefined` when it is gone (`404`). */
  async record(
    token: Plaintext,
    zoneId: string,
    recordId: string,
  ): Promise<CloudflareRecord | undefined> {
    try {
      const row = await this.get(
        token,
        `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
        cloudflareDnsRecordSchema,
      );

      return { ...row, comment: row.comment ?? null };
    } catch (error) {
      if (error instanceof ProviderFailure && error.category === 'not-found') return undefined;
      throw error;
    }
  }

  /** Unproxied, automatic TTL, marked by `comment`; a `403` is `forbidden-scope` (no DNS Edit). */
  async createRecord(
    token: Plaintext,
    zoneId: string,
    record: NewCloudflareRecord,
  ): Promise<CloudflareRecord> {
    const row = await this.call(
      token,
      'POST',
      `/zones/${encodeURIComponent(zoneId)}/dns_records`,
      cloudflareDnsRecordSchema,
      { ...record, proxied: false, ttl: 1 },
    );

    return { ...row, comment: row.comment ?? null };
  }

  /** By id; a record already gone (`404`) is success. */
  async deleteRecord(token: Plaintext, zoneId: string, recordId: string): Promise<void> {
    try {
      await this.call(
        token,
        'DELETE',
        `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(recordId)}`,
        cloudflareDeletedSchema,
      );
    } catch (error) {
      if (error instanceof ProviderFailure && error.category === 'not-found') return;
      throw error;
    }
  }

  private get<T>(token: Plaintext, path: string, schema: z.ZodType<T>): Promise<T> {
    return this.call(token, 'GET', path, schema);
  }

  private async call<T>(
    token: Plaintext,
    method: 'DELETE' | 'GET' | 'POST',
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T> {
    const response = await send(
      revealPlaintext(token).toString('utf8'),
      `${this.baseUrl}${path}`,
      body === undefined ? { method } : { body: JSON.stringify(body), method },
      PROVIDER_TIMEOUT_MS,
      FAILURES,
    );

    if (response.ok) return result(response, schema, FAILURES);
    if (response.status === 429) {
      throw new ProviderFailure('rate-limited', retryAfterHeader(response.headers));
    }

    throw failure(response.status, await errors(response), FAILURES);
  }
}
