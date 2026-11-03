import type { ByosClientConfig } from './byos-config';
import {
  emailClaim,
  type GenericOAuthOptions,
  GenericOAuthSubscription,
} from './generic-oauth.subscription';

/**
 * OpenAI's subscription client (spec 032 T059). OpenAI's sign-in is the standard code grant with
 * PKCE, so the generic client carries it whole: every endpoint, the client id and the scopes come
 * from `BYOS_OPENAI_*`, the account label is the `id_token`'s `email` claim, and a `401` or
 * `invalid_grant` is `rejected`. The `x-ratelimit-reset-*` side lives in `openai.adapter.ts`.
 */
export function openAiSubscription(
  config: ByosClientConfig,
  options: Omit<GenericOAuthOptions, 'accountLabel'> = {},
): GenericOAuthSubscription {
  return new GenericOAuthSubscription(config, { ...options, accountLabel: emailClaim });
}
