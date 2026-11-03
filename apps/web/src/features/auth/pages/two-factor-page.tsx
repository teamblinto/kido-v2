import { MFA_CODE_MAX_LENGTH } from '@repo/contracts';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, Loader2, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiProblem, messageFor } from '@/lib/api/problem';
import { routes } from '@/lib/routes';
import { completeMfaChallenge } from '../api';
import { AuthHeading } from '../components/auth-heading';
import { AuthLayout } from '../components/auth-layout';
import { BackToSignInLink } from '../components/auth-link';
import { destinationAfterSignIn } from '../session/route-guards';
import { useSession } from '../session/session-context';

const codeLength = 6;

/**
 * The second leg of a sign-in that answered `mfa_required`.
 *
 * The account is deliberately not named anywhere on this page. The password leg answered with the
 * marker and nothing else — no account, no challenge id — because naming the user before the second
 * factor is presented would tell anyone who guessed a password right that the address exists and has
 * MFA. The challenge is bound to the short-lived cookie that response set, so the code is the only
 * thing this page has to send.
 */
export function TwoFactorPage(): React.JSX.Element {
  const navigate = useNavigate();
  const state: unknown = useLocation().state;
  const { setUser } = useSession();
  const [code, setCode] = useState('');
  const [usingRecoveryCode, setUsingRecoveryCode] = useState(false);

  const challenge = useMutation({
    mutationFn: completeMfaChallenge,
    onSuccess: async (signedIn) => {
      setUser(signedIn.user);
      // Ungated, so no `RequireAnon` redirect races this one; the return path came from sign-in.
      await navigate(
        signedIn.user.emailVerified ? destinationAfterSignIn(state) : routes.unverifiedEmail,
        { replace: true },
      );
    },
  });

  /**
   * The session is gone, not the code wrong.
   *
   * `SessionGuard` refuses a pending-MFA session exactly as it refuses a dead one, so `unauthorized`
   * here means the login leg's short-lived cookie expired — the remedy is to sign in again, and
   * telling somebody their code was wrong would have them retyping it until it did expire.
   */
  const expired = ApiProblem.is(challenge.error, 'unauthorized');

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    const trimmed = code.trim();

    if (trimmed.length > 0 && trimmed.length <= MFA_CODE_MAX_LENGTH) {
      challenge.mutate({ code: trimmed });
    }
  }

  return (
    <AuthLayout>
      <AuthHeading
        badge={{ icon: ShieldCheck }}
        title="Two-factor authentication"
        description={
          usingRecoveryCode
            ? 'Enter one of the recovery codes you saved when you set up two-factor authentication. Each one works once.'
            : `Enter the ${String(codeLength)}-digit code from your authenticator app to finish signing in.`
        }
      />

      {challenge.isError ? (
        <Alert variant="danger" className="mt-6">
          <AlertTriangle />
          <AlertTitle>
            {expired
              ? 'That sign-in timed out'
              : messageFor(challenge.error, 'That code was not accepted')}
          </AlertTitle>
          <AlertDescription>
            {expired
              ? 'Start again from the sign-in screen.'
              : 'Codes change every 30 seconds — check your app for the current one.'}
          </AlertDescription>
        </Alert>
      ) : null}

      <form onSubmit={handleSubmit} className="mt-[26px]">
        {usingRecoveryCode ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor="recovery-code">Recovery code</Label>
            <Input
              id="recovery-code"
              name="recovery-code"
              autoComplete="one-time-code"
              autoFocus
              maxLength={MFA_CODE_MAX_LENGTH}
              placeholder="One of your saved codes"
              value={code}
              aria-invalid={challenge.isError}
              onChange={(event) => {
                setCode(event.target.value);
              }}
            />
          </div>
        ) : (
          <InputOTP
            maxLength={codeLength}
            value={code}
            onChange={setCode}
            autoFocus
            aria-label="Two-factor authentication code"
            containerClassName="w-full"
          >
            <InputOTPGroup>
              {Array.from({ length: codeLength }, (_, index) => (
                <InputOTPSlot key={index} index={index} />
              ))}
            </InputOTPGroup>
          </InputOTP>
        )}

        <Button
          type="submit"
          className="mt-[22px] w-full"
          disabled={
            challenge.isPending ||
            (usingRecoveryCode ? code.trim().length === 0 : code.length !== codeLength)
          }
        >
          {challenge.isPending ? (
            <>
              <Loader2 className="animate-spin" aria-hidden="true" />
              Verifying
            </>
          ) : (
            'Verify and sign in'
          )}
        </Button>
      </form>

      <p className="text-body-sm text-subdued mt-4">
        {usingRecoveryCode ? 'Have your authenticator app? ' : 'Lost your device? '}
        <button
          type="button"
          className="text-brand font-medium underline-offset-4 hover:underline"
          onClick={() => {
            // The same endpoint takes both — `mfaCodeSchema` accepts a TOTP code and a recovery
            // code alike, and the server decides which it was. Only the input shape differs.
            setUsingRecoveryCode((current) => !current);
            setCode('');
            challenge.reset();
          }}
        >
          {usingRecoveryCode ? 'Enter a 6-digit code' : 'Use a recovery code'}
        </button>
      </p>

      <div className="mt-5">
        <BackToSignInLink to={routes.signIn} />
      </div>
    </AuthLayout>
  );
}
