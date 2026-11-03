import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Plaintext } from '../../../../common/crypto/branded';
import type { Environment } from '../../../../config/environment';
import {
  failureFromStatus,
  ProviderFailure,
  type ProviderVerifier,
  retryAfterHeader,
  type VerifyResult,
  verifyFailure,
} from '../provider';
import type { ProviderResponse } from '../provider-fetch';
import { z } from 'zod';

import { endpoint, type ProviderRequest, providerJson } from '../provider-request';
import {
  resendCreatedKeySchema,
  resendDomainSchema,
  resendDomainsSchema,
  resendErrorSchema,
  resendKeysSchema,
} from './resend.schemas';

export const RESEND_CLIENT = Symbol('forge.connectors.resendClient');

const RESEND_SCOPES = ['full_access'] as const;

/** Resend's page ceiling for `GET /domains`. */
const DOMAIN_PAGE = 100;

export interface ResendDomain {
  readonly id: string;
  readonly name: string;
  readonly status: string;
}

export interface ResendKey {
  readonly id: string;
  readonly name: string;
}

/**
 * R5: Resend inverts the usual pair. A `401 restricted_api_key` is a live key restricted to
 * sending (short of `full_access`); a `403` — `restricted_api_key` "not active" or
 * `suspended_api_key` — is a dead one. The error `name` is read, never the status alone.
 */
export function classifyResend(response: ProviderResponse & { kind: 'status' }): ProviderFailure {
  let name: string | undefined;
  try {
    const parsed = resendErrorSchema.safeParse(JSON.parse(response.errorBody ?? ''));
    name = parsed.success ? parsed.data.name : undefined;
  } catch {
    name = undefined;
  }

  if (response.status === 401 && name === 'restricted_api_key') {
    return new ProviderFailure('forbidden-scope');
  }
  if (response.status === 403 && (name === 'restricted_api_key' || name === 'suspended_api_key')) {
    return new ProviderFailure('unauthorized');
  }
  if (response.status === 401 || name === 'missing_api_key' || name === 'invalid_api_key') {
    return new ProviderFailure('unauthorized');
  }

  return failureFromStatus(response.status, retryAfterHeader(response.headers));
}

/** Resend's API (contracts/provider-adapters.md § 5): `verify` (US1), domains and sending keys (US5). */
@Injectable()
export class ResendClient implements ProviderVerifier {
  private readonly baseUrl: string;

  constructor(@Inject(ConfigService) config: ConfigService<Environment, true>) {
    this.baseUrl = config.get('CONNECTOR_RESEND_API_URL', { infer: true });
  }

  async verify(key: Plaintext): Promise<VerifyResult> {
    try {
      const { data } = await providerJson(
        endpoint(this.baseUrl, '/domains?limit=1'),
        key,
        resendDomainsSchema,
        {},
        { classify: classifyResend, readErrorBody: true },
      );

      // Resend has no account endpoint a key can read; the team is named by its first domain.
      return {
        accountName: data[0]?.name ?? 'Resend team',
        accountRef: data[0]?.id ?? 'resend',
        kind: 'verified',
        scopes: [...RESEND_SCOPES],
      };
    } catch (error) {
      return verifyFailure(error, RESEND_SCOPES);
    }
  }

  /** Every domain of the account, paged by `after` (the last id of the page before). */
  async listDomains(key: Plaintext): Promise<ResendDomain[]> {
    const out: ResendDomain[] = [];
    let after: string | undefined;

    for (;;) {
      const query = new URLSearchParams({ limit: String(DOMAIN_PAGE) });
      if (after !== undefined) query.set('after', after);
      const page = await this.call(`/domains?${query.toString()}`, key, resendDomainsSchema);

      out.push(...page.data.map(({ id, name, status }) => ({ id, name, status })));
      const last = page.data.at(-1);
      if (page.has_more !== true || last === undefined) return out;
      after = last.id;
    }
  }

  async domain(key: Plaintext, domainId: string): Promise<ResendDomain> {
    const { id, name, status } = await this.call(
      `/domains/${encodeURIComponent(domainId)}`,
      key,
      resendDomainSchema,
    );

    return { id, name, status };
  }

  /** The `ResendDomainReader` port of the health sweep and the bindings read (US5/US6). */
  async domainStatus(key: Plaintext, domainId: string): Promise<string> {
    return (await this.domain(key, domainId)).status;
  }

  /** A key that can only send, and only from `domainId`; its token is returned once, here. */
  createSendingKey(
    key: Plaintext,
    name: string,
    domainId: string,
  ): Promise<{ id: string; token: string }> {
    return this.call('/api-keys', key, resendCreatedKeySchema, {
      body: { domain_id: domainId, name, permission: 'sending_access' },
      method: 'POST',
    });
  }

  async listKeys(key: Plaintext): Promise<ResendKey[]> {
    const { data } = await this.call('/api-keys', key, resendKeysSchema);

    return data.map(({ id, name }) => ({ id, name }));
  }

  /** A `404` is success: the key is already gone. */
  async deleteKey(key: Plaintext, keyId: string): Promise<void> {
    try {
      await this.call(`/api-keys/${encodeURIComponent(keyId)}`, key, z.unknown(), {
        method: 'DELETE',
      });
    } catch (error) {
      if (error instanceof ProviderFailure && error.category === 'not-found') return;
      throw error;
    }
  }

  private call<T>(
    path: string,
    key: Plaintext,
    schema: z.ZodType<T>,
    request?: ProviderRequest,
  ): Promise<T> {
    return providerJson(endpoint(this.baseUrl, path), key, schema, request, {
      classify: classifyResend,
      readErrorBody: true,
    });
  }
}
