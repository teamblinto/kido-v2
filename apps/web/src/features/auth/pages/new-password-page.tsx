import { passwordSchema } from '@repo/contracts';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ApiProblem, messageFor } from '@/lib/api/problem';
import { routes } from '@/lib/routes';
import { resetPassword } from '../api';
import { AuthHeading } from '../components/auth-heading';
import { AuthLayout } from '../components/auth-layout';
import { AuthLink, BackToSignInLink } from '../components/auth-link';
import { PasswordField } from '../components/password-field';
import { PasswordStrengthMeter } from '../components/password-strength-meter';
import { useLinkToken } from '../hooks/use-link-token';
import { MINIMUM_PASSWORD_LENGTH, assessPassword } from '../lib/password';

/**
 * Where a password-reset mail lands: `/auth/password/reset?token=…`.
 *
 * The account is named by the token, not by this page — `resetPasswordRequestSchema` takes a
 * password and a token and nothing else, because *"the token names the account, and a body that also
 * carried one would be a field the endpoint accepts and ignores."* So there is no address to show,
 * and showing one would mean having asked for it.
 */
export function NewPasswordPage(): React.JSX.Element {
  const navigate = useNavigate();
  const token = useLinkToken();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const reset = useMutation({
    mutationFn: resetPassword,
    onSuccess: async () => {
      // Every session dies with the reset, including any this browser held (T19). So the only
      // honest destination is the sign-in screen — sending them to the dashboard would show a
      // signed-out page pretending otherwise.
      await navigate(routes.signIn, { replace: true, state: { passwordReset: true } });
    },
  });

  const assessment = assessPassword(password);
  const serverFieldError =
    reset.error instanceof ApiProblem ? reset.error.fieldErrors().password : undefined;

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    const parsed = passwordSchema.safeParse(password);

    if (!parsed.success) {
      setLocalError(`Choose a password of at least ${String(MINIMUM_PASSWORD_LENGTH)} characters.`);

      return;
    }

    if (password !== confirmation) {
      setLocalError('Both passwords need to match.');

      return;
    }

    if (token === null) {
      return;
    }

    setLocalError(null);
    reset.mutate({ password: parsed.data, token });
  }

  if (token === null) {
    return (
      <AuthLayout>
        <AuthHeading
          badge={{ icon: AlertTriangle, tone: 'danger' }}
          title="That reset link is incomplete"
          description="The address is missing its token. Some mail clients shorten long links — try copying the whole address, or request a new one."
        />
        <div className="mt-[22px]">
          <Button
            type="button"
            className="w-full"
            onClick={() => {
              void navigate(routes.forgotPassword);
            }}
          >
            Request a new link
          </Button>
        </div>
        <div className="mt-[22px]">
          <BackToSignInLink to={routes.signIn} />
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <AuthHeading
        title="Set a new password"
        description="Choose something you don't use anywhere else."
      />

      {/*
        The three token failures each have their own remedy, and the shared message table already
        distinguishes them: expired and already-used both mean "ask for another", invalid means
        "check what you copied".
      */}
      {reset.isError && serverFieldError === undefined ? (
        <Alert variant="danger" className="mt-6">
          <AlertTriangle />
          <AlertTitle>{messageFor(reset.error, 'That password could not be set')}</AlertTitle>
          <AlertDescription>
            Your password has not changed.{' '}
            <AuthLink to={routes.forgotPassword}>Request a new link</AuthLink> if this one has
            expired.
          </AlertDescription>
        </Alert>
      ) : null}

      <form onSubmit={handleSubmit} className="mt-[26px]" noValidate>
        <PasswordField
          label="New password"
          name="new-password"
          autoComplete="new-password"
          placeholder={`At least ${String(MINIMUM_PASSWORD_LENGTH)} characters`}
          value={password}
          aria-invalid={assessment.isBreached || serverFieldError !== undefined}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
          message={
            password.length > 0 || serverFieldError !== undefined ? (
              <>
                {password.length > 0 ? (
                  <PasswordStrengthMeter score={assessment.score} message={assessment.message} />
                ) : null}
                {serverFieldError === undefined ? null : (
                  <p className="text-caption text-danger mt-[7px]" role="alert">
                    {serverFieldError}
                  </p>
                )}
              </>
            ) : null
          }
        />

        <div className="mt-4">
          <PasswordField
            label="Confirm new password"
            name="confirm-password"
            autoComplete="new-password"
            placeholder="Re-enter the new password"
            value={confirmation}
            aria-invalid={localError !== null}
            onChange={(event) => {
              setConfirmation(event.target.value);
            }}
            message={
              localError === null ? null : (
                <p className="text-caption text-danger" role="alert">
                  {localError}
                </p>
              )
            }
          />
        </div>

        <Alert variant="warning" className="mt-[22px]">
          <AlertTriangle />
          <AlertTitle>This signs you out everywhere</AlertTitle>
          <AlertDescription>
            Every active session and device is revoked, including this one — you&apos;ll sign in
            again with the new password.
          </AlertDescription>
        </Alert>

        <Button type="submit" className="mt-[22px] w-full" disabled={reset.isPending}>
          {reset.isPending ? (
            <>
              <Loader2 className="animate-spin" aria-hidden="true" />
              Setting password
            </>
          ) : (
            <>
              Set password and continue
              <ArrowRight aria-hidden="true" />
            </>
          )}
        </Button>
      </form>
    </AuthLayout>
  );
}
