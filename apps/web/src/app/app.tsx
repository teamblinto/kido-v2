import { Navigate, Route, Routes, useLocation } from 'react-router-dom';

import { ConfirmEmailPage } from '@/features/auth/pages/confirm-email-page';
import { EmailVerifiedPage } from '@/features/auth/pages/email-verified-page';
import { ForgotPasswordPage } from '@/features/auth/pages/forgot-password-page';
import { NewPasswordPage } from '@/features/auth/pages/new-password-page';
import { ResetLinkSentPage } from '@/features/auth/pages/reset-link-sent-page';
import { SignInPage } from '@/features/auth/pages/sign-in-page';
import { SignUpPage } from '@/features/auth/pages/sign-up-page';
import { TwoFactorPage } from '@/features/auth/pages/two-factor-page';
import { UnverifiedEmailPage } from '@/features/auth/pages/unverified-email-page';
import { VerifyEmailPage } from '@/features/auth/pages/verify-email-page';
import { RequireAnon, RequireAuth } from '@/features/auth/session/route-guards';
import { ProjectPage } from '@/features/project/pages/project-page';
import { WorkspaceHomePage } from '@/features/workspace/pages/workspace-home-page';
import { routes } from '@/lib/routes';
import { AccountSettingsPage } from '@/pages/account-settings-page';
import { ConnectedAccountCallbackPage } from '@/pages/connected-account-callback-page';
import { ConnectorsSettingsPage } from '@/pages/connectors-settings-page';
import { ProjectNewImportPage } from '@/pages/project-new-import';
import { GithubCallbackPage } from '@/pages/github-callback-page';
import { SupabaseCallbackPage } from '@/pages/supabase-callback-page';
import { InvitationAcceptPage } from '@/pages/invitation-accept-page';
import { MembersSettingsPage } from '@/pages/members-settings-page';
import { NotFoundPage } from '@/pages/not-found-page';
import { PreviewAuthorizePage } from '@/pages/preview-authorize-page';
import { ProjectInvitationAcceptPage } from '@/pages/project-invitation-accept-page';
import { WebhooksSettingsPage } from '@/pages/webhooks-settings-page';

export function App(): React.JSX.Element {
  return (
    <Routes>
      {/* Behind the sign-in wall. */}
      <Route
        path={routes.home}
        element={
          <RequireAuth>
            <WorkspaceHomePage />
          </RequireAuth>
        }
      />
      {/* Before `routes.project`: `/projects/new/import` is not a project id (spec 026). */}
      <Route
        path={routes.projectNewImport}
        element={
          <RequireAuth>
            <ProjectNewImportPage />
          </RequireAuth>
        }
      />
      <Route
        path={routes.project}
        element={
          <RequireAuth>
            <ProjectPage />
          </RequireAuth>
        }
      />
      <Route
        path={routes.connectorsSettings}
        element={
          <RequireAuth>
            <ConnectorsSettingsPage />
          </RequireAuth>
        }
      />
      <Route
        path={routes.webhooksSettings}
        element={
          <RequireAuth>
            <WebhooksSettingsPage />
          </RequireAuth>
        }
      />
      <Route
        path={routes.membersSettings}
        element={
          <RequireAuth>
            <MembersSettingsPage />
          </RequireAuth>
        }
      />
      <Route
        path={routes.accountSettings}
        element={
          <RequireAuth>
            <AccountSettingsPage />
          </RequireAuth>
        }
      />
      {/* A subscription provider's OAuth redirect (spec 032): the state is bound to the session. */}
      <Route
        path={routes.connectedAccountCallback}
        element={
          <RequireAuth>
            <ConnectedAccountCallbackPage />
          </RequireAuth>
        }
      />
      {/* GitHub's Setup URL (spec 018): the install state is bound to the user who started it. */}
      <Route
        path={routes.githubCallback}
        element={
          <RequireAuth>
            <GithubCallbackPage />
          </RequireAuth>
        }
      />

      {/* Supabase's OAuth redirect (spec 030): the state is bound to the user who started it. */}
      <Route
        path={routes.supabaseCallback}
        element={
          <RequireAuth>
            <SupabaseCallbackPage />
          </RequireAuth>
        }
      />

      {/* Only for a caller with no session — signing in again would rotate a perfectly good one. */}
      <Route
        path={routes.signUp}
        element={
          <RequireAnon>
            <SignUpPage />
          </RequireAnon>
        }
      />
      <Route
        path={routes.signIn}
        element={
          <RequireAnon>
            <SignInPage />
          </RequireAnon>
        }
      />

      {/*
        Ungated, all of them, and each for its own reason.

        The MFA challenge runs on a session that exists but is refused by `SessionGuard` until the
        second factor lands, so neither gate describes it. The verification and reset screens are
        reached from a mailed link, which is routinely opened in a browser holding no session at all
        — and the API marks both `@Public()` for exactly that reason.
      */}
      <Route path={routes.twoFactor} element={<TwoFactorPage />} />
      <Route path={routes.unverifiedEmail} element={<UnverifiedEmailPage />} />
      <Route path={routes.verifyEmail} element={<VerifyEmailPage />} />
      <Route path={routes.confirmEmail} element={<ConfirmEmailPage />} />
      <Route path={routes.emailVerified} element={<EmailVerifiedPage />} />
      <Route path={routes.forgotPassword} element={<ForgotPasswordPage />} />
      <Route path={routes.resetLinkSent} element={<ResetLinkSentPage />} />
      <Route path={routes.newPassword} element={<NewPasswordPage />} />

      {/*
        The "you already have an account" mail points at `APP_URL/auth/login` (T13). That mail is
        triggered by a stranger typing somebody's address into the signup form, so it deliberately
        carries no token — it just needs to land somewhere real. Its `?next=` (spec 031, R7) is kept.
      */}
      <Route path={routes.signInAlias} element={<SignInAlias />} />

      {/*
        Ungated: the gateway bounces a browser here whether or not it holds a session, and the
        page itself sends a signed-out visitor to sign in with this address as the way back.
      */}
      <Route path={routes.previewAuthorize} element={<PreviewAuthorizePage />} />
      {/* Signs a visitor in (or up) and back here itself, as the preview page does (spec 031). */}
      <Route path={routes.projectInvitationAccept} element={<ProjectInvitationAcceptPage />} />
      <Route path={routes.invitationAccept} element={<InvitationAcceptPage />} />

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}

/** `/auth/login` → sign-in, keeping the query: the mailed `?next=` return address rides on it. */
function SignInAlias(): React.JSX.Element {
  const { search } = useLocation();

  return <Navigate to={`${routes.signIn}${search}`} replace />;
}
