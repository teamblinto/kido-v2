import { PROBLEM_TYPE_BASE_URI, type ProblemTypeSlug, problemTypeUri } from '@repo/contracts';

/**
 * The slug vocabulary and the URI it expands into are published by `@repo/contracts` (ADR 010), so
 * a client can branch on the class of failure without hardcoding a string. They are re-exported
 * here because this module is where the server has always looked for them.
 */
export { PROBLEM_TYPE_BASE_URI, type ProblemTypeSlug, problemTypeUri };

/**
 * The single catalogue of RFC 9457 `type` slugs the API is allowed to emit, and the HTTP status
 * each one answers with.
 *
 * It is frozen and closed, and the `satisfies` clause is applied to the literal rather than to the
 * `Object.freeze` call so that excess-property checking applies too: a slug the contract does not
 * publish, and a published slug this catalogue forgets, are both compile errors. Statuses are
 * unique per status-owning slug, which is what makes `problemTypeForStatus` unambiguous â€” and is
 * why `validation-failed` cannot be moved onto 400 alongside `bad-request` (ADR 006). A slug that
 * sets {@link ProblemType.refines} shares its parent's status instead of claiming one.
 */
export interface ProblemType {
  /**
   * Set when this slug is a domain-specific refinement of a broader one that owns the status — three
   * different reasons to reject a password are all 422s, and a client that only knows
   * `validation-failed` should still be able to place them. A refinement shares its parent's status
   * and is never the answer `problemTypeForStatus` gives, which is what keeps that lookup single
   * valued. Typed as `string` rather than `ProblemTypeSlug` because a refinement is a server-side
   * relationship between two catalogued slugs, and `@repo/contracts` publishes the vocabulary
   * without it; `problem-types.spec.ts` asserts every value is a catalogued, status-owning slug.
   */
  readonly refines?: string;
  readonly status: number;
  readonly title: string;
}

export const PROBLEM_TYPES = Object.freeze({
  'bad-gateway': { status: 502, title: 'Bad Gateway' },
  'bad-request': { status: 400, title: 'Bad Request' },
  conflict: { status: 409, title: 'Conflict' },
  // Criterion 15, and a 403 refinement rather than a status of its own: to HTTP this is "we
  // understood you and will not do it", which is what `forbidden` already means. What the
  // refinement buys is a client that can tell a missing CSRF pair from a missing permission and
  // retry the one of those that retrying fixes. Not a 401: the caller's session, if they have one,
  // is perfectly good, and signing them out over a stripped header would be a lost form.
  'csrf-check-failed': { refines: 'forbidden', status: 403, title: 'CSRF Check Failed' },
  // A 403 refinement, not a 401. The caller *is* authenticated — the guard let them through — and
  // answering 401 would tell every client that its session had died, which is a signed-out user and
  // a lost form for somebody who simply mistyped their old password. `forbidden` is the honest
  // parent: we understood the request and will not perform it without the second proof.
  'current-password-incorrect': {
    refines: 'forbidden',
    status: 403,
    title: 'Current Password Incorrect',
  },
  // A refinement of `forbidden` rather than a status of its own: it is a 403, and a client that
  // only knows `forbidden` should still place it. What the refinement buys is that a client that
  // does know it can offer "resend the verification mail" instead of "ask an administrator".
  'email-not-verified': {
    refines: 'forbidden',
    status: 403,
    title: 'Email Address Not Verified',
  },
  forbidden: { status: 403, title: 'Forbidden' },
  'gateway-timeout': { status: 504, title: 'Gateway Timeout' },
  gone: { status: 410, title: 'Gone' },
  // §14's `Idempotency-Key` fails in two ways a client acts on differently, and both are 409s: the
  // key names a different request (fix the client), or the request it names is still running (retry
  // the same key). Refinements of `conflict`, so a client that only knows `conflict` still places
  // them, and `problemTypeForStatus(409)` keeps its single answer.
  'idempotency-key-in-flight': {
    refines: 'conflict',
    status: 409,
    title: 'Idempotency Key Still In Flight',
  },
  'idempotency-key-reused': {
    refines: 'conflict',
    status: 409,
    title: 'Idempotency Key Reused for a Different Request',
  },
  // Spec 026's three import refusals, all refinements rather than statuses of their own: two are
  // 409s (the branch is there and has nothing to import, or has too much) and one is a 404 (the
  // branch went away between inspect and start). A client that only knows `conflict` and
  // `not-found` still places them; one that knows these can name the limit or offer another branch.
  'import-branch-not-found': {
    refines: 'not-found',
    status: 404,
    title: 'Import Branch Not Found',
  },
  'import-empty-repo': { refines: 'conflict', status: 409, title: 'Repository Has No Commits' },
  'import-repo-too-large': { refines: 'conflict', status: 409, title: 'Repository Too Large' },
  'internal-server-error': { status: 500, title: 'Internal Server Error' },
  // Spec 040's five refusals, all refinements. Offline and provider-unavailable are 409s: the
  // request is fine and the device's present state refuses it — not 503, which would claim our
  // outage over a laptop that is asleep. An unknown workspace is a 404 of the id it named. A dead
  // pairing code is a 400 for `oauth-state-invalid`'s reason, collapsing unknown, expired and
  // spent into one. A revoked device token is the 401 the companion re-pairs on (§ 6).
  'local-agent-offline': { refines: 'conflict', status: 409, title: 'Local Agent Offline' },
  'local-agent-pairing-invalid': {
    refines: 'bad-request',
    status: 400,
    title: 'Pairing Code Not Recognised',
  },
  'local-agent-provider-unavailable': {
    refines: 'conflict',
    status: 409,
    title: 'Local Agent Provider Unavailable',
  },
  'local-agent-revoked': { refines: 'unauthorized', status: 401, title: 'Local Agent Revoked' },
  'local-agent-workspace-unknown': {
    refines: 'not-found',
    status: 404,
    title: 'Local Agent Workspace Unknown',
  },
  'method-not-allowed': { status: 405, title: 'Method Not Allowed' },
  // A 403 refinement, and `forbidden` rather than `unauthorized` for the same reason
  // `current-password-incorrect` is: the caller's session is perfectly good — the guard let them
  // through — and a 401 would tell every client its session had died over a mistyped code.
  'mfa-code-incorrect': { refines: 'forbidden', status: 403, title: 'Multi-Factor Code Incorrect' },
  'not-acceptable': { status: 406, title: 'Not Acceptable' },
  'not-found': { status: 404, title: 'Not Found' },
  'not-implemented': { status: 501, title: 'Not Implemented' },
  // A 409 refinement. The provider identity is genuine and the caller proved control of the address
  // — this is not a security refusal, it is two accounts wanting the same edge — so `conflict` is
  // the honest parent and the refinement is what lets a client say which GitHub account to use.
  'oauth-account-already-linked': {
    refines: 'conflict',
    status: 409,
    title: 'Account Already Linked to This Provider',
  },
  // A 403 refinement rather than a 400. The request was perfectly well formed and we will not
  // complete it, which is what `forbidden` means; the user is not signed in, so `unauthorized`
  // would be a claim about a session that does not exist.
  'oauth-authorization-denied': {
    refines: 'forbidden',
    status: 403,
    title: 'Authorization Declined at the Provider',
  },
  // A 403 refinement for the same reason: the flow completed, the provider answered, and we are
  // declining to link on what it said. Not a 422 — nothing about the *request* is invalid, and a
  // client that reported field errors here would be pointing the user at a form they never filled.
  'oauth-email-unverified': {
    refines: 'forbidden',
    status: 403,
    title: 'Provider Has Not Verified This Email Address',
  },
  // A 502 refinement, because that is what it is: an upstream we depend on did not answer usefully.
  // The refinement buys a client that can say "GitHub, not us" instead of a generic gateway error.
  'oauth-exchange-failed': {
    refines: 'bad-gateway',
    status: 502,
    title: 'Provider Token Exchange Failed',
  },
  // A 501 refinement, and the status is the whole argument for the design the task asks for. The
  // routes stay mounted when the provider is unconfigured and answer this: 404 would be
  // indistinguishable from a deploy that lost the router, 500 would page somebody over a
  // deliberate choice, and 503 would claim a transient outage that no amount of waiting fixes.
  // 501 says exactly the true thing — this deployment does not implement sign-in with this
  // provider — and `ProblemDetailsFilter` sends `Cache-Control: no-store` on every problem
  // document, so the answer does not outlive the configuration change that repairs it.
  'oauth-provider-not-configured': {
    refines: 'not-implemented',
    status: 501,
    title: 'OAuth Provider Not Configured',
  },
  // A 400 refinement, alongside the three token slugs below and for the same reason: the value
  // presented will not work, and to HTTP that is one thing. Not a 403, which would imply we know
  // whose flow this was and are refusing it — the point of a state we cannot resolve is that we
  // know nothing about the caller at all.
  'oauth-state-invalid': {
    refines: 'bad-request',
    status: 400,
    title: 'OAuth State Not Recognised',
  },
  // §11 rejects a password for three different reasons and a user can only act on the difference:
  // choose a longer one, choose a different one, stop using your own name. One slug for all three
  // would push that distinction into prose, where no client can branch on it.
  'password-breached': {
    refines: 'validation-failed',
    status: 422,
    title: 'Password Found in a Breach Corpus',
  },
  'password-too-weak': { refines: 'validation-failed', status: 422, title: 'Password Too Weak' },
  'password-uses-personal-information': {
    refines: 'validation-failed',
    status: 422,
    title: 'Password Uses Personal Information',
  },
  'payload-too-large': { status: 413, title: 'Payload Too Large' },
  // Criterion 11, and a `forbidden` refinement for the same reason `csrf-check-failed` and
  // `step-up-required` are: to HTTP all three are "we understood you and will not do it", and a
  // client that only knows `forbidden` should still place this one. What the refinement buys is the
  // ability to tell the one 403 that retrying cannot fix from the two that it can — this is the one
  // where the remedy is "ask an administrator", not "read the cookie again" or "type your code".
  'permission-denied': { refines: 'forbidden', status: 403, title: 'Permission Denied' },
  'rate-limited': { status: 429, title: 'Too Many Requests' },
  'request-timeout': { status: 408, title: 'Request Timeout' },
  'service-unavailable': { status: 503, title: 'Service Unavailable' },
  // Criterion 12. A refinement of `forbidden` rather than a status of its own — it is a 403, and a
  // client that only knows `forbidden` should still place it. What the refinement buys is that a
  // client which does know it can prompt for a code and retry the same request, instead of telling
  // the user to ask an administrator for a permission they already have.
  'step-up-required': {
    refines: 'forbidden',
    status: 403,
    title: 'Step-Up Authentication Required',
  },
  // Spec 041. Not connected is the person's present state refusing a fine request (409, like
  // `local-agent-offline`); unavailable is the deployment's (feature off, template unpublished).
  'subscription-not-connected': {
    refines: 'conflict',
    status: 409,
    title: 'Subscription Not Connected',
  },
  'subscription-unavailable': {
    refines: 'service-unavailable',
    status: 503,
    title: 'Subscription Unavailable',
  },
  // The three ways a single-use link is dead (T14, criterion 2), shared by password reset and
  // invitations once those land. All three are 400 refinements rather than statuses of their own:
  // to HTTP they are one thing — the token presented will not work — and 410 was rejected because
  // intermediaries cache it, which is a link that stays broken after a resend fixes it.
  'token-already-used': { refines: 'bad-request', status: 400, title: 'Token Already Used' },
  'token-expired': { refines: 'bad-request', status: 400, title: 'Token Expired' },
  'token-invalid': { refines: 'bad-request', status: 400, title: 'Token Not Recognised' },
  // A 403 refinement, exactly as `csrf-check-failed` is and for the same reasons. To HTTP this is
  // "we understood you and will not do it": the request is well formed, so a 422 would point a
  // human at a form field they never filled, and there is no session to invalidate, so a 401 would
  // be a claim about a credential the caller was never asked for. `forbidden` is the honest parent
  // and the refinement is what lets a client re-render the widget instead of giving up.
  'turnstile-check-failed': { refines: 'forbidden', status: 403, title: 'Turnstile Check Failed' },
  unauthorized: { status: 401, title: 'Unauthorized' },
  'unsupported-media-type': { status: 415, title: 'Unsupported Media Type' },
  'validation-failed': { status: 422, title: 'Validation Failed' },
  // Deliberately not `token-invalid`. The link was real and was copied correctly; the address it
  // proves control of is simply no longer this account's, so the remedy is the new mailbox rather
  // than the old link.
  'verification-address-changed': {
    refines: 'bad-request',
    status: 400,
    title: 'Address Changed Since the Link Was Sent',
  },
} as const satisfies Readonly<Record<ProblemTypeSlug, ProblemType>>);

/** The slug the generic, non-leaking fallback uses when nothing else applies. */
export const FALLBACK_PROBLEM_TYPE = 'internal-server-error' satisfies ProblemTypeSlug;

const SLUG_BY_STATUS = new Map<number, ProblemTypeSlug>(
  (Object.entries(PROBLEM_TYPES) as [ProblemTypeSlug, ProblemType][])
    // Refinements share a status with the slug they refine, so they are not candidates: a framework
    // 422 means "the body did not validate", never "this password was in a breach corpus".
    .filter(([, definition]) => definition.refines === undefined)
    .map(([slug, definition]) => [definition.status, slug]),
);

/**
 * Resolve the slug a framework-thrown HTTP status belongs to. Returns `undefined` for a status the
 * catalogue makes no promise about, so the caller degrades deliberately instead of inventing a slug.
 */
export function problemTypeForStatus(status: number): ProblemTypeSlug | undefined {
  return SLUG_BY_STATUS.get(status);
}
