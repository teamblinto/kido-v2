import type { ConfigService } from '@nestjs/config';
import { z } from 'zod';

import * as envelope from '../../../common/cloudflare/cloudflare-envelope';
import type { CloudflareFailures } from '../../../common/cloudflare/cloudflare-envelope';
import type { Environment } from '../../../config/environment';
import { RetryableFailure } from '../../outbox/consumer';
import {
  type CustomHostnamePort,
  type EdgeCertificateState,
  EdgeNotConfigured,
  EdgeRefused,
  type EdgeHostnameState,
  type EdgeStatus,
} from './custom-hostname.port';

/**
 * Cloudflare for SaaS custom hostnames over the platform `fetch` (spec 028 research R2, R4,
 * contracts/domain-serving.md § 3): `{CLOUDFLARE_API_URL}/zones/{CLOUDFLARE_ZONE_ID}/custom_hostnames`.
 * The only file that knows a Cloudflare URL, header, envelope or state string.
 *
 * The official Cloudflare SDK was rejected (R2): a new runtime dependency, which is ask-first, to
 * call four routes of one resource.
 *
 * Every call is bounded by `EDGE_REQUEST_TIMEOUT_MS`. `429`, `5xx`, a timeout, a network error or
 * a `2xx` body this version does not understand throw `RetryableFailure`; any other `4xx` throws
 * `EdgeRefused` with the provider's first error message. No error carries the request, the
 * response or the `fetch` rejection as its `cause`: they are not inspected and not re-stated, so
 * the API token cannot leave through one.
 */
export const EDGE_REQUEST_TIMEOUT_MS = 10_000;

/** The vendor's "Duplicate custom hostname found." code (R9 adoption; **verify**, R2). */
const DUPLICATE_HOSTNAME_CODE = 1406;

/**
 * What an envelope failure is to a domain check: `429`, `5xx`, a timeout, a network error or an
 * unreadable `2xx` retry; any other status is `EdgeRefused` with the provider's first message.
 */
const FAILURES: CloudflareFailures = {
  refused: (status, errors) =>
    new EdgeRefused(errors[0]?.message ?? `Cloudflare refused the request (${status}).`),
  retryable: (status) => new RetryableFailure(status === 429 ? 'throttled' : 'upstream-5xx'),
  unreachable: () => new RetryableFailure('timeout'),
  unreadable: () => new RetryableFailure('upstream-5xx'),
};

const hostnameSchema = z.object({
  hostname: z.string(),
  id: z.string().min(1),
  ssl: z
    .object({
      status: z.string().optional(),
      validation_errors: z.array(z.object({ message: z.string() })).optional(),
      validation_records: z
        .array(z.object({ txt_name: z.string().optional(), txt_value: z.string().optional() }))
        .nullish(),
    })
    .nullish(),
  status: z.string(),
  verification_errors: z.array(z.string()).nullish(),
});

type VendorHostname = z.infer<typeof hostnameSchema>;

/** R2: `active` → active; `blocked`, `moved` → blocked; `deleted`, `pending_deletion` → gone. */
function hostnameState(vendor: string): EdgeHostnameState {
  if (vendor === 'active') return 'active';
  if (vendor === 'blocked' || vendor === 'moved') return 'blocked';
  if (vendor === 'deleted' || vendor === 'pending_deletion') return 'gone';
  return 'pending';
}

/** R2: `active` → active; `*_timed_out`, `expired` → failed; `deleted` → gone. */
function certificateState(vendor: string | undefined): EdgeCertificateState {
  if (vendor === 'active') return 'active';
  if (vendor === 'expired' || vendor?.endsWith('_timed_out') === true) return 'failed';
  if (vendor === 'deleted') return 'gone';
  return 'pending';
}

/** Fully qualified, lowercase, no trailing dot (the port's rule for names). */
const bareName = (name: string) => name.trim().toLowerCase().replace(/\.$/, '');

interface Api {
  readonly ca: string;
  readonly collection: string;
  readonly token: string;
}

/**
 * Not `@Injectable`: bound by factory, `new CloudflareForSaasAdapter(config)` (the timeout is a
 * spec seam).
 */
export class CloudflareForSaasAdapter implements CustomHostnamePort {
  private readonly api: Api | undefined;

  constructor(
    config: ConfigService<Environment, true>,
    private readonly timeoutMs: number = EDGE_REQUEST_TIMEOUT_MS,
  ) {
    const token = config.get('CLOUDFLARE_API_TOKEN', { infer: true });
    const zone = config.get('CLOUDFLARE_ZONE_ID', { infer: true });
    const url = config.get('CLOUDFLARE_API_URL', { infer: true });
    const ca = config.get('CUSTOM_HOSTNAME_CA', { infer: true });

    // The env schema makes the group all-or-none; `not-configured` is the none.
    this.api =
      token && zone && url
        ? {
            ca: ca ?? 'lets_encrypt',
            collection: `${url.replace(/\/+$/, '')}/zones/${encodeURIComponent(zone)}/custom_hostnames`,
            token,
          }
        : undefined;
  }

  async register(hostname: string): Promise<{ edgeId: string }> {
    const api = this.configured();
    const response = await this.send(api, api.collection, {
      body: JSON.stringify({
        hostname,
        ssl: {
          certificate_authority: api.ca,
          method: 'http',
          settings: { min_tls_version: '1.2' },
          type: 'dv',
        },
      }),
      method: 'POST',
    });

    if (!response.ok) {
      const errors = await envelope.errors(response);
      if (errors.some((error) => error.code === DUPLICATE_HOSTNAME_CODE)) {
        // R9: the hostname is already ours at the edge — a retried registration, or one made
        // before the row recorded it. Adopt it; if it vanished in between, the refusal stands.
        const existing = await this.findByHostname(hostname);
        if (existing !== undefined) return existing;
      }
      throw envelope.failure(response.status, errors, FAILURES);
    }

    return { edgeId: (await envelope.result(response, hostnameSchema, FAILURES)).id };
  }

  async status(edgeId: string): Promise<EdgeStatus> {
    const api = this.configured();
    const response = await this.send(api, `${api.collection}/${encodeURIComponent(edgeId)}`, {
      method: 'GET',
    });
    if (!response.ok)
      throw envelope.failure(response.status, await envelope.errors(response), FAILURES);

    const vendor: VendorHostname = await envelope.result(response, hostnameSchema, FAILURES);
    const validationRecords = (vendor.ssl?.validation_records ?? []).flatMap((record) =>
      record.txt_name && record.txt_value
        ? [{ name: bareName(record.txt_name), value: record.txt_value }]
        : [],
    );

    return {
      certificate: certificateState(vendor.ssl?.status),
      errors: [
        ...(vendor.verification_errors ?? []),
        ...(vendor.ssl?.validation_errors ?? []).map((error) => error.message),
      ],
      hostname: hostnameState(vendor.status),
      validationRecords,
    };
  }

  async findByHostname(hostname: string): Promise<{ edgeId: string } | undefined> {
    const api = this.configured();
    const query = new URLSearchParams({ hostname });
    const response = await this.send(api, `${api.collection}?${query.toString()}`, {
      method: 'GET',
    });
    if (!response.ok)
      throw envelope.failure(response.status, await envelope.errors(response), FAILURES);

    const list = await envelope.result(response, z.array(hostnameSchema), FAILURES);
    // The vendor's filter is not documented as exact; the adapter's answer is.
    const match = list.find((entry) => bareName(entry.hostname) === bareName(hostname));
    return match === undefined ? undefined : { edgeId: match.id };
  }

  async deregister(edgeId: string): Promise<void> {
    const api = this.configured();
    const response = await this.send(api, `${api.collection}/${encodeURIComponent(edgeId)}`, {
      method: 'DELETE',
    });
    // An edge that no longer knows the id has nothing left to remove.
    if (response.ok || response.status === 404) {
      await response.body?.cancel();
      return;
    }
    throw envelope.failure(response.status, await envelope.errors(response), FAILURES);
  }

  private configured(): Api {
    if (this.api === undefined) throw new EdgeNotConfigured();
    return this.api;
  }

  private send(api: Api, url: string, init: envelope.CloudflareRequest): Promise<Response> {
    return envelope.send(api.token, url, init, this.timeoutMs, FAILURES);
  }
}
