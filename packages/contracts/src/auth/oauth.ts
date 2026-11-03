import { z } from 'zod';

/**
 * Criterion 9's two routes, and the vocabulary both ends need to talk about them.
 *
 * Neither route answers with JSON on the happy path — the start is a `302` to the provider and the
 * callback is a `302` back into the app once the session cookie is written — so what this slice
 * publishes is deliberately not a pair of response schemas. It is the provider vocabulary, the
 * shapes the *inbound* halves are validated against, and the one path the client builds a sign-in
 * link from. The failure shapes are already published: every refusal on either route is an RFC 9457
 * document carrying one of the `oauth-*` slugs in `../common/problem-detail`.
 */

/**
 * The providers §11 names, in the order `oauth_provider` declares them.
 *
 * The same two strings as the database enum and as `oauth_identities.provider`, and the reason they
 * are published rather than kept server-side is the sign-in button: a client that hardcodes
 * `'github'` is a client that keeps working after the provider is disabled and starts a flow that
 * cannot complete. Reading the vocabulary from the contract means a third provider is a version
 * bump on both sides rather than a string someone remembered to add in two places.
 */
export const OAUTH_PROVIDERS = ['github', 'google'] as const;

export type OauthProvider = (typeof OAUTH_PROVIDERS)[number];

export const oauthProviderSchema = z.enum(OAUTH_PROVIDERS);

/**
 * Ceilings on the two values that arrive from outside, and the only reason they exist is that both
 * are attacker-controlled in the literal sense: a `code` and a `state` reach us in a URL somebody
 * else composed, and neither has a length the specification bounds.
 *
 * Generous rather than tight. A provider is free to make its authorization codes long — Google's
 * are already several hundred characters — and a limit chosen to fit today's format is a sign-in
 * that breaks on a provider's release note. What these stop is the megabyte of query string that
 * would otherwise be hashed, logged and looked up before anything decided it was nonsense.
 */
export const OAUTH_CODE_MAX_LENGTH = 4_096;
export const OAUTH_STATE_MAX_LENGTH = 256;

/** The provider named in the path of both routes. Strict: `/auth/oauth/gihtub` is a 422, not a 404. */
export const oauthProviderParamsSchema = z.strictObject({
  provider: oauthProviderSchema,
});

export type OauthProviderParams = z.output<typeof oauthProviderParamsSchema>;

/**
 * What the provider sends the browser back to `/auth/oauth/:provider/callback` with.
 *
 * A **loose** object, and the only loose request schema in the package. Every other inbound shape is
 * strict because we own both ends of it; this one is composed by GitHub and Google, who add members
 * on their own schedule — Google alone sends `scope`, `authuser`, `prompt` and sometimes `hd`, none
 * of which we asked for. A strict schema here would turn each of those into a `422` on a sign-in
 * that was otherwise about to succeed, which is the failure mode of validating somebody else's
 * document against our idea of it. Unknown members are dropped by the parse and never reach a
 * handler.
 *
 * Everything is optional because every member is genuinely absent on some real arrival: a user who
 * clicks "Cancel" at the provider comes back with `error` and `state` and no `code`, and a request
 * that reaches this path with nothing at all is a bare navigation, which the `oauth-state-invalid`
 * slug already has an answer for. Making `state` required would answer that navigation with a `422`
 * whose `errors` array names the parameter an attacker would then know to supply.
 */
export const oauthCallbackQuerySchema = z.looseObject({
  code: z
    .string()
    .min(1)
    .max(OAUTH_CODE_MAX_LENGTH)
    .optional()
    .meta({ description: 'The single-use authorization code. Never logged, never stored.' }),
  error: z
    .string()
    .min(1)
    .max(OAUTH_STATE_MAX_LENGTH)
    .optional()
    .meta({ description: 'RFC 6749 §4.1.2.1, when the provider refused rather than redirected.' }),
  state: z
    .string()
    .min(1)
    .max(OAUTH_STATE_MAX_LENGTH)
    .optional()
    .meta({ description: 'The opaque single-use value the start route minted.' }),
});

export type OauthCallbackQuery = z.output<typeof oauthCallbackQuerySchema>;

/**
 * The path a "Sign in with GitHub" link points at, relative to the API's versioned base.
 *
 * A function rather than a template the client assembles, so the one place the route is spelled is
 * this package. The link is an ordinary top-level navigation — no `fetch`, no CSRF pair, no
 * `Authorization` header — because the response is a redirect to a third party and an
 * XHR cannot follow one to another origin.
 */
export function oauthStartPath(provider: OauthProvider): string {
  return `/auth/oauth/${provider}`;
}
