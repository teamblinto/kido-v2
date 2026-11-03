import { emailSchema } from '@repo/contracts';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Loader2, Lock, Mail } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { messageFor } from '@/lib/api/problem';
import { routes } from '@/lib/routes';
import { requestPasswordReset } from '../api';
import { AuthHeading } from '../components/auth-heading';
import { AuthLayout } from '../components/auth-layout';
import { BackToSignInLink } from '../components/auth-link';
import { FinePrint } from '../components/fine-print';
import { TextField } from '../components/text-field';
import { TurnstileCheck } from '../components/turnstile-check';

export function ForgotPasswordPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [malformed, setMalformed] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | undefined>(undefined);

  const request = useMutation({
    mutationFn: (body: { email: string }) => requestPasswordReset(body, turnstileToken),
    onSuccess: async () => {
      // `202` for a registered address and an unknown one alike. The next screen says so out loud,
      // which is the honest way to present a deliberately uninformative answer.
      await navigate(routes.resetLinkSent, { state: { email } });
    },
  });

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    const parsed = emailSchema.safeParse(email);

    if (!parsed.success) {
      setMalformed('Enter the email address you sign in with.');
      request.reset();

      return;
    }

    setMalformed(null);
    request.mutate({ email: parsed.data });
  }

  return (
    <AuthLayout>
      <AuthHeading
        badge={{ icon: Lock }}
        title="Reset your password"
        description="Enter the email you sign in with. We'll send a link that lets you set a new password."
      />

      {request.isError ? (
        <Alert variant="danger" className="mt-6">
          <AlertTriangle />
          <AlertTitle>{messageFor(request.error, 'We could not send that link')}</AlertTitle>
          <AlertDescription>Nothing has changed on your account. Try again.</AlertDescription>
        </Alert>
      ) : null}

      <form onSubmit={handleSubmit} className="mt-[26px]" noValidate>
        <TextField
          label="Work email"
          icon={Mail}
          type="email"
          name="email"
          autoComplete="email"
          placeholder="you@company.com"
          value={email}
          aria-invalid={malformed !== null}
          onChange={(event) => {
            setEmail(event.target.value);
          }}
          message={
            malformed === null ? null : (
              <p className="text-caption text-danger" role="alert">
                {malformed}
              </p>
            )
          }
        />

        <div className="mt-[22px]">
          <TurnstileCheck onToken={setTurnstileToken} />
        </div>

        <Button type="submit" className="mt-[22px] w-full" disabled={request.isPending}>
          {request.isPending ? (
            <>
              <Loader2 className="animate-spin" aria-hidden="true" />
              Sending link
            </>
          ) : (
            <>
              Send reset link
              <ArrowRight aria-hidden="true" />
            </>
          )}
        </Button>
      </form>

      <div className="mt-4">
        <FinePrint>The link expires in 30 minutes and can only be used once.</FinePrint>
      </div>

      <div className="mt-[22px]">
        <BackToSignInLink to={routes.signIn} />
      </div>
    </AuthLayout>
  );
}
