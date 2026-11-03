import type { ConnectorProvider } from '@repo/contracts';

import type { Plaintext } from '../../../common/crypto/branded';

/**
 * The shapes every spec 030 provider adapter shares (contracts/provider-adapters.md § 1, research
 * R3, R5). An adapter maps its provider's status (and, for Resend, the error name) to a
 * {@link ProviderCategory}; nothing above the adapter sees a status code or a provider body.
 */
export type ProviderCategory =
  /** The credential is revoked or invalid → `needs_reauth`. */
  | 'unauthorized'
  /** The credential is alive but lacks a permission → `needs_reauth` with `missing-scope`. */
  | 'forbidden-scope'
  | 'not-found'
  | 'conflict'
  | 'rate-limited'
  | 'validation'
  | 'quota-exceeded'
  | 'unavailable';

/** R5 / §10: 429, 5xx, a timeout and Neon's 423 retry; every other category is terminal. */
const RETRYABLE: ReadonlySet<ProviderCategory> = new Set(['rate-limited', 'unavailable']);

/**
 * A provider refused or failed a call. Carries no request, response or `cause`: the credential
 * rides the request and a provider body is a document we did not write.
 */
export class ProviderFailure extends Error {
  readonly retryable: boolean;

  constructor(
    readonly category: ProviderCategory,
    readonly retryAfterSeconds?: number,
    /** Neon's `423 Locked` is `conflict`-shaped but retried (R5). */
    retryableOverride?: boolean,
  ) {
    super(`Provider failure: ${category}`);
    this.name = 'ProviderFailure';
    this.retryable = retryableOverride ?? RETRYABLE.has(category);
  }
}

/** What a connect-time or health-time probe proved (R6). */
export type VerifyResult =
  | {
      readonly kind: 'verified';
      readonly accountRef: string;
      readonly accountName: string;
      readonly scopes: readonly string[];
    }
  /** → `needs_reauth`, or the connect refused. */
  | { readonly kind: 'revoked' }
  /** → the connect refused naming what is missing, or `needs_reauth` with `missing-scope`. */
  | { readonly kind: 'missing-scope'; readonly missing: readonly string[] }
  /** → `recordFailure` (the circuit). */
  | {
      readonly kind: 'failed';
      readonly category: ProviderCategory;
      /** A rate limit's reset, when the provider named one. */
      readonly retryAfterSeconds?: number;
    };

export interface ProviderVerifier {
  verify(credential: Plaintext): Promise<VerifyResult>;
}

/** The non-GitHub providers' verifiers; GitHub keeps its installation check (spec 018 R9). */
export type ProviderVerifiers = ReadonlyMap<ConnectorProvider, ProviderVerifier>;

/** `Map<ConnectorProvider, ProviderVerifier>`, built by a factory in `ConnectorsModule`. */
export const PROVIDER_VERIFIERS = Symbol('forge.connectors.providerVerifiers');

/**
 * R5's common status table: what a non-2xx (or nothing answering) means, before a provider's own
 * exceptions (Resend's inverted pair, Neon's 423) are applied by its adapter.
 */
export function failureFromStatus(
  status: number | undefined,
  retryAfterSeconds?: number,
): ProviderFailure {
  if (status === undefined || status >= 500) return new ProviderFailure('unavailable');

  switch (status) {
    case 401:
      return new ProviderFailure('unauthorized');
    case 403:
      return new ProviderFailure('forbidden-scope');
    case 404:
    case 410:
      return new ProviderFailure('not-found');
    case 409:
      return new ProviderFailure('conflict');
    case 429:
      return new ProviderFailure('rate-limited', retryAfterSeconds);
    default:
      return new ProviderFailure('validation');
  }
}

/**
 * A verify probe's failure as a {@link VerifyResult}: a refused credential is `revoked`, one short
 * of a permission is `missing-scope` naming `scopes`, anything else is `failed` (the breaker).
 */
export function verifyFailure(error: unknown, scopes: readonly string[]): VerifyResult {
  if (!(error instanceof ProviderFailure)) throw error;

  switch (error.category) {
    case 'unauthorized':
      return { kind: 'revoked' };
    case 'forbidden-scope':
      return { kind: 'missing-scope', missing: scopes };
    default:
      return {
        category: error.category,
        kind: 'failed',
        ...(error.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: error.retryAfterSeconds }),
      };
  }
}

/** `Retry-After` in seconds, when present and sane. */
export function retryAfterHeader(headers: Headers): number | undefined {
  const value = Number(headers.get('retry-after'));

  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : undefined;
}
