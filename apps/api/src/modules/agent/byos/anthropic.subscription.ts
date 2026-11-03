import type { ByosClientConfig } from './byos-config';
import {
  emailClaim,
  type GenericOAuthOptions,
  GenericOAuthSubscription,
  type TokenResponse,
} from './generic-oauth.subscription';

/**
 * The token response's own account, `account.email_address`, else the `id_token`'s `email` claim.
 * A display label only, never an identity proof.
 */
export function anthropicAccountLabel(response: TokenResponse): string | undefined {
  const account = response.account as { email_address?: unknown } | undefined;
  const email = account?.email_address;
  return typeof email === 'string' && email !== '' ? email : emailClaim(response);
}

/**
 * Anthropic's subscription client (spec 032 T057): the generic RFC client with Anthropic's account
 * label. Every endpoint, the client id and the scopes come from `BYOS_ANTHROPIC_*`; a `401` or
 * `invalid_grant` is `rejected`. The `anthropic-ratelimit-*-reset` side lives in
 * `anthropic.adapter.ts`.
 */
export function anthropicSubscription(
  config: ByosClientConfig,
  options: Omit<GenericOAuthOptions, 'accountLabel'> = {},
): GenericOAuthSubscription {
  return new GenericOAuthSubscription(config, { ...options, accountLabel: anthropicAccountLabel });
}
