import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { NetlifySitePage } from '@repo/contracts';
import type { z } from 'zod';

import { type Plaintext, revealPlaintext } from '../../../../common/crypto/branded';
import type { Environment } from '../../../../config/environment';
import {
  failureFromStatus,
  ProviderFailure,
  type ProviderVerifier,
  type VerifyResult,
  verifyFailure,
} from '../provider';
import { providerFetch, type ProviderResponse } from '../provider-fetch';
import { endpoint, type ProviderRequest, providerJson } from '../provider-request';
import {
  netlifyAccountsSchema,
  netlifyDeploySchema,
  netlifyDeploysSchema,
  netlifySiteSchema,
  netlifySitesSchema,
  netlifyUserSchema,
} from './netlify.schemas';

export const NETLIFY_CLIENT = Symbol('forge.connectors.netlifyClient');

/** R6: a personal access token carries no scopes; what it proves is the account. */
const NETLIFY_SCOPES = ['account'] as const;

export interface NetlifySite {
  readonly id: string;
  readonly name: string;
  readonly url: string;
}

export interface NetlifyDeploy {
  readonly id: string;
  /** The SHA1 digests Netlify still wants uploaded. */
  readonly required: readonly string[];
  /** Netlify's own word: `uploading`, `processing`, `ready`, `error`, … */
  readonly state: string;
}

/** Netlify rejects a path holding either (contracts § 2): refused before anything is sent. */
function checkedPath(path: string): string {
  if (path.includes('#') || path.includes('?')) throw new ProviderFailure('validation');

  return path.startsWith('/') ? path : `/${path}`;
}

function toSite(site: z.output<typeof netlifySiteSchema>): NetlifySite {
  const url = site.ssl_url ?? site.url;

  return { id: site.id, name: site.name, url };
}

function toDeploy(deploy: z.output<typeof netlifyDeploySchema>): NetlifyDeploy {
  return { id: deploy.id, required: deploy.required ?? [], state: deploy.state };
}

/**
 * Netlify's API (contracts/provider-adapters.md § 2): `verify` (US1), and the sites and digest
 * deploys a publish uses (US4, research R11).
 */
@Injectable()
export class NetlifyClient implements ProviderVerifier {
  private readonly baseUrl: string;

  constructor(@Inject(ConfigService) config: ConfigService<Environment, true>) {
    this.baseUrl = config.get('NETLIFY_API_URL', { infer: true });
  }

  async verify(token: Plaintext): Promise<VerifyResult> {
    try {
      const user = await this.get(token, '/user', netlifyUserSchema);
      const accounts = await this.get(token, '/accounts', netlifyAccountsSchema);
      const account = accounts[0];

      if (account === undefined) return { kind: 'missing-scope', missing: [...NETLIFY_SCOPES] };

      return {
        accountName: user.full_name ?? account.name ?? account.slug,
        accountRef: account.slug,
        kind: 'verified',
        scopes: [...NETLIFY_SCOPES],
      };
    } catch (error) {
      return verifyFailure(error, NETLIFY_SCOPES);
    }
  }

  /** The bind form's list: `GET /sites?name=&filter=all`, fifty a page. */
  async listSites(
    token: Plaintext,
    { page = 1, q }: { readonly page?: number; readonly q?: string } = {},
  ): Promise<NetlifySitePage> {
    const query = new URLSearchParams({
      filter: 'all',
      name: q ?? '',
      page: String(page),
      per_page: '50',
    });
    const sites = await this.get(token, `/sites?${query.toString()}`, netlifySitesSchema);

    return { items: sites.map(toSite) };
  }

  /** `POST /{account}/sites`; a taken name (`422`) is `conflict`. */
  async createSite(token: Plaintext, accountSlug: string, name: string): Promise<NetlifySite> {
    const site = await this.get(
      token,
      `/${encodeURIComponent(accountSlug)}/sites`,
      netlifySiteSchema,
      { body: { name }, method: 'POST' },
      (status) => (status === 422 ? new ProviderFailure('conflict') : undefined),
    );

    return toSite(site);
  }

  /** `404` is `not-found`: the consumer calls it `site-gone` (FR-018). */
  async site(token: Plaintext, siteId: string): Promise<NetlifySite> {
    return toSite(await this.get(token, `/sites/${encodeURIComponent(siteId)}`, netlifySiteSchema));
  }

  /** A digest deploy (R11): `files` is `path → sha1`; the answer names what to upload. */
  async createDeploy(
    token: Plaintext,
    siteId: string,
    files: Readonly<Record<string, string>>,
    title: string,
  ): Promise<NetlifyDeploy> {
    const digests: Record<string, string> = {};
    for (const [path, sha1] of Object.entries(files)) digests[checkedPath(path)] = sha1;

    return toDeploy(
      await this.get(token, `/sites/${encodeURIComponent(siteId)}/deploys`, netlifyDeploySchema, {
        body: { async: true, files: digests, title },
        method: 'POST',
      }),
    );
  }

  /** R11's adoption on retry: the recent deploy whose title is exactly `title`. */
  async findDeployByTitle(
    token: Plaintext,
    siteId: string,
    title: string,
  ): Promise<NetlifyDeploy | undefined> {
    const deploys = await this.get(
      token,
      `/sites/${encodeURIComponent(siteId)}/deploys?per_page=20`,
      netlifyDeploysSchema,
    );
    const found = deploys.find((deploy) => deploy.title === title);

    return found === undefined ? undefined : toDeploy(found);
  }

  async deploy(token: Plaintext, deployId: string): Promise<NetlifyDeploy> {
    return toDeploy(
      await this.get(token, `/deploys/${encodeURIComponent(deployId)}`, netlifyDeploySchema),
    );
  }

  /** `PUT /deploys/{id}/files/{path}`, each segment encoded, the bytes as they are. */
  async uploadFile(
    token: Plaintext,
    deployId: string,
    path: string,
    body: Buffer,
    size: number,
  ): Promise<void> {
    const encoded = checkedPath(path).split('/').map(encodeURIComponent).join('/');
    const response = await providerFetch(
      endpoint(this.baseUrl, `/deploys/${encodeURIComponent(deployId)}/files${encoded}`),
      {
        body: new Uint8Array(body),
        headers: {
          authorization: `Bearer ${revealPlaintext(token).toString('utf8')}`,
          'content-length': String(size),
          'content-type': 'application/octet-stream',
        },
        method: 'PUT',
      },
      // A file's upload may take longer than a JSON call.
      { timeoutMs: 120_000 },
    );

    if (response.kind === 'ok' || response.kind === 'unparseable') return;
    if (response.kind === 'unreachable') throw new ProviderFailure('unavailable');

    throw classify(response);
  }

  private get<T>(
    token: Plaintext,
    path: string,
    schema: z.ZodType<T>,
    request: ProviderRequest = {},
    special?: (status: number) => ProviderFailure | undefined,
  ): Promise<T> {
    return providerJson(endpoint(this.baseUrl, path), token, schema, request, {
      classify: (response) => special?.(response.status) ?? classify(response),
    });
  }
}

function resetSeconds(header: string | null): number | undefined {
  const reset = Number(header);
  if (header === null || !Number.isFinite(reset) || reset <= 0) return undefined;

  return Math.max(1, Math.ceil(reset - Date.now() / 1000));
}

/** R5: Netlify names its reset as an epoch second, not a delay. */
function classify(response: ProviderResponse & { kind: 'status' }): ProviderFailure {
  return failureFromStatus(
    response.status,
    resetSeconds(response.headers.get('x-ratelimit-reset')),
  );
}
