import type { LlmProviderName } from '../llm-provider.port';

/**
 * The port between `agent/byos/` and one provider's subscription OAuth (spec 032 contracts § 5).
 * One implementation per provider, each; until one is written the
 * generic RFC client (`generic-oauth.subscription.ts`) stands in, configured from `BYOS_<P>_*`.
 */

/** What is sealed into `linked_accounts.grant_sealed` (research R2). Never logged, never returned. */
export interface ByosGrant {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** ISO 8601; copied to `access_expires_at` so "needs refresh?" never opens the grant (R3). */
  readonly accessExpiresAt: string;
  readonly scopes: readonly string[];
}

export interface GrantResult {
  readonly grant: ByosGrant;
  /** The provider's display identifier for the account (e.g. its email). */
  readonly accountLabel: string;
}

export interface RefreshResult {
  readonly grant: ByosGrant;
  readonly accountLabel?: string;
}

/**
 * `begin`'s answer. The device variant carries `deviceCode` for the link-state store to keep
 * server-side; the controller never returns it (contracts § 1 only has the user code).
 */
export type BeginLink =
  | { readonly kind: 'redirect'; readonly url: string }
  | {
      readonly kind: 'device';
      readonly deviceCode: string;
      readonly userCode: string;
      readonly verificationUri: string;
      readonly expiresAt: Date;
      readonly intervalSeconds: number;
    };

export interface ExchangePending {
  readonly pending: true;
  readonly retryAfterSeconds: number;
}

export interface SubscriptionClient {
  /** Async, unlike contracts § 5's sketch: a device-flow `begin` is a provider call (RFC 8628). */
  begin(input: { state: string; codeChallenge: string; redirectUri: string }): Promise<BeginLink>;
  /** A code (redirect flow) or a device code (device flow); throws `SubscriptionFailure`. */
  exchange(input: {
    code?: string;
    deviceCode?: string;
    state: string;
    verifier: string;
    redirectUri: string;
  }): Promise<GrantResult | ExchangePending>;
  /**
   * Throws `SubscriptionFailure('rejected' | 'unreachable')`. The label is optional: a refresh
   * answer often omits it, and the stored label stands.
   */
  refresh(refreshToken: string): Promise<RefreshResult>;
  revoke?(refreshToken: string): Promise<void>;
}

export type SubscriptionFailureKind = 'rejected' | 'unreachable' | 'denied';

/**
 * A classified provider failure. The message names the kind only: a provider's error body can
 * echo the request (§05), so it is never carried.
 */
export class SubscriptionFailure extends Error {
  constructor(readonly kind: SubscriptionFailureKind) {
    super(`Subscription provider call failed: ${kind}`);
    this.name = 'SubscriptionFailure';
  }
}

/** The configured clients, keyed by provider; a provider with no client is not offered (R12). */
export type SubscriptionClients = Partial<Record<LlmProviderName, SubscriptionClient>>;

export const SUBSCRIPTION_CLIENTS = Symbol('forge.agent.byos.subscription-clients');
