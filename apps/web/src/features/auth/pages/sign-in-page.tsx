import { type OauthProvider, loginRequestSchema } from '@repo/contracts';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Loader2, Mail, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ApiProblem, messageFor } from '@/lib/api/problem';
import { routes } from '@/lib/routes';
import { oauthStartUrl, signIn } from '../api';
import { AuthHeading } from '../components/auth-heading';
import { AuthLayout } from '../components/auth-layout';
import { AuthLink } from '../components/auth-link';
import { FinePrint } from '../components/fine-print';
import { OrDivider } from '../components/or-divider';
import { PasswordField } from '../components/password-field';
import { SocialAuthButtons } from '../components/social-auth-buttons';
import { TextField } from '../components/text-field';
import { destinationAfterSignIn, returnStateOf } from '../session/route-guards';
import { useSession } from '../session/session-context';

/**
 * The one sentence a failed sign-in is allowed to say about credentials.
 *
 * `login.ts` makes the answer identical for a wrong password and an address with no account, in
 * body *and* in timing. A form that distinguished them in its copy would rebuild the enumeration
 * oracle the endpoint spent that effort avoiding.
 */
const CREDENTIALS_REJECTED = 'That email or password is incorrect';

export function SignInPage(): React.JSX.Element {
  const navigate = useNavigate();
  const returnState = returnStateOf(useLocation());
  const { setUser } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [malformed, setMalformed] = useState(false);

  const login = useMutation({
    mutationFn: signIn,
    onSuccess: async (outcome) => {
      // The union's two arms are told apart by which member is present, not by a flag. The
      // `mfa_required` arm carries nothing else on purpose — no account, no challenge id, because
      // the challenge is bound to the cookie this very response set — so nothing is carried over.
      if ('status' in outcome) {
        // The return path rides along: the second factor is still on the way back to it.
        await navigate(routes.twoFactor, { replace: true, state: returnState });

        return;
      }

      setUser(outcome.user);

      // `RequireAnon` reacts to that session too, and may redirect before this lands — it aims at
      // the same place, so whichever navigation wins, the return path holds.
      // §11 makes an unverified account usable but unable to create sandboxes, so this is a detour
      // rather than a wall: the session is real and it stays.
      const destination = outcome.user.emailVerified
        ? destinationAfterSignIn(returnState)
        : routes.unverifiedEmail;

      await navigate(destination, { replace: true });
    },
  });

  const failed = malformed || login.isError;

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    // Parsed against the schema the API validates with, so the form and the server agree on what a
    // well-formed pair is. Whether the pair is *correct* is a question only the server answers.
    const parsed = loginRequestSchema.safeParse({ email, password });

    if (!parsed.success) {
      login.reset();
      setMalformed(true);

      return;
    }

    setMalformed(false);
    login.mutate(parsed.data);
  }

  function startOauth(provider: OauthProvider): void {
    // A full navigation, not a fetch. The route answers 302 to the provider, and an XHR cannot
    // follow a redirect to another origin — the browser has to go there itself.
    window.location.assign(oauthStartUrl(provider));
  }

  return (
    <AuthLayout>
      <AuthHeading title="Welcome back" description="Sign in to pick up where you left off." />

      <div className="mt-7">
        <SocialAuthButtons onProviderSelect={startOauth} />
      </div>

      <OrDivider />

      {failed ? (
        <Alert variant="danger" className="mb-5">
          <AlertTriangle />
          <AlertTitle>{malformed ? CREDENTIALS_REJECTED : signInMessage(login.error)}</AlertTitle>
          <AlertDescription>
            Check for caps lock, or reset your password. Single sign-on is also available above.
          </AlertDescription>
        </Alert>
      ) : null}

      <form onSubmit={handleSubmit} noValidate>
        <div className="flex flex-col gap-4">
          <TextField
            label="Work email"
            icon={Mail}
            type="email"
            name="email"
            autoComplete="email"
            placeholder="you@company.com"
            value={email}
            aria-invalid={failed}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />

          <PasswordField
            name="current-password"
            autoComplete="current-password"
            placeholder="Enter your password"
            value={password}
            aria-invalid={failed}
            labelAction={<AuthLink to={routes.forgotPassword}>Forgot password?</AuthLink>}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
          />
        </div>

        <Button type="submit" className="mt-6 w-full" disabled={login.isPending}>
          {login.isPending ? (
            <>
              <Loader2 className="animate-spin" aria-hidden="true" />
              Signing in
            </>
          ) : (
            <>
              Sign in
              <ArrowRight aria-hidden="true" />
            </>
          )}
        </Button>
      </form>

      <div className="mt-4">
        {/*
          Sign-in is protected by the per-account and per-IP progressive throttle (T16), not by
          Turnstile — `TurnstileGuard` sits on signup and password reset, the two routes that send
          mail to an unproven address. So there is no widget here, and no claim that there is one.
        */}
        <FinePrint icon={ShieldCheck}>Protected by rate limiting and device checks</FinePrint>
      </div>

      <p className="text-body-sm text-subdued mt-[22px]">
        New to BAIOS?{' '}
        <AuthLink to={routes.signUp} state={returnState}>
          Create an account
        </AuthLink>
      </p>
    </AuthLayout>
  );
}

/**
 * What to say about a failed sign-in.
 *
 * `unauthorized` gets {@link CREDENTIALS_REJECTED}, because this is the one endpoint where that
 * slug does not mean "your session ended". Everything else is worth naming — a throttled caller has
 * a remedy, and the credentials sentence would send them looking in the wrong place.
 */
function signInMessage(error: unknown): string {
  if (ApiProblem.is(error, 'unauthorized')) {
    return CREDENTIALS_REJECTED;
  }

  return messageFor(error, CREDENTIALS_REJECTED);
}
