import { isSameOriginRelativePath } from '@repo/contracts';

/**
 * The three links a mail can carry, built in one place.
 *
 * Built here rather than by each caller so the shape is greppable and cannot drift: T13 and T14
 * both mint verification links, T19 mints reset links, T29 mints invitation links, and they are
 * four different sessions. A link the web app does not have a route for is a mail that looks fine
 * in every test and 404s for the user.
 */

/**
 * The query parameter every link carries its token in — and the reason a token is a query
 * parameter rather than a path segment.
 *
 * T09's transport scrubber censors URL credentials **by parameter name**, matching any parameter
 * whose name contains `token`, `secret`, `code`, `key` and so on. pino-http logs `req.url` in full,
 * so a verification link that reaches a log — a proxy access log, a user pasting one into a support
 * ticket, an error report quoting the request line — is a record that scrubber can already clean.
 *
 * `/auth/verify/<token>` is indistinguishable from any other path and would sail straight through
 * it. The URL layout is therefore a security decision, not a routing preference, and changing this
 * constant to something the scrubber's pattern does not match silently disables that protection.
 * `links.spec.ts` asserts the two agree.
 */
export const MAIL_LINK_TOKEN_PARAM = 'token';

/** Confirming an address (T14). */
export function verificationUrl(appUrl: string, token: string, next?: string): string {
  return withNext(linkTo(appUrl, 'auth/verify', token), next);
}

/** Choosing a new password after a reset request (T19). */
export function passwordResetUrl(appUrl: string, token: string): string {
  return linkTo(appUrl, 'auth/password/reset', token);
}

/**
 * The parameter the invitation link carries its organisation in.
 *
 * Deliberately not spelled anything T09's credential pattern matches — `org`, not `org_key` or
 * `org_token`. It is an identifier rather than a secret, and a censored one would arrive as a link
 * the web app cannot act on.
 */
export const MAIL_LINK_ORG_PARAM = 'org';

/**
 * Accepting an invitation to an organisation (T29) — the one tokenised link carrying a second value.
 *
 * Every tenant-owned read runs under row-level security, so acceptance has to open a tenant
 * transaction *before* it can look the invitation up at all — and `ResourceOrgResolver` derives the
 * tenant from a route parameter and nothing else, doing no I/O. `schema/rbac.ts` draws the
 * conclusion: "the invitation link therefore carries the organisation id alongside the token".
 *
 * Handing the organisation to whoever holds the link costs nothing. The id is not the secret — the
 * token is — and knowing one grants no access on its own: a caller with no membership there resolves
 * to the empty permission set, and RLS shows them no rows.
 */
export function invitationUrl(appUrl: string, orgId: string, token: string): string {
  const url = new URL(linkTo(appUrl, 'invitations/accept', token));

  url.searchParams.set(MAIL_LINK_ORG_PARAM, orgId);

  return url.toString();
}

/**
 * Spec 031 (contracts/sharing.md § 7): the project invitation's accept page. The token is a path
 * segment — the web route is `/project-invitations/accept/:token` — and the organisation rides in
 * `?org=` for the reason {@link invitationUrl} gives.
 */
export function projectInvitationUrl(appUrl: string, orgId: string, token: string): string {
  const url = new URL(
    `project-invitations/accept/${encodeURIComponent(token)}`,
    `${appUrl.replace(/\/+$/, '')}/`,
  );

  url.searchParams.set(MAIL_LINK_ORG_PARAM, orgId);

  return url.toString();
}

/**
 * The sign-in page (T13's "account already exists" mail). The one link here that carries no token,
 * and deliberately so.
 *
 * That mail is triggered by an unauthenticated stranger typing an address into a signup form. A
 * tokenised reset link in it would let that stranger cause a live password-reset token to be minted
 * for somebody else's account, on demand, without ever proving anything — turning an
 * enumeration-safety measure into a way to fill a mailbox with real credentials. The mail points at
 * the sign-in page instead, and an owner who has genuinely forgotten their password starts the
 * reset from there, where the request is theirs.
 */
export function signInUrl(appUrl: string, next?: string): string {
  return withNext(new URL('auth/login', `${appUrl.replace(/\/+$/, '')}/`).toString(), next);
}

/** The query parameter a return address rides in (spec 031, research R7). */
export const MAIL_LINK_NEXT_PARAM = 'next';

/**
 * Append a return address — only a same-origin relative path; anything else is dropped here, the
 * last place before a mail, whatever a producer let through.
 */
function withNext(link: string, next: string | undefined): string {
  if (next === undefined || !isSameOriginRelativePath(next)) {
    return link;
  }

  const url = new URL(link);

  url.searchParams.set(MAIL_LINK_NEXT_PARAM, next);

  return url.toString();
}

/**
 * The parameter the project page reads to open a side panel, and the panel a domain notice opens.
 * Not spelled anything T09's credential pattern matches, for the reason `MAIL_LINK_ORG_PARAM` gives.
 */
export const MAIL_LINK_PANEL_PARAM = 'panel';

/**
 * A project's Domains panel (spec 028 research R14): where every custom-domain notice sends its
 * reader to see the records and act on them. No token — the reader signs in as for any page, and
 * the panel sits behind the project's own permission. The project id is a path segment the web
 * route `/projects/:projectId` already has.
 */
export function projectDomainsUrl(appUrl: string, projectId: string): string {
  const url = new URL(
    `projects/${encodeURIComponent(projectId)}`,
    `${appUrl.replace(/\/+$/, '')}/`,
  );

  url.searchParams.set(MAIL_LINK_PANEL_PARAM, 'domains');

  return url.toString();
}

/**
 * The three paths are distinct, which is what stops a token minted for one flow being replayed
 * against another — the route decides which table the token is looked up in. That is a defence in
 * depth rather than the primary one: the tokens themselves are per-purpose rows, and each is hashed
 * at rest and single-use.
 *
 * `URL` does the joining, so a trailing slash on `APP_URL` and a deployment mounted under a path
 * prefix both resolve rather than producing `//auth/verify`. The token goes through
 * `searchParams`, so a token containing `+`, `/` or `=` survives the round trip — base64url avoids
 * those today, but the encoding of a token is not this module's decision to depend on.
 */
function linkTo(appUrl: string, path: string, token: string): string {
  const url = new URL(path, `${appUrl.replace(/\/+$/, '')}/`);

  url.searchParams.set(MAIL_LINK_TOKEN_PARAM, token);

  return url.toString();
}

/** The webhooks settings page (spec 029): where a paused endpoint is re-enabled. No token. */
export function webhooksSettingsUrl(appUrl: string): string {
  return new URL('settings/webhooks', `${appUrl.replace(/\/+$/, '')}/`).toString();
}

/** A person's own account settings page (spec 032): where a linked subscription is reconnected. */
export function accountSettingsUrl(appUrl: string): string {
  return new URL('settings/account', `${appUrl.replace(/\/+$/, '')}/`).toString();
}
