import { z } from 'zod';

/**
 * ADR 010: the `type` member on the wire is `PROBLEM_TYPE_BASE_URI + slug`, and the base is a
 * compile-time constant rather than configuration — two deployments of the same code must not
 * report different `type` values for the same failure.
 */
export const PROBLEM_TYPE_BASE_URI = 'https://forge.dev/problems/';

/**
 * The closed vocabulary of failure classes the API is allowed to report. This is the *shared* half
 * of the catalogue: the client needs the slugs so it can branch on the class of failure, and it has
 * no use for the HTTP status each one maps to — that mapping is the server's, and lives in
 * `apps/api/src/common/errors/problem-types.ts`, which is checked against this list at compile time.
 */
export const PROBLEM_TYPE_SLUGS = [
  // Spec 048: an attachment id on a run that is not this project's (or is gone), a file whose type
  // is not allowed or whose bytes disagree with its extension, and a file past its kind's cap.
  'attachment-not-found',
  'attachment-rejected',
  'attachment-too-large',
  'bad-gateway',
  'bad-request',
  'conflict',
  // Criterion 15: an unsafe request that did not present a valid double-submit token *and* an
  // allowed `Origin`. One slug for both halves on purpose — telling a caller which of the two it
  // failed is telling an attacker which one to work on, and the client's remedy is the same either
  // way: read the CSRF cookie, echo it in the header, and send the request from the app's own
  // origin. Deliberately not `forbidden` alone, because a client that knows this slug can retry
  // after re-reading the cookie instead of telling the user they lack a permission they have.
  'csrf-check-failed',
  // The re-authentication a sensitive change asks for, failed (T19, and criterion 12's step-up).
  // Deliberately not `unauthorized`: the session is perfectly good and the client must not react by
  // signing the user out and throwing away the form they were filling in. What failed is the second
  // proof, and the remedy is to type the password again.
  'current-password-incorrect',
  // §11: an account is usable the moment it is created but cannot create sandboxes until its
  // address is confirmed. A bare `forbidden` would leave the client unable to tell "you are not
  // allowed to do this" from "you are, once you click the link in your mail" — and only the second
  // has an action the user can take.
  'email-not-verified',
  'forbidden',
  'gateway-timeout',
  'gone',
  // Two ways an `Idempotency-Key` fails, and a client acts on the difference: one says "your key
  // means a different request, generate a new one", the other says "retry, it is still running".
  // A bare `conflict` for both would leave the client unable to tell a bug from a race.
  'idempotency-key-in-flight',
  'idempotency-key-reused',
  // Spec 026, contracts § 2: the three ways starting an import is refused, and three rather than
  // one because the remedies differ and only the user can apply them — push a first commit, import
  // something smaller, or pick a branch that still exists. A bare `conflict` would flatten all
  // three into "that did not work", which is the sentence FR-021 exists to avoid.
  'import-branch-not-found',
  'import-empty-repo',
  'import-repo-too-large',
  'internal-server-error',
  // Spec 040 § 6: the runner's device token is unknown, malformed or revoked; it stops.
  'local-agent-revoked',
  // Spec 046: an MCP client's authorization request names an unknown client, a redirect URI it did
  // not register, or a resource this server is not. Never redirected back: RFC 6749 §4.1.2.1 forbids
  // sending a browser to a redirect URI that has not been verified.
  'mcp-authorization-invalid',
  'method-not-allowed',
  // The second factor was presented and was wrong, on a route whose caller already holds a good
  // session — confirming an enrolment (T20), or stepping up (T21). Deliberately not `unauthorized`,
  // for the same reason `current-password-incorrect` is not: the session is fine, and a client that
  // signed the user out over a mistyped code would throw away the page they were on. The login
  // *challenge* does not use this — a failure there is a plain `unauthorized`, because telling
  // "wrong code" from "wrong password" before a session exists is an oracle, not a courtesy.
  'mfa-code-incorrect',
  'not-acceptable',
  'not-found',
  'not-implemented',
  // Criterion 9's five refusals, and they are five because a signed-out person staring at a failed
  // "Sign in with GitHub" can act on the difference between every pair of them.
  //
  // The provider identity is real and is already linked to *another* local account — or, more
  // precisely, this account already federates to a different account at this provider, which the
  // `unique (user_id, provider)` constraint is what makes true. The remedy is the other GitHub
  // account, or unlinking; a bare `conflict` would leave the client unable to say either.
  'oauth-account-already-linked',
  // The provider told us the user declined — RFC 6749's `access_denied`, which is what the "Cancel"
  // button sends. An ordinary outcome rather than a fault, and deliberately distinguished from
  // `oauth-exchange-failed`: "you said no" is retried by clicking again, and "the provider is
  // unreachable" is retried later or not at all.
  'oauth-authorization-denied',
  // The security property success criterion 9 is written around, as a failure a client can explain.
  // The provider named an address it has *not* verified, or named none, and an account is never
  // linked on one: anybody who can register that address at the provider could otherwise take over
  // the local account that already holds it. The remedy is at the provider, not here, which is
  // exactly what a bare `forbidden` would fail to communicate.
  'oauth-email-unverified',
  // The token or profile call to the provider did not produce an identity: a code the provider
  // refused, a `redirect_uri` that no longer matches the registration, a 500 from the provider, a
  // timeout. One slug for all of them because the caller's remedy is the same — try again, and if
  // it keeps happening it is not their account that is broken.
  'oauth-exchange-failed',
  // The deployment has no client id and secret for this provider (`environment.ts` validates the
  // pair both-or-neither, so "half configured" never reaches here). The routes stay mounted and
  // answer with this, because a route that disappeared would be indistinguishable from a deploy
  // that failed — and a 500 would page somebody over a provider that was deliberately left off.
  'oauth-provider-not-configured',
  // The `state` presented is not one this server minted, is not the one this provider was started
  // with, has expired, or has already been spent. One slug for all four, exactly as
  // `csrf-check-failed` collapses its two halves: telling a caller *which* way their state was
  // wrong tells an attacker which half to work on, and the client's remedy is to start the flow
  // again in every case.
  'oauth-state-invalid',
  // Three ways to reject a password, because a user can only act on the difference between them.
  // All three are 422 refinements of `validation-failed` on the server; that mapping is the
  // server's and stays there, but the vocabulary has to be shared for a client to branch on it.
  'password-breached',
  'password-too-weak',
  'password-uses-personal-information',
  'payload-too-large',
  // Criterion 11's refusal: the caller is signed in, the route was understood, and the permission
  // set resolved for them *in the organisation that owns the resource* does not contain what the
  // route asked for. Deliberately not `unauthorized` — the session is perfectly good, and a client
  // that signed the user out over a permission would throw away a page they are entitled to.
  //
  // A slug of its own rather than a bare `forbidden`, because the three 403s a client can meet on
  // one request have three different remedies: re-read the CSRF cookie and retry, prompt for a
  // second factor and retry, or stop retrying and ask an administrator. Only the last is this one,
  // and it is the only one for which retrying unchanged is guaranteed to fail.
  //
  // What it deliberately does not carry is *which* permission was missing or which resource it was
  // checked against. Naming either would tell a caller who may not see a project that the project
  // exists, which is the disclosure the guard is there to prevent.
  'permission-denied',
  'rate-limited',
  'request-timeout',
  'service-unavailable',
  // Criterion 12: the route needs a *recent* second factor, not merely a session that once had one.
  // A client acts on this specifically — it prompts for a code and retries the same request — which
  // a bare `forbidden` would leave it unable to do, because "you may not" and "you may, once you
  // prove it again" have opposite remedies.
  'step-up-required',
  // Spec 041: a run on the person's own Claude subscription, refused. Not connected (or signed
  // out) is theirs to fix by signing in; unavailable (the feature is off, or the agent-home
  // template is not published) is the operator's, so the person waits rather than retries.
  'subscription-not-connected',
  'subscription-unavailable',
  // Three ways a single-use link is dead, shared by every flow that mints one: email verification
  // (T14), password reset (T19) and invitations (T29). The reader can act on the difference — ask
  // for a new link, sign in because you already used this one, check you copied the whole thing —
  // and a client that only knows `bad-request` still places all three. Generic rather than
  // per-flow because the route already says which flow it was; `token-expired` on `/auth/verify`
  // needs no further qualification.
  'token-already-used',
  'token-expired',
  'token-invalid',
  // §03 puts the Turnstile *challenge* at the Cloudflare edge; this is the server-side verification
  // of the token that challenge produced, and it failed. One slug for every caller-side way it can
  // fail — absent, malformed, expired, already spent, or minted for another site — for the reason
  // `csrf-check-failed` collapses its two halves: telling a caller which way their token was wrong
  // tells an automated one which half to work on, and the remedy is the same in all five cases,
  // namely solve the widget again and resend. Deliberately not `forbidden` alone, because a client
  // that knows this slug can re-render the widget rather than tell a human to ask an administrator.
  //
  // It is not the slug for "we could not reach the verifier" — that is a `service-unavailable`, and
  // the difference matters to a client: one is retried after a fresh challenge, the other after a
  // wait, with the same challenge and no user action at all.
  'turnstile-check-failed',
  'unauthorized',
  'unsupported-media-type',
  'validation-failed',
  // Criterion 2's other half: an address change invalidates an outstanding verification link. Not
  // one of the three above — the link was real and was copied correctly — and the only one whose
  // remedy is "look in the other mailbox".
  'verification-address-changed',
] as const;

export type ProblemTypeSlug = (typeof PROBLEM_TYPE_SLUGS)[number];

export const problemTypeSlugSchema = z.enum(PROBLEM_TYPE_SLUGS);

/** Expand a slug into the absolute URI clients match on. */
export function problemTypeUri(slug: ProblemTypeSlug): string {
  return `${PROBLEM_TYPE_BASE_URI}${slug}`;
}

/**
 * The inverse, for a client holding a parsed document. Returns `undefined` for a `type` this
 * version of the contract does not know, so a client that meets a newer server degrades to its
 * generic branch instead of throwing.
 */
export function problemTypeSlugFromUri(type: string): ProblemTypeSlug | undefined {
  if (!type.startsWith(PROBLEM_TYPE_BASE_URI)) {
    return undefined;
  }

  const parsed = problemTypeSlugSchema.safeParse(type.slice(PROBLEM_TYPE_BASE_URI.length));

  return parsed.success ? parsed.data : undefined;
}

/**
 * One rejected field. The shape is the `errors` extension member RFC 9457 §3 uses in its own
 * example: a `pointer` naming the location and a human-readable `detail`. `code` is ours, and is
 * the part a client should branch on — the same reason `type` is a slug rather than a message.
 */
export const validationIssueSchema = z.object({
  code: z.string().min(1),
  detail: z.string().min(1),
  pointer: z.string().min(1),
});

export type ValidationIssue = z.output<typeof validationIssueSchema>;

/**
 * The wire shape of every error response. Loose, because RFC 9457 extension members are the
 * mechanism by which a specific failure says more than its class — `retryAfter` on a throttle,
 * `errors` on a rejected body — and a strict schema would strip exactly the part the client needs.
 */
export const problemDetailSchema = z.looseObject({
  detail: z.string().min(1),
  errors: z.array(validationIssueSchema).optional(),
  instance: z.string().min(1),
  requestId: z.string().min(1),
  status: z.int().min(400).max(599),
  title: z.string().min(1),
  type: z.url(),
});

export type ProblemDetail = z.output<typeof problemDetailSchema>;
