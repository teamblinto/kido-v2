/**
 * Single source of truth for client-side route paths.
 *
 * ## Three of these are not ours to choose
 *
 * `confirmEmail`, `newPassword` and the `/auth/login` alias are the destinations the API mails.
 * `apps/api/src/modules/mail/links.ts` builds them from `APP_URL` — `auth/verify?token=`,
 * `auth/password/reset?token=` and `auth/login` — and warns in as many words that *"a link the web
 * app does not have a route for is a mail that looks fine in every test and 404s for the user"*.
 *
 * They were exactly that until this spec: the app served `/verify-email` and `/reset-password`, so
 * every verification and reset mail led to the not-found page. The app moved rather than the link
 * builder, because the mailed URL is the published contract — old mails are still in inboxes, and
 * the token is a query parameter specifically so T09's log scrubber can censor it by name.
 */
export const routes = {
  /** The person's own settings: connected subscription accounts (spec 032). */
  accountSettings: '/settings/account',
  /** Where a verification mail lands, carrying `?token=`. */
  confirmEmail: '/auth/verify',
  /** A subscription provider's OAuth redirect, carrying `?code=`/`?error=` and `?state=` (spec 032). */
  connectedAccountCallback: '/account/connected-accounts/:provider/callback',
  /** The organisation's connectors (spec 018). */
  connectorsSettings: '/settings/connectors',
  emailVerified: '/verify-email/done',
  forgotPassword: '/forgot-password',
  /** The GitHub App's Setup URL, carrying `?installation_id=` and `?state=` (018 research R8). */
  githubCallback: '/connectors/github/callback',
  home: '/',
  /**
   * Where an organisation invitation mail lands, carrying `?token=` and `?org=` — the API's
   * `invitationUrl` puts the token in the query, unlike {@link routes.projectInvitationAccept}.
   */
  invitationAccept: '/invitations/accept',
  /** The organisation's members, and the invite form (spec 033). */
  membersSettings: '/settings/members',
  /** Where a password-reset mail lands, carrying `?token=`. */
  newPassword: '/auth/password/reset',
  /** Where the preview gateway bounces a non-public preview, carrying `?label=` and `?return=`. */
  previewAuthorize: '/preview-authorize',
  project: '/projects/:projectId',
  /** Where a project invitation mail lands, carrying `?org=` (spec 031, contracts/sharing.md § 7). */
  projectInvitationAccept: '/project-invitations/accept/:token',
  /** Import a GitHub repository into a new project (spec 026 US1). */
  projectNewImport: '/projects/new/import',
  resetLinkSent: '/forgot-password/sent',
  signIn: '/sign-in',
  /** The "you already have an account" mail points here; it redirects to {@link routes.signIn}. */
  signInAlias: '/auth/login',
  signUp: '/sign-up',
  /** Supabase's OAuth redirect, carrying `?code=` and `?state=` (spec 030 research R1). */
  supabaseCallback: '/connectors/supabase/callback',
  twoFactor: '/sign-in/two-factor',
  unverifiedEmail: '/sign-in/verify-email',
  /** The caller's subscription limits and run history (Settings → Usage). */
  usageSettings: '/settings/usage',
  verifyEmail: '/verify-email',
  /** The organisation's outbound webhooks (spec 029). */
  webhooksSettings: '/settings/webhooks',
} as const;

/** Fills in the project route for a given project. */
export function projectPath(projectId: string): string {
  return routes.project.replace(':projectId', encodeURIComponent(projectId));
}
