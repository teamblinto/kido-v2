import { type OauthProvider, signupRequestSchema } from '@repo/contracts';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Loader2, Mail, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ApiProblem, messageFor } from '@/lib/api/problem';
import { routes } from '@/lib/routes';
import { oauthStartUrl, signUp } from '../api';
import { AuthHeading } from '../components/auth-heading';
import { AuthLayout } from '../components/auth-layout';
import { AuthLink } from '../components/auth-link';
import { FinePrint } from '../components/fine-print';
import { OrDivider } from '../components/or-divider';
import { PasswordField } from '../components/password-field';
import { PasswordStrengthMeter } from '../components/password-strength-meter';
import { SocialAuthButtons } from '../components/social-auth-buttons';
import { TextField } from '../components/text-field';
import { TurnstileCheck } from '../components/turnstile-check';
import { MINIMUM_PASSWORD_LENGTH, assessPassword } from '../lib/password';
import { nextFromState } from '../session/route-guards';

export function SignUpPage(): React.JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  // Spec 031 (R7): where sign-in would have returned to — a project invitation, say — rides along.
  const next = nextFromState(location.state);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [turnstileToken, setTurnstileToken] = useState<string | undefined>(undefined);
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({});

  const register = useMutation({
    mutationFn: (body: { email: string; password: string }) =>
      signUp(next === undefined ? body : { ...body, next }, turnstileToken),
    onError: (error) => {
      // `validation-failed` carries RFC 9457's `errors` extension, one entry per rejected field
      // with a pointer naming it. Rendering them beside their inputs is the whole reason the API
      // sends pointers rather than a sentence.
      setFieldErrors(error instanceof ApiProblem ? error.fieldErrors() : {});
    },
    onSuccess: async () => {
      // `202` for an address with an account and one without, identically (ADR 007). The next
      // screen says "check your inbox" and cannot say more, because the server did not.
      setFieldErrors({});
      await navigate(routes.verifyEmail, { state: { email } });
    },
  });

  const assessment = assessPassword(password);

  /**
   * The authoritative verdict, when the server has given one.
   *
   * Three slugs rather than one — `password-too-weak`, `password-breached` and
   * `password-uses-personal-information` — because they have three different remedies, and the
   * shared message table turns each into its own sentence.
   */
  const serverPasswordError = fieldErrors.password;

  /**
   * The client-side reading, which is a hint and never a verdict.
   *
   * The authoritative answer is the server's — zxcvbn with the account's own details as context,
   * plus a k-anonymity breach check. This meter exists so the field reacts as it is typed, not so
   * the form can pre-empt that answer.
   */
  const isLocallyWeak = assessment.isBreached || (password.length > 0 && assessment.score < 2);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    const parsed = signupRequestSchema.safeParse({ email, password });

    if (!parsed.success) {
      // Shaped from the same schema the API validates with, so a field this form rejects is a field
      // the server would have rejected — no round trip needed to learn it, and no rule invented
      // here that the server does not hold.
      setFieldErrors(
        Object.fromEntries(
          parsed.error.issues.map((issue) => [String(issue.path.at(-1) ?? ''), issue.message]),
        ),
      );
      register.reset();

      return;
    }

    setFieldErrors({});
    register.mutate(parsed.data);
  }

  function startOauth(provider: OauthProvider): void {
    window.location.assign(oauthStartUrl(provider));
  }

  return (
    <AuthLayout>
      <AuthHeading
        title="Create your account"
        description="Describe an app and watch it build. No local setup, nothing to install."
      />

      <div className="mt-7">
        <SocialAuthButtons onProviderSelect={startOauth} />
      </div>

      <OrDivider />

      {register.isError && Object.keys(fieldErrors).length === 0 ? (
        <Alert variant="danger" className="mb-5">
          <AlertTriangle />
          <AlertTitle>{messageFor(register.error, 'We could not create that account')}</AlertTitle>
          <AlertDescription>
            Nothing was created. Adjust what you entered and try again.
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
            aria-invalid={fieldErrors.email !== undefined}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
            message={
              fieldErrors.email === undefined ? null : (
                <p className="text-caption text-danger" role="alert">
                  {fieldErrors.email}
                </p>
              )
            }
          />

          <PasswordField
            name="new-password"
            autoComplete="new-password"
            placeholder={`At least ${String(MINIMUM_PASSWORD_LENGTH)} characters`}
            value={password}
            aria-invalid={isLocallyWeak || serverPasswordError !== undefined}
            onChange={(event) => {
              setPassword(event.target.value);
              // A verdict about the password they had is not a verdict about the one they are
              // typing. Without this the server's "too easy to guess" sits under a field whose
              // contents it never saw.
              setFieldErrors(({ password: _rejected, ...rest }) => rest);
            }}
            message={
              /*
               * The server's verdict *replaces* the local meter rather than sitting beside it.
               *
               * They disagree, and one of them is right: the meter is a character-class heuristic
               * in the browser, and the server runs zxcvbn with the account's own details as
               * context plus a k-anonymity breach check. Rendering "Strong — not found in any known
               * breach" directly above "That password is too easy to guess" is not two data points,
               * it is one contradiction — and the user cannot tell which half to act on.
               */
              serverPasswordError !== undefined ? (
                <Alert variant="danger" className="mt-[7px]">
                  <AlertTriangle />
                  <AlertTitle>{serverPasswordError}</AlertTitle>
                </Alert>
              ) : password.length > 0 ? (
                <>
                  <PasswordStrengthMeter score={assessment.score} message={assessment.message} />
                  {assessment.isBreached ? (
                    <Alert variant="danger" className="mt-[7px]">
                      <AlertTriangle />
                      <AlertTitle>This password has appeared in a data breach</AlertTitle>
                      <AlertDescription>
                        Checked without ever sending your password. Choose a different one.
                      </AlertDescription>
                    </Alert>
                  ) : null}
                </>
              ) : null
            }
          />
        </div>

        <div className="mt-6">
          <TurnstileCheck onToken={setTurnstileToken} />
        </div>

        <Button type="submit" className="mt-6 w-full" disabled={register.isPending}>
          {register.isPending ? (
            <>
              <Loader2 className="animate-spin" aria-hidden="true" />
              Creating account
            </>
          ) : (
            <>
              Create account
              <ArrowRight aria-hidden="true" />
            </>
          )}
        </Button>
      </form>

      <div className="mt-4">
        <FinePrint icon={ShieldCheck}>
          Protected by Cloudflare Turnstile · You agree to the Terms and Privacy Policy
        </FinePrint>
      </div>

      <p className="text-body-sm text-subdued mt-[22px]">
        Already have an account?{' '}
        <AuthLink to={routes.signIn} state={location.state as unknown}>
          Sign in
        </AuthLink>
      </p>
    </AuthLayout>
  );
}
