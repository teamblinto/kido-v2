import { emailSchema } from '@repo/contracts';
import { useMutation } from '@tanstack/react-query';
import { Lock, Mail } from 'lucide-react';
import { useState } from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { routes } from '@/lib/routes';
import { requestPasswordReset } from '../api';
import { AuthHeading } from '../components/auth-heading';
import { AuthLayout } from '../components/auth-layout';
import { BackToSignInLink } from '../components/auth-link';
import { ResendButton } from '../components/resend-button';
import { TurnstileCheck } from '../components/turnstile-check';
import { useAccountEmail } from '../hooks/use-account-email';

export function ResetLinkSentPage(): React.JSX.Element {
  const email = useAccountEmail('that address');
  const [turnstileToken, setTurnstileToken] = useState<string | undefined>(undefined);
  const resend = useMutation({
    mutationFn: (body: { email: string }) => requestPasswordReset(body, turnstileToken),
  });
  const address = emailSchema.safeParse(email);

  return (
    <AuthLayout>
      <AuthHeading
        badge={{ icon: Mail }}
        title="Check your inbox"
        description={`If an account exists for ${email}, a reset link is on its way. It expires in 30 minutes.`}
      />

      <Alert className="mt-6">
        <Lock />
        <AlertDescription>
          We show this message whether or not the address is registered — it stops anyone probing
          for valid accounts.
        </AlertDescription>
      </Alert>

      {/*
        A widget of its own rather than a token carried from the previous screen. Turnstile tokens
        are single-use and short-lived, so the one that got the first mail sent is already spent —
        a resend reusing it would be refused with `turnstile-check-failed` every time, on the one
        deployment shape where the guard is actually doing something.
      */}
      <div className="mt-[22px]">
        <TurnstileCheck onToken={setTurnstileToken} />
      </div>

      <div className="mt-[22px]">
        <ResendButton
          idleLabel="Resend link"
          isPending={resend.isPending}
          pendingLabel={(time) => `Resend in ${time}`}
          onResend={
            address.success
              ? () => {
                  resend.mutate({ email: address.data });
                }
              : undefined
          }
        />
      </div>

      <div className="mt-[22px]">
        <BackToSignInLink to={routes.signIn} />
      </div>
    </AuthLayout>
  );
}
